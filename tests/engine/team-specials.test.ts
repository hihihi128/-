import { describe, expect, it } from 'vitest';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { advanceRaceSession, createRaceSession } from '../../src/engine/race';
import { Rng } from '../../src/engine/rng';
import { afterSpecialRace, redBullCrashMultiplier } from '../../src/engine/teamSpecials';
import { migrateState } from '../../src/engine/migrate';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { act, advanceUntil, cardSources, tryAct } from '../helpers';

function teamGame(teamId: 'mclaren' | 'mercedes' | 'red_bull', seed = 123): GameState {
  const loaded = normalizeDatabase(cardSources());
  if (!loaded.db) throw new Error('card database failed to load');
  return createGame(loaded.db, { playerTeamId: teamId, principalName: '测试领队', seed, gameId: `special-${teamId}`, now: 1 });
}

function atRace(teamId: 'mclaren' | 'mercedes' | 'red_bull', seed = 123): GameState {
  return advanceUntil(teamGame(teamId, seed), state => state.season.phase === 'race');
}

describe('三支车队特殊机制', () => {
  it('按车队初始化背景状态和公开视图', () => {
    const mc = teamGame('mclaren');
    const mb = teamGame('mercedes');
    const rb = teamGame('red_bull');
    expect(mc.mclaren).toMatchObject({ softwareResolved: false, route: null });
    expect(mb.mercedes).toMatchObject({ aduoApproved: false, compressionRatio: '1:18', dismissed: null });
    expect(rb.redBull).toMatchObject({ summerChecked: false, verstappenExit: false });
    expect(buildView(mc).mclaren).not.toBeNull();
    expect(buildView(mb).mercedes).not.toBeNull();
    expect(buildView(rb).redBull?.verstappenPosition).toBeGreaterThan(0);
  });

  it('公开视图使用可配置的特殊机制规则', () => {
    const state = teamGame('mercedes');
    state.rules.mercedes.failureChance = 0.37;
    state.rules.mercedes.dismissTotoSatisfaction = 44;
    state.rules.mercedes.banPoliticalPressure = 88;
    expect(buildView(state).specialRules.mercedes).toMatchObject({ failureChance: 0.37, dismissTotoSatisfaction: 44, banPoliticalPressure: 88 });
  });

  it('迈凯伦两条适配路线按周完成，合作路线强化梅赛德斯', () => {
    let own = teamGame('mclaren');
    own.rules.mclaren.independentWeeks = 1;
    own = act(own, { type: 'START_MCLAREN_FIX', route: 'independent' });
    own = advanceUntil(own, state => !!state.mclaren?.softwareResolved);
    expect(own.mclaren?.softwareResolved).toBe(true);

    let joint = teamGame('mclaren');
    joint.rules.mclaren.cooperationWeeks = 1;
    const before = joint.teams.mercedes.staff.technicalDirector.skill;
    joint = act(joint, { type: 'START_MCLAREN_FIX', route: 'mercedes' });
    joint = advanceUntil(joint, state => !!state.mclaren?.softwareResolved);
    expect(joint.mclaren).toMatchObject({ softwareResolved: true, mercedesBuffApplied: true });
    expect(joint.teams.mercedes.staff.technicalDirector.skill).toBe(before + joint.rules.mclaren.mercedesDevelopmentBuff);
  });

  it('迈凯伦和梅赛德斯的正赛故障按每场一次抽取', () => {
    for (const teamId of ['mclaren', 'mercedes'] as const) {
      let state = atRace(teamId);
      if (teamId === 'mclaren') state.rules.mclaren.failureChance = 1;
      else state.rules.mercedes.failureChance = 1;
      const session = createRaceSession(state, new Rng(7), 'race');
      expect(session.specialIncidents).toHaveLength(1);
      expect(session.specialIncidents?.[0].type).toBe(teamId === 'mclaren' ? 'mclaren_pu' : 'mercedes_pu');
    }
  });

  it('诺里斯队友缠斗判定每场只执行一次，并保持同种子确定性', () => {
    const prepare = () => {
      const state = atRace('mclaren', 77);
      state.rules.mclaren.failureChance = 0;
      const session = createRaceSession(state, new Rng(77), 'race');
      session.stage = 'ready';
      session.pendingDecision = null;
      for (const car of Object.values(session.cars)) {
        if (car.teamId !== 'mclaren') car.status = 'dnf';
        car.reliability = 100;
        car.consistency = 100;
      }
      session.cars.norris.cumulativeTime = 0;
      session.cars.piastri.cumulativeTime = 0.01;
      return { state, session };
    };
    const a = prepare(), b = prepare();
    advanceRaceSession(a.state, a.session, 'next_lap');
    advanceRaceSession(b.state, b.session, 'next_lap');
    expect(a.session.norrisTeammateRollDone).toBe(true);
    expect(a.session).toEqual(b.session);
  });

  it('梅赛德斯政治行动推进 ADUO，并在每个日历周解锁一次', () => {
    let state = teamGame('mercedes');
    state.rules.mercedes.aduoProgressPerLobby = 100;
    state = act(state, { type: 'MERCEDES_POLITICS', strategy: 'lobby_aduo' });
    expect(state.mercedes).toMatchObject({ aduoApproved: true, aduoProgress: 100 });
    expect(tryAct(state, { type: 'MERCEDES_POLITICS', strategy: 'defend' }).ok).toBe(false);
    state = act(state, { type: 'ADVANCE' });
    expect(tryAct(state, { type: 'MERCEDES_POLITICS', strategy: 'defend' }).ok).toBe(false);
    state = act(state, { type: 'ADVANCE' });
    expect(tryAct(state, { type: 'MERCEDES_POLITICS', strategy: 'defend' }).ok).toBe(true);
    expect(tryAct(state, { type: 'MERCEDES_POLITICS', strategy: 'invalid' } as never).ok).toBe(false);
  });

  it('梅赛德斯在压力过高时失去 1:18，并在 Toto 满意度过低时撤职', () => {
    const state = teamGame('mercedes');
    state.mercedes!.politicalPressure = state.rules.mercedes.banPoliticalPressure;
    state.mercedes!.totoSatisfaction = 0;
    const before = state.teams.mercedes.parts.power_unit.specs[0].perf;
    afterSpecialRace(state);
    expect(state.mercedes).toMatchObject({ compressionRatio: '1:16' });
    expect(state.teams.mercedes.parts.power_unit.specs[0].perf).toBe(before - 2);
    expect(state.mercedes!.dismissed).toContain('Toto');
    expect(tryAct(state, { type: 'ADVANCE' }).ok).toBe(false);
  });

  it('红牛可投入资金争取 GP 留任，并在赛历中点检查维斯塔潘排名', () => {
    let state = teamGame('red_bull');
    const beforeFunds = state.teams.red_bull.funds;
    const beforeRetention = state.redBull!.gpRetention;
    state = act(state, { type: 'RED_BULL_RETAIN_GP' });
    expect(state.teams.red_bull.funds).toBe(beforeFunds - state.rules.redBull.gpNegotiationCost);
    expect(state.redBull!.gpRetention).toBeGreaterThan(beforeRetention);
    expect(redBullCrashMultiplier(state, 'red_bull')).toBe(state.rules.redBull.mistakeMultiplier);
    expect(redBullCrashMultiplier(state, 'mercedes')).toBe(1);
    state.standings.drivers.verstappen.points = 0;
    for (const [id, standing] of Object.entries(state.standings.drivers).slice(0, 4)) if (id !== 'verstappen') standing.points = 100;
    state.season.roundIndex = Math.ceil(state.calendar.length / 2) - 1;
    afterSpecialRace(state);
    expect(state.redBull).toMatchObject({ summerChecked: true, verstappenExit: true });
    expect(state.drivers.verstappen.teamId).toBe('mercedes');
    expect(state.drivers.verstappen.role).toBe('race');
    expect(state.teams.mercedes.cars.some(car => car.driverId === 'verstappen')).toBe(true);
    const mercedesCar = state.teams.mercedes.cars.find(car => car.driverId === 'verstappen')!;
    for (const partType of Object.keys(state.rules.puAllocation)) {
      expect(state.drivers.verstappen.puPool?.[partType]).toContain(mercedesCar.fitted[partType]);
    }
  });

  it('GP 离队时从红牛移动到迈凯伦，红牛提拔替代工程师', () => {
    const state = teamGame('red_bull');
    const gpId = state.teams.red_bull.staff.raceEngineer.id;
    const displacedId = state.teams.mclaren.staff.raceEngineer.id;
    state.redBull!.gpRetention = 0;
    afterSpecialRace(state);
    expect(state.redBull!.gpTransferred).toBe(true);
    expect(state.teams.mclaren.staff.raceEngineer.id).toBe(gpId);
    expect(state.teams.red_bull.staff.raceEngineer.id).not.toBe(gpId);
    expect(state.teams.red_bull.staff.raceEngineer2.id).toBe(displacedId);
    expect(state.teams.red_bull.staff.raceEngineer.id).not.toBe(state.teams.red_bull.staff.raceEngineer2.id);
  });

  it('旧存档补齐新的特殊状态与实时比赛字段', () => {
    const state = teamGame('mclaren') as GameState & { mclaren: NonNullable<GameState['mclaren']> };
    state.mclaren.weeksTotal = undefined as never;
    state.mclaren.weeksLeft = 3;
    state.weekend = {
      roundIndex: 0,
      weather: { practice: 'dry', qualifying: 'dry', race: 'dry', sprintQualifying: 'dry', sprint: 'dry' },
      forecast: { qualifying: 0, race: 0 }, setup: {}, plans: {}, teamOrders: { mode: 'free', favorDriverId: null }, penalties: {}, parcFerme: false,
      practiceSessions: [], practice: null, sprintQualifying: null, sprint: null, qualifying: null, race: null,
      liveRace: { version: 1, id: 'legacy', kind: 'race', roundIndex: 0, totalLaps: 1, completedLaps: 0, lap: 0, stage: 'grid', revision: 1, rngState: 1, weatherRngState: 1, forecastRngState: 1, strategistSkill: 50, expectedPositions: {}, cars: {}, order: [], weatherTrajectory: [0], weatherHistory: [], rain: 0, wetness: 0, surface: 'dry', forecast: { issuedLap: 0, horizonLaps: 1, rainProbability: 0, intensityRange: [0, 0], arrivalLaps: null, confidence: 1 }, scLeft: 0, vscLeft: 0, safetyCars: 0, redFlags: 0, redFlag: null, fastestLap: null, events: [], lapChart: {}, orderOutcomes: [], orderCooldown: {}, teamOrders: { mode: 'free', favorDriverId: null }, pendingDecision: null, damageLedger: [], specialIncidents: [] },
    };
    migrateState(state);
    expect(state.mclaren.weeksTotal).toBe(3);
    expect(state.weekend.liveRace?.norrisTeammateRollDone).toBe(false);
  });
});
