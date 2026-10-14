import { describe, expect, it } from 'vitest';
import { dispatch } from '../../src/engine/actions';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { migrateState } from '../../src/engine/migrate';
import { afterNextTeamRace, applyAudiStartDrop, applyFerrariStartGain, astonCrisis, astonOnPriority, audiAlliance, fiaDebate, maybeTriggerRacingBullsRecall, selectRacingBullsReserve } from '../../src/engine/nextTeamSpecials';
import { advanceRaceSession, createRaceSession } from '../../src/engine/race';
import { Rng } from '../../src/engine/rng';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { act, advanceUntil, cardSources } from '../helpers';

type TeamId = 'aston_martin' | 'racing_bulls' | 'audi' | 'cadillac' | 'ferrari' | 'alpine' | 'mclaren' | 'williams';

function game(teamId: TeamId, seed = 123): GameState {
  const loaded = normalizeDatabase(cardSources());
  if (!loaded.db) throw new Error('card database failed to load');
  return createGame(loaded.db, { playerTeamId: teamId, principalName: '测试领队', seed, gameId: `next-${teamId}`, now: 1 });
}

function atRace(teamId: TeamId): GameState {
  return advanceUntil(game(teamId), state => state.season.phase === 'race');
}

function audiDriverIds(session: ReturnType<typeof createRaceSession>): string[] {
  return Object.values(session.cars).filter(car => car.teamId === 'audi').map(car => car.driverId);
}

