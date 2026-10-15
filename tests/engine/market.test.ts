import { describe, expect, it } from 'vitest';
import { dispatch } from '../../src/engine/actions';
import { closeMarket, openMarket, previewContractOffer } from '../../src/engine/market';
import { resolveAiMarket } from '../../src/engine/market-ai';
import { migrateState } from '../../src/engine/migrate';
import { buildView } from '../../src/engine/view';
import { DEFAULT_RULES } from '../../src/engine/defaults';
import { newTestGame } from '../helpers';

function nextWindow() {
  const state = newTestGame();
  state.market!.window!.status = 'closed';
  const window = openMarket(state, state.season.year + 1);
  return { state, window };
}

describe('确定性合同市场', () => {
  it('报价是纯函数，薪资提高不会降低接受分', () => {
    const state = newTestGame();
    const window = openMarket(state, state.season.year + 1);
    const driver = state.teams.team_c.cars[0].driverId!;
    const terms = { windowId: window.id, marketRevision: state.market!.revision, personId: driver, annualSalary: 10, years: 2, role: 'race' as const, slot: 1 };
    const before = JSON.stringify(state);
    const low = previewContractOffer(state, 'team_c', terms, 'driver');
    const high = previewContractOffer(state, 'team_c', { ...terms, annualSalary: 20 }, 'driver');
    expect(JSON.stringify(state)).toBe(before);
    expect(high.score).toBeGreaterThanOrEqual(low.score);
    expect(low.windowId).toBe(window.id);
  });

  it('accepted offer locks a candidate and rejects stale submissions', () => {
    const state = newTestGame();
    const window = openMarket(state, state.season.year + 1);
    const driver = state.teams.team_c.cars[0].driverId!;
    const action = { type: 'OFFER_DRIVER_CONTRACT' as const, windowId: window.id, marketRevision: state.market!.revision, driverId: driver, annualSalary: 50, years: 2, role: 'race' as const, slot: 1 };
    const accepted = dispatch(state, action);
    expect(accepted.ok).toBe(true);
    expect(accepted.state.market!.window!.agreements).toHaveLength(1);
    const stale = dispatch(accepted.state, action);
    expect(stale.ok).toBe(false);
    expect(stale.state).toBe(accepted.state);
  });

  it('allows a contracted rival driver buyout and derives replacement from the target seat', () => {
    const state = newTestGame();
    state.teams.team_c.funds = 1_000_000;
    const window = state.market!.window!;
    const rival = state.teams.team_a.cars[0].driverId!;
    const ownSeat = state.teams.team_c.cars[0].driverId!;
    const quote = previewContractOffer(state, 'team_c', {
      windowId: window.id, marketRevision: state.market!.revision, personId: rival, annualSalary: 100, years: 2, role: 'race', slot: 1, replacePersonId: 'not-authoritative',
    }, 'driver');
    expect(quote.blockers).not.toContain('候选人已在预计阵容中');
    expect(quote.buyout).toBeGreaterThan(0);
    expect(quote.replacedPersonId).toBe(ownSeat);
    const own = previewContractOffer(state, 'team_c', { windowId: window.id, marketRevision: state.market!.revision, personId: ownSeat, annualSalary: 100, years: 2, role: 'race', slot: 1 }, 'driver');
    expect(own.buyout).toBe(0);
  });

  it('keeps AI ownership local and stays unresolved while any roster is incomplete', () => {
    const { state } = nextWindow();
    state.teams.team_c.funds = 1_000_000;
    const result = resolveAiMarket(state);
    expect(result.ok).toBe(true);
    expect(state.market!.window!.aiResolved).toBe(false); // player roster is still empty
    for (const agreement of state.market!.window!.agreements) {
      expect(agreement.fromTeamId === null || agreement.fromTeamId === agreement.toTeamId).toBe(true);
    }
  });

  it('includes own staff renewals, installs agreed terms, and removes released agreements', () => {
    const state = newTestGame();
    state.teams.team_c.funds = 1_000_000;
    const window = state.market!.window!;
    const role = 'technicalDirector' as const;
    const staffId = state.teams.team_c.staff[role].id!;
    const view = buildView(state);
    expect(view.market.staff.some(s => s.id === staffId && s.name.length > 0)).toBe(true);
    const offered = dispatch(state, { type: 'OFFER_STAFF_CONTRACT', windowId: window.id, marketRevision: state.market!.revision, candidateId: staffId, role, annualSalary: 100, years: 2 });
    expect(offered.ok).toBe(true);
    const released = dispatch(offered.state, { type: 'RELEASE_PERSON', windowId: window.id, marketRevision: offered.state.market!.revision, personKind: 'staff', personId: staffId });
    expect(released.ok).toBe(true);
    expect(released.state.market!.window!.agreements.some(a => a.personId === staffId)).toBe(false);

    // A new renewal is applied to the installed inline staff object at close.
    const fresh = newTestGame();
    fresh.teams.team_c.funds = 1_000_000;
    const freshWindow = fresh.market!.window!;
    const freeStaffId = 'fictional-technicalDirector-1';
    const renewal = dispatch(fresh, { type: 'OFFER_STAFF_CONTRACT', windowId: freshWindow.id, marketRevision: fresh.market!.revision, candidateId: freeStaffId, role, annualSalary: 100, years: 2 });
    expect(renewal.ok).toBe(true);
    renewal.state.market!.window!.aiResolved = true;
    expect(closeMarket(renewal.state).ok).toBe(true);
    expect(renewal.state.teams.team_c.staff[role].salary).toBe(100);
    expect(renewal.state.teams.team_c.staff[role].contractEnd).toBe(fresh.season.year + 1);
    expect(renewal.state.market!.freeStaff[freeStaffId]).toBeUndefined();
  });

  it('applies one bounded staff-morale penalty with news and narration when a replacement activates', () => {
    const state = newTestGame();
    state.teams.team_c.funds = 1_000_000;
    const window = state.market!.window!;
    const before = state.teams.team_c.staffMorale;
    const offered = dispatch(state, {
      type: 'OFFER_STAFF_CONTRACT', windowId: window.id, marketRevision: state.market!.revision,
      candidateId: 'fictional-technicalDirector-1', role: 'technicalDirector', annualSalary: 100, years: 2,
    });
    expect(offered.ok).toBe(true);
    offered.state.market!.window!.aiResolved = true;
    expect(closeMarket(offered.state).ok).toBe(true);
    expect(offered.state.teams.team_c.staffMorale).toBe(before - 2);
    expect(offered.state.news.some(n => n.tag === '人员变动' && n.text.includes('员工士气下降 2 点'))).toBe(true);
    expect(offered.state.narration.some(n => n.kind === 'market_personnel_morale' && n.detail.includes('员工士气下降 2 点'))).toBe(true);

    // A closed market is idempotent: the activation penalty and its news fire once.
    expect(closeMarket(offered.state).ok).toBe(true);
    expect(offered.state.teams.team_c.staffMorale).toBe(before - 2);
    expect(offered.state.news.filter(n => n.tag === '人员变动' && n.text.includes('员工士气下降 2 点'))).toHaveLength(1);
  });

  it('reduces morale for both teams when a projected transfer changes personnel', () => {
    const state = newTestGame();
    const window = state.market!.window!;
    const aDriver = state.teams.team_a.cars[0].driverId!;
    const cDriver = state.teams.team_c.cars[0].driverId!;
    window.projectedRosters.team_a.raceSeats['1'] = cDriver;
    window.projectedRosters.team_c.raceSeats['1'] = aDriver;
    window.aiResolved = true;
    expect(closeMarket(state).ok).toBe(true);
    expect(state.teams.team_a.staffMorale).toBe(63);
    expect(state.teams.team_c.staffMorale).toBe(63);
  });

  it('migrates market rules on modern saves and does not mutate views', () => {
    const state = newTestGame();
    delete (state.rules as Partial<typeof state.rules>).market;
    migrateState(state);
    expect(state.rules.market).toEqual(DEFAULT_RULES.market);
    const before = JSON.stringify(state);
    buildView(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('reserves salary against the target cap rather than current spent cap', () => {
    const state = newTestGame();
    state.rules.costCapIncludesSalaries = true;
    state.teams.team_c.costCapSpent = state.rules.costCap;
    const window = state.market!.window!;
    const driver = state.teams.team_c.cars[0].driverId!;
    const quote = previewContractOffer(state, 'team_c', { windowId: window.id, marketRevision: state.market!.revision, personId: driver, annualSalary: 1, years: 1, role: 'race', slot: 1 }, 'driver');
    expect(quote.blockers).not.toContain('预计工资和人员费用会超出预算帽');
    expect(quote.projectedCapRemaining).toBeGreaterThan(0);
  });

  it('allows either race engineer to be hired into either car slot', () => {
    const state = newTestGame();
    const window = state.market!.window!;
    const candidate = state.market!.freeStaff[Object.keys(state.market!.freeStaff).find(id => state.market!.freeStaff[id].role === 'raceEngineer')!];
    const quote = previewContractOffer(state, 'team_c', {
      windowId: window.id, marketRevision: state.market!.revision, personId: candidate.id!, annualSalary: 20, years: 2,
    }, 'staff', 'raceEngineer2');
    expect(quote.blockers).not.toContain('员工岗位不匹配');
    expect(quote.replacedPersonId).toBe(window.projectedRosters.team_c.staff.raceEngineer2);
  });

  it('creates a fresh market for each simulated offseason', () => {
    const { state, window } = nextWindow();
    state.season.phase = 'season_end';
    const next = dispatch(state, { type: 'START_NEXT_SEASON' });
    expect(next.ok).toBe(true);
    const advanced = next.state;
    expect(advanced.market!.window!.status).toBe('closed');
    advanced.season.phase = 'season_end';
    const again = openMarket(advanced, advanced.season.year + 1);
    expect(again.id).not.toBe(window.id);
    expect(again.targetYear).toBe(advanced.season.year + 1);
    expect(advanced.news.some(n => n.text.includes('续约系统尚未实现'))).toBe(false);
  });

  it('resets first-season PU usage after the initial market and hides closed windows', () => {
    const state = newTestGame();
    const driver = state.drivers[state.teams.team_c.cars[0].driverId!];
    driver.puUsed = { front_wing: 99 };
    const started = dispatch(state, { type: 'START_SEASON' });
    expect(started.ok).toBe(true);
    expect(started.state.drivers[driver.id].puUsed?.front_wing).not.toBe(99);
    const view = buildView(started.state);
    expect(view.market.status).toBe('closed');
    expect(view.market.window).toBeNull();
  });

  it('exposes public projected roster and all six staff roles without rival finance', () => {
    const state = newTestGame();
    const view = buildView(state);
    expect(view.market.window?.targetYear).toBe(state.season.year);
    expect(Object.keys(view.market.current!.staff)).toHaveLength(6);
    expect(JSON.stringify(view.market)).not.toContain('costCapSpent');
    expect(JSON.stringify(view.market)).not.toContain('funds');
  });
});
