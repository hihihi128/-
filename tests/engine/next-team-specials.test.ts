import { describe, expect, it } from 'vitest';
import { dispatch } from '../../src/engine/actions';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { migrateState } from '../../src/engine/migrate';
import { afterNextTeamRace, applyAudiStartDrop, astonCrisis, astonOnPriority, audiAlliance, fiaDebate, maybeTriggerRacingBullsRecall, selectRacingBullsReserve } from '../../src/engine/nextTeamSpecials';
import { advanceRaceSession, createRaceSession } from '../../src/engine/race';
import { Rng } from '../../src/engine/rng';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { advanceUntil, cardSources } from '../helpers';

type TeamId = 'aston_martin' | 'racing_bulls' | 'audi' | 'cadillac';

function game(teamId: TeamId, seed = 123): GameState {
  const loaded = normalizeDatabase(cardSources());
  if (!loaded.db) throw new Error('card database failed to load');
  return createGame(loaded.db, { playerTeamId: teamId, principalName: '测试领队', seed, gameId: `next-${teamId}`, now: 1 });
}

function atRace(teamId: TeamId): GameState {
  return advanceUntil(game(teamId), state => state.season.phase === 'race');
}

describe('马丁、小红牛、奥迪、凯迪拉克与 FIA 座谈会', () => {
  it('按车队初始化状态，凯迪拉克保持无特殊机制', () => {
    expect(game('aston_martin').astonMartin).toMatchObject({ aduoEngineArrived: false, aduoProgress: 0 });
    expect(game('racing_bulls').racingBulls).toMatchObject({ pendingRecall: null, activeRecall: null });
    expect(game('audi').audi).toMatchObject({ turboFixed: false, alliance: null });
    const cadillac = game('cadillac');
    expect(cadillac.astonMartin).toBeNull();
    expect(cadillac.audi).toBeNull();
    expect(cadillac.narration.at(-1)?.title).toContain('凯迪拉克');
  });

  it('拒绝奥迪起步掉位下限大于上限的规则', () => {
    const sources = cardSources();
    const rules = sources.find(source => source.name.includes('规则'))!.data as { rules: { audi?: { startDropMin: number; startDropMax: number } } };
    rules.rules.audi = { startDropMin: 4, startDropMax: 2 };
    const loaded = normalizeDatabase(sources);
    expect(loaded.canStart).toBe(false);
    expect(loaded.issues.some(issue => issue.path === 'rules.audi.startDropMin')).toBe(true);
  });

  it('马丁危机行动推进 ADUO、调解冲突和纽维适配', () => {
    let state = game('aston_martin');
    state.rules.astonMartin.aduoPressureGain = 100;
    state.astonMartin!.hondaConflict = 0;
    expect(astonCrisis(state, 'pressure_honda').ok).toBe(true);
    expect(state.astonMartin).toMatchObject({ aduoEngineArrived: true, aduoProgress: 100 });

    state = game('aston_martin');
    const conflict = state.astonMartin!.hondaConflict;
    expect(astonCrisis(state, 'mediate').ok).toBe(true);
    expect(state.astonMartin!.hondaConflict).toBeLessThan(conflict);

    state = game('aston_martin');
    state.rules.astonMartin.neweyProgressGain = 100;
    expect(astonCrisis(state, 'push_newey').ok).toBe(true);
    expect(state.astonMartin).toMatchObject({ chassisUpgradeReady: true, neweyProgress: 100 });
  });

  it('马丁优先车手决定平衡老斯特罗尔与阿隆索粉丝', () => {
    const state = game('aston_martin');
    const before = { ...state.astonMartin! };
    astonOnPriority(state, 'stroll');
    expect(state.astonMartin!.strollFavor).toBeGreaterThan(before.strollFavor);
    expect(state.astonMartin!.alonsoFanAnger).toBeGreaterThan(before.alonsoFanAnger);
    astonOnPriority(state, 'alonso');
    expect(state.astonMartin!.alonsoFanAnger).toBeLessThan(before.alonsoFanAnger + 15);
  });

  it('首批 ADUO 到货前，马丁在风险圈触发保护性退赛', () => {
    const state = atRace('aston_martin');
    state.rules.astonMartin.vibrationInterval = 1;
    state.rules.astonMartin.vibrationRetireChance = 1;
    const session = createRaceSession(state, new Rng(8), 'race');
    session.stage = 'ready'; session.pendingDecision = null;
    for (const car of Object.values(session.cars)) if (car.teamId !== 'aston_martin') car.status = 'dnf';
    advanceRaceSession(state, session, 'next_lap');
    const astonCars = Object.values(session.cars).filter(car => car.teamId === 'aston_martin');
    expect(astonCars.every(car => car.status === 'dnf')).toBe(true);
    expect(astonCars[0].reason).toContain('手部损伤');
  });

  it('小红牛调用事件强制选择储备车手并在赛后恢复', () => {
    const state = game('racing_bulls');
    state.rules.racingBulls.recallChance = 1;
    maybeTriggerRacingBullsRecall(state, new Rng(2));
    expect(state.racingBulls!.pendingRecall).not.toBeNull();
    expect(dispatch(state, { type: 'ADVANCE' }).ok).toBe(false);
    const pending = state.racingBulls!.pendingRecall!;
    const reserve = pending.candidateIds[0];
    const originalPuUsed = structuredClone(state.drivers[reserve].puUsed);
    const originalPuPool = structuredClone(state.drivers[reserve].puPool);
    expect(selectRacingBullsReserve(state, reserve).ok).toBe(true);
    expect(state.teams.racing_bulls.cars.some(car => car.driverId === reserve)).toBe(true);
    afterNextTeamRace(state);
    expect(state.teams.racing_bulls.cars.some(car => car.driverId === pending.driverId)).toBe(true);
    expect(state.drivers[reserve].role).toBe('reserve');
    expect(state.drivers[reserve].puUsed).toEqual(originalPuUsed);
    expect(state.drivers[reserve].puPool).toEqual(originalPuPool);
  });

  it('奥迪涡轮让起步随机掉位，联盟持续推进 ADUO', () => {
    const state = atRace('audi');
    state.rules.audi.startDropMin = 0; state.rules.audi.startDropMax = 0;
    const session = createRaceSession(state, new Rng(5), 'race');
    const original = [...session.order];
    state.rules.audi.startDropMin = 3; state.rules.audi.startDropMax = 3;
    session.order = [...original];
    applyAudiStartDrop(state, session, new Rng(1));
    for (const id of Object.values(session.cars).filter(car => car.teamId === 'audi').map(car => car.driverId)) {
      expect(session.order.indexOf(id)).toBeGreaterThanOrEqual(original.indexOf(id));
    }
    expect(audiAlliance(state, 'mercedes').ok).toBe(true);
    state.rules.audi.progressPerRace = 100;
    afterNextTeamRace(state);
    expect(state.audi).toMatchObject({ turboFixed: true, alliance: 'mercedes' });
  });

  it('每三站打开 FIA 座谈会，辩论完成前阻止其它操作', () => {
    const state = game('aston_martin');
    state.season.roundIndex = 2;
    state.teams.aston_martin.boardConfidence = 100;
    state.teams.aston_martin.mediaReputation = 100;
    state.fiaMeeting!.politicalCapital = 100;
    afterNextTeamRace(state);
    expect(state.fiaMeeting!.current).not.toBeNull();
    expect(dispatch(state, { type: 'ADVANCE' }).ok).toBe(false);
    expect(fiaDebate(state, 'compromise').ok).toBe(true);
    expect(state.fiaMeeting!.current).toBeNull();
    expect(state.fiaMeeting!.completed).toBe(1);
    expect(buildView(state).fiaMeeting?.politicalCapital).toBeGreaterThan(0);
    state.season.number = 2;
    state.season.roundIndex = 2;
    afterNextTeamRace(state);
    expect(state.fiaMeeting!.current?.index).toBe(2);
  });

  it('旧存档补齐新车队状态和 FIA 座谈会状态', () => {
    const state = game('cadillac') as GameState & { fiaMeeting?: GameState['fiaMeeting'] };
    delete state.fiaMeeting;
    delete (state as Partial<GameState>).astonMartin;
    delete (state as Partial<GameState>).racingBulls;
    delete (state as Partial<GameState>).audi;
    delete (state.rules as Partial<GameState['rules']>).astonMartin;
    delete (state.rules as Partial<GameState['rules']>).racingBulls;
    delete (state.rules as Partial<GameState['rules']>).audi;
    delete (state.rules as Partial<GameState['rules']>).fiaMeeting;
    migrateState(state);
    expect(state.astonMartin).toBeNull();
    expect(state.racingBulls).toBeNull();
    expect(state.audi).toBeNull();
    expect(state.fiaMeeting).toMatchObject({ completed: 0, current: null });
    expect(state.rules.fiaMeeting.interval).toBeGreaterThan(0);
    expect(state.rules.astonMartin.vibrationRetireChance).toBe(.25);

    let legacyRace = atRace('cadillac');
    delete (legacyRace.rules as Partial<GameState['rules']>).fiaMeeting;
    migrateState(legacyRace);
    legacyRace = advanceUntil(legacyRace, value => value.season.phase === 'post_race');
    expect(legacyRace.season.phase).toBe('post_race');
  });
});