describe('马丁、小红牛、奥迪、凯迪拉克与 FIA 座谈会', () => {
  it('按车队初始化状态，凯迪拉克保持无特殊机制', () => {
    expect(game('aston_martin').astonMartin).toMatchObject({ aduoEngineArrived: false, aduoProgress: 0 });
    expect(game('racing_bulls').racingBulls).toMatchObject({ pendingRecall: null, activeRecall: null });
    expect(game('audi').audi).toMatchObject({ turboFixed: false, alliance: false });
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

  it('小红牛在周末中途换上储备车手时补发该车手的本周末轮胎', () => {
    let state = game('racing_bulls');
    state.rules.racingBulls.recallChance = 1;
    state = advanceUntil(state, value => value.season.phase === 'practice');
    const reserve = state.racingBulls!.pendingRecall!.candidateIds[0];
    expect(selectRacingBullsReserve(state, reserve).ok).toBe(true);
    const inventory = state.teams.racing_bulls.tyreInventory?.[reserve] ?? [];
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory.every(set => set.weekendKey === `${state.season.year}:r${state.season.roundIndex + 1}`)).toBe(true);
    state = act(state, { type: 'RUN_PRACTICE' });
    while (state.weekend!.practiceReturn) {
      const request = state.weekend!.practiceReturn;
      const returningDriver = request.driverIds[0];
      state = act(state, { type: 'RETURN_PRACTICE_TYRES', driverId: returningDriver, setIds: request.eligibleSetIds[returningDriver].slice(0, request.required) });
    }
    expect(state.weekend!.practiceSessions).toHaveLength(1);
  });

  it('非奥迪玩家时，两台 AI 奥迪仍会在正赛起步随机掉位', () => {
    const state = atRace('ferrari');
    expect(state.audi).toBeNull();
    state.rules.audi.startDropMin = 3; state.rules.audi.startDropMax = 3;
    const session = createRaceSession(state, new Rng(5), 'race');

    const audiIds = audiDriverIds(session);
    expect(audiIds).toHaveLength(2);
    expect(session.events.filter(event => event.id.includes('start-audi'))).toHaveLength(2);
    expect(audiIds.every(id => session.order.indexOf(id) >= session.cars[id].grid - 1)).toBe(true);
  });

  it('奥迪玩家修复涡轮前掉位，修复后免除起步掉位', () => {
    const state = atRace('audi');
    state.rules.audi.startDropMin = 3; state.rules.audi.startDropMax = 3;
    const broken = createRaceSession(state, new Rng(5), 'race');
    expect(broken.events.filter(event => event.id.includes('start-audi'))).toHaveLength(2);

    state.audi!.turboFixed = true;
    const fixed = createRaceSession(state, new Rng(5), 'race');
    const original = [...fixed.order];
    expect(fixed.order).toEqual(original);
    expect(fixed.events.filter(event => event.id.includes('start-audi'))).toHaveLength(0);

    expect(audiAlliance(state).ok).toBe(true);
    state.rules.audi.progressPerRace = 100;
    afterNextTeamRace(state);
    expect(state.audi).toMatchObject({ turboFixed: true, alliance: true });
  });

  it('奥迪在车尾时只记录实际掉位，不会记录负数', () => {
    const state = atRace('ferrari');
    state.rules.audi.startDropMin = 0; state.rules.audi.startDropMax = 0;
    const session = createRaceSession(state, new Rng(5), 'race');
    const audiIds = audiDriverIds(session);
    session.events = session.events.filter(event => !event.id.includes('start-audi'));
    session.order = [...session.order.filter(id => !audiIds.includes(id)), ...audiIds];
    state.rules.audi.startDropMin = 3; state.rules.audi.startDropMax = 3;
    applyAudiStartDrop(state, session, new Rng(1));

    const startEvents = session.events.filter(event => event.id.includes('start-audi'));
    expect(startEvents).toHaveLength(2);
    expect(startEvents.every(event => event.text.includes('丢掉 1 个位置'))).toBe(true);
    expect(session.order.slice(-2).sort()).toEqual([...audiIds].sort());
  });

  it('没有奥迪赛车时不消耗随机数', () => {
    const state = atRace('ferrari');
    const session = createRaceSession(state, new Rng(5), 'race');
    for (const id of audiDriverIds(session)) delete session.cars[id];
    session.order = session.order.filter(id => session.cars[id]);
    const events = [...session.events];
    const rng = new Rng(1);
    const rngState = rng.state;
    applyAudiStartDrop(state, session, rng);
    expect(rng.state).toBe(rngState);
    expect(session.events).toEqual(events);
  });

  it('奥迪起步掉位使用相同种子时保持确定性', () => {
    const first = atRace('ferrari');
    const second = atRace('ferrari');
    first.rules.audi.startDropMin = 0; first.rules.audi.startDropMax = 0;
    second.rules.audi.startDropMin = 0; second.rules.audi.startDropMax = 0;
    const firstSession = createRaceSession(first, new Rng(5), 'race');
    const secondSession = createRaceSession(second, new Rng(5), 'race');
    firstSession.events = firstSession.events.filter(event => !event.id.includes('start-audi'));
    secondSession.events = secondSession.events.filter(event => !event.id.includes('start-audi'));
    first.rules.audi.startDropMin = 2; first.rules.audi.startDropMax = 3;
    second.rules.audi.startDropMin = 2; second.rules.audi.startDropMax = 3;
    const firstRng = new Rng(91);
    const secondRng = new Rng(91);
    applyAudiStartDrop(first, firstSession, firstRng);
    applyAudiStartDrop(second, secondSession, secondRng);
    expect(firstSession.order).toEqual(secondSession.order);
    expect(firstSession.events.filter(event => event.id.includes('start-audi'))).toEqual(secondSession.events.filter(event => event.id.includes('start-audi')));
    expect(firstRng.state).toBe(secondRng.state);
  });

  it('法拉利小涡轮每场正赛起步提升 2–4 位，ADUO 装车后优势消失', () => {
    const state = atRace('ferrari');
    state.rules.ferrari.turboStartGainMin = 4;
    state.rules.ferrari.turboStartGainMax = 4;
    state.teams.ferrari.puHomologations = 1;
    const session = createRaceSession(state, new Rng(5), 'race');
    const original = [...session.order];
    state.teams.ferrari.puHomologations = 0;
    applyFerrariStartGain(state, session, new Rng(1));
    const ferraris = Object.values(session.cars).filter(car => car.teamId === 'ferrari');
    expect(ferraris.every(car => session.order.indexOf(car.driverId) <= original.indexOf(car.driverId))).toBe(true);
    expect(ferraris.some(car => session.order.indexOf(car.driverId) < original.indexOf(car.driverId))).toBe(true);
    expect(session.events.filter(event => event.id.includes('start-ferrari')).length).toBe(2);

    const upgradedOrder = [...session.order];
    state.teams.ferrari.puHomologations = 1;
    applyFerrariStartGain(state, session, new Rng(1));
    expect(session.order).toEqual(upgradedOrder);
  });

  it('每三站打开 FIA 座谈会，辩论完成前阻止其它操作', () => {
    const state = game('aston_martin');
    state.season.roundIndex = 2;
    state.teams.aston_martin.boardConfidence = 100;
    state.teams.aston_martin.mediaReputation = 100;
    state.fiaMeeting!.politicalCapital = 100;
    afterNextTeamRace(state);
    expect(state.fiaMeeting!.current).toMatchObject({ issue: 'ferrari_turbo', supporters: expect.arrayContaining(['mercedes', 'mclaren', 'alpine']) });
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

  it('首次座谈会允许奥迪反水，阿尔派玩家必须支持起压提案', () => {
    let audiDefection: GameState | null = null;
    for (let seed = 0; seed < 100 && !audiDefection; seed++) {
      const candidate = game('ferrari');
      candidate.meta.createdAt = seed;
      expect(audiAlliance(candidate).ok).toBe(true);
      candidate.season.roundIndex = 2;
      afterNextTeamRace(candidate);
      if (candidate.fiaMeeting!.current!.supporters!.includes('audi')) audiDefection = candidate;
    }
    expect(audiDefection?.ferrari?.aduoAlliance).toBe(true);
    expect(audiDefection?.fiaMeeting?.current?.supporters).toContain('audi');

    const alpine = game('alpine');
    alpine.season.roundIndex = 2;
    alpine.teams.alpine.boardConfidence = 100;
    alpine.teams.alpine.mediaReputation = 100;
    alpine.fiaMeeting!.politicalCapital = 100;
    afterNextTeamRace(alpine);
    expect(alpine.fiaMeeting!.current?.forcedStance).toBe('support');
    expect(fiaDebate(alpine, 'oppose')).toMatchObject({ ok: false });
    expect(fiaDebate(alpine, 'support')).toMatchObject({ ok: true });
    expect(alpine.fiaMeeting!.ferrariTurboSpoolSeconds).toBe(alpine.rules.ferrari.turboSpoolSeconds);
  });

  it('法拉利可加入四队联盟，并在 ADUO 座谈游说成功后只获得一次机会', () => {
    const state = game('ferrari');
    expect(audiAlliance(state).ok).toBe(true);
    expect(state.ferrari?.aduoAlliance).toBe(true);
    state.teams.ferrari.boardConfidence = 100;
    state.teams.ferrari.mediaReputation = 100;
    state.fiaMeeting!.politicalCapital = 100;
    state.fiaMeeting!.current = { index: 2, issue: 'aduo', opponents: ['red_bull'], supporters: [], forcedStance: null };
    expect(fiaDebate(state, 'support').ok).toBe(true);
    expect(state.teams.ferrari.aduoUpgrades).toBe(1);
    expect(state.ferrari?.aduoLobbyGranted).toBe(true);
    state.fiaMeeting!.current = { index: 5, issue: 'aduo', opponents: ['red_bull'], supporters: [], forcedStance: null };
    expect(fiaDebate(state, 'support').ok).toBe(true);
    expect(state.teams.ferrari.aduoUpgrades).toBe(1);
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
    delete (state.rules.ferrari as Partial<GameState['rules']['ferrari']>).turboStartGainMin;
    delete (state.rules.ferrari as Partial<GameState['rules']['ferrari']>).turboStartGainMax;
    delete (state.rules.ferrari as Partial<GameState['rules']['ferrari']>).turboSpoolSeconds;
    migrateState(state);
    expect(state.astonMartin).toBeNull();
    expect(state.racingBulls).toBeNull();
    expect(state.audi).toBeNull();
    expect(state.fiaMeeting).toMatchObject({ completed: 0, current: null, ferrariTurboSpoolSeconds: 0, ferrariAduoInstalled: false, ferrariTurboDebated: false });
    expect(state.rules.fiaMeeting.interval).toBeGreaterThan(0);
    expect(state.rules.astonMartin.vibrationRetireChance).toBe(.25);
    expect(state.rules.ferrari).toMatchObject({ turboStartGainMin: 2, turboStartGainMax: 4, turboSpoolSeconds: 5 });

    let legacyRace = atRace('cadillac');
    delete (legacyRace.rules as Partial<GameState['rules']>).fiaMeeting;
    migrateState(legacyRace);
    legacyRace = advanceUntil(legacyRace, value => value.season.phase === 'post_race');
    expect(legacyRace.season.phase).toBe('post_race');
  });

  it('旧存档错过首次座谈后会在下一次会议补办小涡轮议题', () => {
    const state = game('ferrari');
    state.fiaMeeting!.completed = 1;
    delete (state.fiaMeeting! as Partial<NonNullable<GameState['fiaMeeting']>>).ferrariTurboDebated;
    migrateState(state);
    state.season.roundIndex = 5;
    afterNextTeamRace(state);
    expect(state.fiaMeeting!.current?.issue).toBe('ferrari_turbo');
  });

  it('把旧奥迪单一盟友存档迁移为四队联盟', () => {
    const state = game('audi');
    (state.audi as unknown as { alliance: string }).alliance = 'mercedes';
    migrateState(state);
    expect(state.audi?.alliance).toBe(true);
  });

  it('把旧奥迪空盟友和缺失盟友字段迁移为未结盟', () => {
    const empty = game('audi');
    (empty.audi as unknown as { alliance: null }).alliance = null;
    migrateState(empty);
    expect(empty.audi?.alliance).toBe(false);

    const missing = game('audi');
    delete (missing.audi as unknown as { alliance?: boolean }).alliance;
    migrateState(missing);
    expect(missing.audi?.alliance).toBe(false);
  });

  it('FIA 座谈会辩论不再推进奥迪联盟进度', () => {
    const state = game('audi');
    state.season.roundIndex = 2;
    state.teams.audi.boardConfidence = 100;
    state.teams.audi.mediaReputation = 100;
    state.fiaMeeting!.politicalCapital = 100;
    afterNextTeamRace(state);
    expect(state.fiaMeeting!.current?.issue).toBe('ferrari_turbo');
    const before = state.audi!.aduoProgress;
    expect(fiaDebate(state, 'support').ok).toBe(true);
    expect(state.audi!.aduoProgress).toBe(before);
  });
});
