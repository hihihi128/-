import { describe, expect, it } from 'vitest';
import { dispatch } from '../../src/engine/actions';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { afterManagementRace, completeWilliamsHandover } from '../../src/engine/managementSpecials';
import { triggerWeekendRandomEvent } from '../../src/engine/randomEvents';
import { Rng } from '../../src/engine/rng';
import type { Action, GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { cardSources } from '../helpers';

type TeamId = 'alpine' | 'haas' | 'williams';

function game(teamId: TeamId, seed = 123): GameState {
  const loaded = normalizeDatabase(cardSources());
  if (!loaded.db) throw new Error('card database failed to load');
  return createGame(loaded.db, { playerTeamId: teamId, principalName: '测试领队', seed, gameId: `management-${teamId}`, now: 1 });
}

function run(state: GameState, action: Action) {
  return dispatch(state, action, { now: 1 });
}

describe('阿尔派、哈斯、威廉姆斯与随机事件', () => {
  it('按车队初始化特殊状态并公开到视图', () => {
    const alpine = game('alpine');
    expect(alpine.alpine).toMatchObject({ puIntegration: 20, integrationPenaltyActive: true, gaslyLeaving: false });
    expect(buildView(alpine).alpine?.rndDirection).toEqual(['chassis', 'sidepods']);

    const haas = game('haas');
    expect(haas.haas).toMatchObject({ geneSupport: 62, toyotaInfluence: 20, partnershipWithdrawn: false });
    expect(buildView(haas).haas?.fundingProvided).toBe(0);

    const williams = game('williams');
    expect(williams.williams).toMatchObject({ successionReadiness: 25, focus: null, confirmedSuccessor: false });
    expect(williams.narration.at(-1)?.title).toContain('交接年');
  });

  it('阿尔派只能遵守布里亚托研发方向，并在三种管理取舍中每站选择一次', () => {
    let state = game('alpine');
    expect(run(state, { type: 'START_PROJECT', partType: 'floor', ambition: 'standard' }).message).toContain('布里亚托');
    const beforeGasly = state.alpine!.gaslyCommitment;
    const result = run(state, { type: 'ALPINE_MANAGEMENT', strategy: 'back_colapinto' });
    expect(result.ok).toBe(true);
    state = result.state;
    expect(state.alpine!.fanPressure).toBeLessThan(42);
    expect(state.alpine!.gaslyCommitment).toBeLessThan(beforeGasly);
    expect(run(state, { type: 'ALPINE_MANAGEMENT', strategy: 'integrate_power_unit' }).ok).toBe(false);
  });

  it('哈斯接受丰田投入会增加资金和影响力，影响力过高后限制研发', () => {
    let state = game('haas');
    const funds = state.teams.haas.funds;
    const result = run(state, { type: 'HAAS_BALANCE', strategy: 'accept_toyota' });
    expect(result.ok).toBe(true);
    state = result.state;
    expect(state.teams.haas.funds).toBe(funds + 5);
    expect(state.haas!.toyotaInfluence).toBe(30);
    state.haas!.toyotaInfluence = state.rules.haas.interferenceThreshold;
    expect(run(state, { type: 'START_PROJECT', partType: 'chassis', ambition: 'standard' }).message).toContain('丰田');
  });

  it('威廉姆斯每站先选预算方向，并记录设施或赛车升级投入', () => {
    let state = game('williams');
    expect(run(state, { type: 'START_PROJECT', partType: 'floor', ambition: 'standard' }).message).toContain('预算方向');
    state = run(state, { type: 'WILLIAMS_BUDGET_FOCUS', focus: 'development' }).state;
    const result = run(state, { type: 'START_PROJECT', partType: 'floor', ambition: 'standard' });
    expect(result.ok).toBe(true);
    expect(result.state.williams!.developmentInvestment).toBeGreaterThan(0);
    expect(run(result.state, { type: 'UPGRADE_FACILITY', facility: 'windTunnel' }).ok).toBe(false);
  });

  it('2026 年底沃尔斯返回梅赛德斯，并按准备度确认或延长接班考核', () => {
    const ready = game('williams');
    ready.williams!.successionReadiness = ready.rules.williams.successionThreshold;
    completeWilliamsHandover(ready);
    expect(ready.williams).toMatchObject({ vowlesDeparted: true, confirmedSuccessor: true });

    const delayed = game('williams');
    completeWilliamsHandover(delayed);
    expect(delayed.williams).toMatchObject({ vowlesDeparted: true, confirmedSuccessor: false });
    expect(delayed.flags.fired).not.toBe(true);
    expect(delayed.narration.at(-1)?.title).toContain('延长');
  });

  it('每个比赛周只触发一次随机事件，包括无事发生和负面事件', () => {
    const state = game('haas');
    state.rules.randomEvents = { noneWeight: 0, driverInjuryWeight: 1, windTunnelWeight: 0, partIssueWeight: 0 };
    const before = state.teams.haas.cars.map(car => state.drivers[car.driverId!].fitness);
    triggerWeekendRandomEvent(state, new Rng(9));
    expect(state.randomEvents?.current?.kind).toBe('driver_injury');
    expect(state.randomEvents?.history).toHaveLength(1);
    expect(state.teams.haas.cars.map(car => state.drivers[car.driverId!].fitness)).not.toEqual(before);
    triggerWeekendRandomEvent(state, new Rng(10));
    expect(state.randomEvents?.history).toHaveLength(1);

    state.season.roundIndex += 1;
    state.rules.randomEvents = { noneWeight: 1, driverInjuryWeight: 0, windTunnelWeight: 0, partIssueWeight: 0 };
    triggerWeekendRandomEvent(state, new Rng(11));
    expect(state.randomEvents?.current?.kind).toBe('none');
    expect(state.randomEvents?.history).toHaveLength(2);
  });

  it('未处理车队事务会在赛后产生持续后果', () => {
    const state = game('haas');
    const influence = state.haas!.toyotaInfluence;
    afterManagementRace(state);
    expect(state.haas!.toyotaInfluence).toBe(influence + state.rules.haas.influencePerRace);
    expect(state.haas!.geneSupport).toBeLessThan(62);
  });
});
