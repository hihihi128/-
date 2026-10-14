import { describe, expect, it } from 'vitest';
import { dispatch } from '../../src/engine/actions';
import { supplyCustomers } from '../../src/engine/aduo';
import { normalizeDatabase } from '../../src/engine/data';
import { createGame } from '../../src/engine/newgame';
import { afterManagementRace, applyAlpinePuPenalty, completeAlpineDriverExit, completeWilliamsHandover } from '../../src/engine/managementSpecials';
import { applyRandomEventResolution, beginRandomEventWeek, setRandomEventContent, triggerNextWeeklyRandomEvent, triggerWeekendRandomEvent } from '../../src/engine/randomEvents';
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
    expect(Object.keys(alpine.alpine!.penalizedPowerSpecs)).toHaveLength(6);
    expect(buildView(alpine).alpine?.rndDirection).toEqual(['chassis', 'sidepods']);

    const haas = game('haas');
    expect(haas.haas).toMatchObject({ geneSupport: 62, toyotaInfluence: 20, partnershipWithdrawn: false });
    expect(buildView(haas).haas?.fundingProvided).toBe(0);

    const williams = game('williams');
    expect(williams.williams).toMatchObject({ successionReadiness: 25, focus: null, confirmedSuccessor: false });
    expect(williams.narration.at(-1)?.title).toContain('交接年');
  });

  it('间隔周执行过管理行动后，比赛周不会误判为整站未行动', () => {
    let alpine = game('alpine');
    alpine = dispatch(alpine, { type: 'ALPINE_MANAGEMENT', strategy: 'back_colapinto' }, { now: 1 }).state;
    const alpineSatisfaction = alpine.alpine!.briatoreSatisfaction;
    alpine.season.week += 2;
    afterManagementRace(alpine);
    expect(alpine.alpine!.briatoreSatisfaction).toBe(alpineSatisfaction);

    let williams = game('williams');
    williams = dispatch(williams, { type: 'WILLIAMS_BUDGET_FOCUS', focus: 'reserve' }, { now: 1 }).state;
    const confidence = williams.williams!.vowlesConfidence;
    williams.season.week += 2;
    afterManagementRace(williams);
    expect(williams.williams!.vowlesConfidence).toBe(confidence + 1);
  });

  it('阿尔派只能遵守布里亚托利研发方向，并在三种管理取舍中每站选择一次', () => {
    let state = game('alpine');
    expect(run(state, { type: 'START_PROJECT', partType: 'floor', ambition: 'standard' }).message).toContain('布里亚托利');
    const beforeGasly = state.alpine!.gaslyCommitment;
    const result = run(state, { type: 'ALPINE_MANAGEMENT', strategy: 'back_colapinto' });
    expect(result.ok).toBe(true);
    state = result.state;
    expect(state.alpine!.fanPressure).toBeLessThan(42);
    expect(state.alpine!.gaslyCommitment).toBeLessThan(beforeGasly);
    expect(run(state, { type: 'ALPINE_MANAGEMENT', strategy: 'integrate_power_unit' }).ok).toBe(false);
  });

  it('阿尔派动力匹配惩罚覆盖供应商新件，完成匹配后只恢复到梅赛德斯水平', () => {
    let state = game('alpine');
    const works = state.teams.mercedes;
    state.alpine!.penalizedPowerSpecs['ice:ice-2'] = { partType: 'ice', specId: 'ice-2', perfAfter: 88, relAfter: 82 };
    supplyCustomers(state, works, 'ice', { id: 'works-test', type: 'ice', version: 99, perf: 94, rel: 90, verified: true, expected: null, introduced: 'test' });
    const delivered = state.teams.alpine.parts.ice.specs.at(-1)!;
    expect(delivered).toMatchObject({ perf: 90, rel: 85 });
    state.alpine!.puIntegration = 80;
    state = run(state, { type: 'ALPINE_MANAGEMENT', strategy: 'integrate_power_unit' }).state;
    expect(state.alpine!.integrationPenaltyActive).toBe(false);
    expect(state.teams.alpine.parts.ice.specs.at(-1)).toMatchObject({ perf: 94, rel: 90 });
    expect(state.teams.alpine.parts.ice.specs[0].perf).toBe(state.teams.mercedes.parts.ice.specs[0].perf);
  });

  it('阿尔派重新处理同一动力单元规格时会对更新后的供应商数值重新施加惩罚', () => {
    const state = game('alpine');
    const spec = state.teams.alpine.parts.ice.specs.at(-1)!;
    const key = `ice:${spec.id}`;
    expect(state.alpine!.penalizedPowerSpecs[key]).toBeDefined();

    // 模拟供应商对同一规格编号重发校准后的基准数值。
    spec.perf = 97;
    spec.rel = 93;
    applyAlpinePuPenalty(state, state.teams.alpine, 'ice', spec);
    expect(spec).toMatchObject({ perf: 93, rel: 88 });
    expect(state.alpine!.penalizedPowerSpecs[key]).toMatchObject({ perfAfter: 93, relAfter: 88 });

    // 相同的已惩罚值不会被重复扣减。
    applyAlpinePuPenalty(state, state.teams.alpine, 'ice', spec);
    expect(spec).toMatchObject({ perf: 93, rel: 88 });
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

    let postRace = game('williams');
    postRace = run(postRace, { type: 'WILLIAMS_BUDGET_FOCUS', focus: 'facilities' }).state;
    afterManagementRace(postRace);
    expect(postRace.williams!.focus).toBe('facilities');
    expect(run(postRace, { type: 'UPGRADE_FACILITY', facility: 'windTunnel' }).ok).toBe(true);
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

  it('每周建立 3–4 个事件配额，并允许依次触发多个事件', () => {
    const state = game('haas');
    state.rules.randomEvents = { minPerWeek: 3, maxPerWeek: 4, routineWeight: 0, noneWeight: 0, driverInjuryWeight: 1, windTunnelWeight: 0, partIssueWeight: 0, minDialogueTurns: 2, maxDialogueTurns: 3 };
    const before = state.teams.haas.cars.map(car => state.drivers[car.driverId!].fitness);
    const rng = new Rng(9);
    beginRandomEventWeek(state, rng);
    triggerNextWeeklyRandomEvent(state, rng);
    expect(state.randomEvents?.current?.kind).toBe('driver_injury');
    expect(state.randomEvents?.current?.status).toBe('pending_generation');
    expect(state.randomEvents?.history).toHaveLength(1);
    expect(state.randomEvents?.weeklyQuota).toBeGreaterThanOrEqual(3);
    expect(state.randomEvents?.weeklyQuota).toBeLessThanOrEqual(4);
    expect(state.randomEvents?.current?.totalDialogueTurns).toBeGreaterThanOrEqual(2);
    expect(state.randomEvents?.current?.totalDialogueTurns).toBeLessThanOrEqual(3);
    expect(state.teams.haas.cars.map(car => state.drivers[car.driverId!].fitness)).toEqual(before);
    triggerNextWeeklyRandomEvent(state, rng);
    expect(state.randomEvents?.history).toHaveLength(1);
    const event = state.randomEvents!.current!;
    setRandomEventContent(state, event.id, { title: event.title, prompt: event.prompt, answerOptions: ['处理', '跳过'] });
    applyRandomEventResolution(state, event.id, 'resolved', '问题已处理。', []);
    triggerNextWeeklyRandomEvent(state, rng);
    expect(state.randomEvents?.history).toHaveLength(2);
  });

  it('日常事件只允许一次 0.05–0.1 的个人好感度变化', () => {
    const state = game('haas');
    state.rules.randomEvents = { minPerWeek: 3, maxPerWeek: 3, routineWeight: 1, noneWeight: 0, driverInjuryWeight: 0, windTunnelWeight: 0, partIssueWeight: 0, minDialogueTurns: 2, maxDialogueTurns: 2 };
    const event = triggerNextWeeklyRandomEvent(state, new Rng(27))!;
    setRandomEventContent(state, event.id, { title: '工程师晚餐', prompt: '工程师邀请领队吃饭。', answerOptions: ['接受', '婉拒'] });
    const staff = Object.values(state.teams.haas.staff)[0];
    const before = staff.affinity ?? 50;
    expect(applyRandomEventResolution(state, event.id, 'resolved', '双方轻松聊了近况。', [{ op: 'funds', targetId: null, delta: 1, reason: '不应允许' }]).ok).toBe(false);
    expect(applyRandomEventResolution(state, event.id, 'resolved', '双方轻松聊了近况。', [{ op: 'affinity', targetId: staff.id!, delta: 0.05, reason: '交流增进了解' }]).ok).toBe(true);
    expect(staff.affinity).toBeCloseTo(before + 0.05, 5);
  });

  it('风洞事件只有在双 API 判定后才改变项目，并保留已完成的进度', () => {
    let state = game('haas');
    state = run(state, { type: 'START_PROJECT', partType: 'floor', ambition: 'standard' }).state;
    const project = state.teams.haas.projects.at(-1)!;
    project.weeksLeft -= 2;
    const before = { weeksLeft: project.weeksLeft, weeksTotal: project.weeksTotal, elapsed: project.weeksTotal - project.weeksLeft };
    state.rules.randomEvents = { routineWeight: 0, noneWeight: 0, driverInjuryWeight: 0, windTunnelWeight: 1, partIssueWeight: 0 };

    triggerWeekendRandomEvent(state, new Rng(12));
    expect(state.randomEvents?.current?.kind).toBe('wind_tunnel_data');
    const event = state.randomEvents!.current!;
    expect(setRandomEventContent(state, event.id, { title: event.title, prompt: event.prompt, answerOptions: ['复核', '继续'] })).toBe(true);
    expect(applyRandomEventResolution(state, event.id, 'unresolved', '复核失败，项目需要延期。', [{ op: 'project_weeks', targetId: project.id, delta: 1, reason: '数据仍不一致' }]).ok).toBe(true);
    expect(state.randomEvents!.history.at(-1)).toMatchObject({ id: event.id, status: 'unresolved', outcomeSummary: '复核失败，项目需要延期。' });
    expect(project).toMatchObject({ weeksLeft: before.weeksLeft + 1, weeksTotal: before.weeksTotal + 1 });
    expect(project.weeksTotal - project.weeksLeft).toBe(before.elapsed);
  });

  it('加斯利失去留队意愿后会在赛季末实际进入自由市场', () => {
    const state = game('alpine');
    state.alpine!.gaslyLeaving = true;
    completeAlpineDriverExit(state);
    expect(state.drivers.gasly.teamId).toBeNull();
    expect(state.teams.alpine.cars.some(car => car.driverId === 'gasly')).toBe(false);
    expect(state.alpine).toMatchObject({ gaslyLeaving: false, gaslyCommitment: state.rules.alpine.startGaslyCommitment });
    expect(state.narration.at(-1)?.title).toContain('离开');
  });

  it('未处理车队事务会在赛后产生持续后果', () => {
    const state = game('haas');
    const influence = state.haas!.toyotaInfluence;
    afterManagementRace(state);
    expect(state.haas!.toyotaInfluence).toBe(influence + state.rules.haas.influencePerRace);
    expect(state.haas!.geneSupport).toBeLessThan(62);
  });
});
