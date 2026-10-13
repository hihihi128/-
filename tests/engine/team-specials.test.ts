import { describe, expect, it } from 'vitest';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { createRaceSession } from '../../src/engine/race';
import { Rng } from '../../src/engine/rng';
import { afterSpecialRace } from '../../src/engine/teamSpecials';
import { migrateState } from '../../src/engine/migrate';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { act, advanceUntil, cardSources, tryAct } from '../helpers';

function teamGame(teamId: 'mclaren' | 'mercedes' | 'red_bull', seed = 123): GameState {
  const loaded = normalizeDatabase(cardSources());
  if (!loaded.db) throw new Error('card database failed to load');
  return createGame(loaded.db, { playerTeamId: teamId, principalName: '测试领队', seed, gameId: `special-${teamId}`, now: 1 });
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

  it('迈凯伦两条适配路线按周完成，合作路线强化梅赛德斯', () => {
    let own = teamGame('mclaren');
    own.rules.mclaren.independentWeeks = 1;
    own = act(own, { type: 'START_MCLAREN_FIX', route: 'independent' });
    own = advanceUntil(own, state => state.season.phase === 'pre_race');
    expect(own.mclaren?.softwareResolved).toBe(true);

    let joint = teamGame('mclaren');
    joint.rules.mclaren.cooperationWeeks = 1;
    const before = joint.teams.mercedes.staff.technicalDirector.skill;
    joint = act(joint, { type: 'START_MCLAREN_FIX', route: 'mercedes' });
    joint = advanceUntil(joint, state => state.season.phase === 'pre_race');
    expect(joint.mclaren).toMatchObject({ softwareResolved: true, mercedesBuffApplied: true });
    expect(joint.teams.mercedes.staff.technicalDirector.skill).toBe(before + joint.rules.mclaren.mercedesDevelopmentBuff);
  });

  it('迈凯伦和梅赛德斯的正赛故障按每场一次抽取', () => {
    for (const teamId of ['mclaren', 'mercedes'] as const) {
      let state = advanceUntil(teamGame(teamId), value => value.season.phase === 'race');
      if (teamId === 'mclaren') state.rules.mclaren.failureChance = 1;
      else state.rules.mercedes.failureChance = 1;
      const session = createRaceSession(state, new Rng(7), 'race');
      expect(session.specialIncidents).toHaveLength(1);
      expect(session.specialIncidents?.[0].type).toBe(teamId === 'mclaren' ? 'mclaren_pu' : 'mercedes_pu');
    }
  });

  it('梅赛德斯政治行动推进 ADUO，并限制每站一次', () => {
    let state = teamGame('mercedes');
    state.rules.mercedes.aduoProgressPerLobby = 100;
    state = act(state, { type: 'MERCEDES_POLITICS', strategy: 'lobby_aduo' });
    expect(state.mercedes).toMatchObject({ aduoApproved: true, aduoProgress: 100 });
    expect(tryAct(state, { type: 'MERCEDES_POLITICS', strategy: 'defend' }).ok).toBe(false);
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
    state.standings.drivers.verstappen.points = 0;
    for (const [id, standing] of Object.entries(state.standings.drivers).slice(0, 4)) if (id !== 'verstappen') standing.points = 100;
    state.season.roundIndex = Math.ceil(state.calendar.length / 2) - 1;
    afterSpecialRace(state);
    expect(state.redBull).toMatchObject({ summerChecked: true, verstappenExit: true });
    expect(state.drivers.verstappen.teamId).toBe('mercedes');
    expect(state.teams.mercedes.cars.some(car => car.driverId === 'verstappen')).toBe(true);
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
    expect(displacedId && state.market!.freeStaff[displacedId]).toBeTruthy();
  });

  it('旧存档补齐新的特殊状态与实时比赛字段', () => {
    const state = teamGame('mclaren') as GameState & { mclaren: NonNullable<GameState['mclaren']> };
    state.mclaren.weeksTotal = undefined as never;
    state.mclaren.weeksLeft = 3;
    migrateState(state);
    expect(state.mclaren.weeksTotal).toBe(3);
  });
});
