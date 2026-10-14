import { describe, expect, it } from 'vitest';
import { homologationsLeft, maybeEvaluateAduo, measureManufacturers, nextEvalRound } from '../../src/engine/aduo';
import { normalizeDatabase } from '../../src/engine/data';
import { advanceWeeks, cancelProject, previewProject, startProject } from '../../src/engine/development';
import { costCapOf } from '../../src/engine/finance';
import { migrateState } from '../../src/engine/migrate';
import { createGame } from '../../src/engine/newgame';
import { Rng } from '../../src/engine/rng';
import type { GameState } from '../../src/engine/types';
import { buildView } from '../../src/engine/view';
import { advanceUntil, cardSources, newTestGame } from '../helpers';

function cardGame(playerTeamId = 'mercedes', seed = 3): GameState {
  const res = normalizeDatabase(cardSources());
  return createGame(res.db!, { playerTeamId, principalName: '测试', seed, gameId: 'g', now: 1 });
}

describe('ADUO 与动力单元供应', () => {
  it('客户车队不能研发动力单元零件，其他零件不受影响', () => {
    const s = cardGame('mclaren');
    const pu = previewProject(s, 'mclaren', 'ice', 'standard');
    expect(pu.ok).toBe(false);
    expect(pu.blockers.join()).toContain('梅赛德斯车队');
    expect(previewProject(s, 'mclaren', 'floor', 'standard').blockers.join()).not.toContain('动力单元');
  });

  it('每赛季 1 次认证升级；取消项目返还次数', () => {
    const s = cardGame('mercedes');
    const rng = new Rng(1);
    expect(startProject(s, 'mercedes', 'ice', 'standard', false, rng).ok).toBe(true);
    const mgu_k = previewProject(s, 'mercedes', 'mgu_k', 'standard');
    expect(mgu_k.ok).toBe(false);
    expect(mgu_k.blockers.join()).toContain('认证升级次数已用完（1/1）');
    const p = s.teams.mercedes.projects.find(x => x.partType === 'ice')!;
    cancelProject(s, 'mercedes', p.id);
    expect(homologationsLeft(s, s.teams.mercedes)).toBe(1);
  });

  it('厂商车队交付的新件同时交付给客户车队', () => {
    const s = cardGame('mercedes');
    const rng = new Rng(2);
    expect(startProject(s, 'mercedes', 'ice', 'standard', false, rng).ok).toBe(true);
    advanceWeeks(s, 20, rng);
    const latest = (id: string) => [...s.teams[id].parts.ice.specs].sort((a, b) => b.version - a.version)[0];
    expect(latest('mercedes').version).toBe(2);
    for (const c of ['mclaren', 'williams', 'alpine']) {
      expect(latest(c).perf, c).toBe(latest('mercedes').perf);
      expect(latest(c).verified, c).toBe(true);
      // AI 客户车队自动装车
      expect(s.teams[c].cars.every(car => car.fitted.ice === latest(c).id), c).toBe(true);
    }
  });

  it('开局记录季前基准，不产生效果', () => {
    const s = cardGame('ferrari');
    expect(s.aduo?.evaluations).toHaveLength(1);
    expect(s.aduo!.evaluations[0].round).toBe(0);
    expect(Object.values(s.teams).every(t => (t.aduoUpgrades ?? 0) === 0)).toBe(true);
    const rows = measureManufacturers(s);
    expect(rows.map(r => r.engine)).toEqual(['梅赛德斯', '法拉利', '红牛-福特', '奥迪', '本田']);
    expect(rows[0].deficitPct).toBe(0);
  });

  it('评估站后按厂商给补偿：只给厂商车队，客户车队不受益', () => {
    const s = cardGame('aston_martin');
    s.rules.aduo.evalRounds = [1];
    const cap = costCapOf(s.teams.aston_martin, s.rules);
    const after = advanceUntil(s, x => x.season.roundIndex === 1 && x.season.phase === 'pre_race');
    const ev = after.aduo!.evaluations.at(-1)!;
    expect(ev.round).toBe(1);
    const honda = ev.results.find(r => r.engine === '本田')!;
    expect(honda.tier).toBe(2);
    const am = after.teams.aston_martin;
    expect(am.aduoTier).toBe(2);
    expect(am.aduoUpgrades).toBe(after.rules.aduo.tier2Upgrades);
    expect(costCapOf(am, after.rules)).toBe(cap + after.rules.aduo.tier2CapBonus);
    // 研发周期缩短
    const fast = previewProject(after, 'aston_martin', 'ice', 'standard').weeks;
    am.aduoTier = 0;
    expect(previewProject(after, 'aston_martin', 'ice', 'standard').weeks).toBeGreaterThan(fast);
    am.aduoTier = 2;
    // 梅赛德斯是最好的厂商；客户车队哈斯 / 凯迪拉克没有补偿
    expect(ev.results.find(r => r.engine === '梅赛德斯')!.tier).toBe(0);
    expect(after.teams.haas.aduoUpgrades).toBe(0);
    expect(after.news.some(n => n.text.includes('获得 ADUO 二档'))).toBe(true);
    const v = buildView(after);
    expect(v.aduo.tier).toBe(2);
    expect(v.aduo.upgradesTotal).toBe(1 + after.rules.aduo.tier2Upgrades);
    expect(v.aduo.last?.round).toBe(1);
  });

  it('客户车队的面板显示供应商的 ADUO 状态', () => {
    const s = cardGame('haas');
    s.teams.ferrari.aduoTier = 1;
    s.teams.ferrari.aduoUpgrades = 1;
    const v = buildView(s).aduo;
    expect(v.isCustomer).toBe(true);
    expect(v.supplier).toBe('法拉利车队');
    expect(v.tier).toBe(1);
    expect(v.upgradesTotal).toBe(2);
  });

  it('没有厂商车队的数据：各车队自行研发，评估覆盖组内所有车队', () => {
    const s = newTestGame();
    const team = s.teams[s.meta.playerTeamId];
    expect(previewProject(s, team.id, 'ice', 'standard').ok).toBe(true);
    const ev = maybeEvaluateAduo(s, s.rules.aduo.evalRounds[0]);
    expect(ev).not.toBeNull();
    for (const row of ev!.results.filter(r => r.tier > 0)) {
      const group = Object.values(s.teams).filter(t => t.engine === row.engine);
      expect(group.every(t => t.aduoTier === row.tier)).toBe(true);
    }
  });

  it('新赛季重置次数与补偿，客户车队动力单元与厂商一致', () => {
    let s = cardGame('williams');
    s.rules.aduo.evalRounds = [1];
    s = advanceUntil(s, x => x.season.phase === 'season_end', 400);
    s.teams.aston_martin.puHomologations = 1;
    s = advanceUntil(s, x => x.season.phase === 'preseason' && x.season.number === 2, 5);
    expect(Object.values(s.teams).every(t => t.puHomologations === 0 && t.aduoUpgrades === 0 && t.aduoCapBonus === 0)).toBe(true);
    expect(s.aduo!.evaluations.map(e => e.round)).toEqual([0]);
    for (const c of ['mclaren', 'williams', 'alpine']) {
      expect(s.teams[c].parts.ice.specs[0].perf, c).toBe(s.teams.mercedes.parts.ice.specs[0].perf);
    }
  });

  it('旧存档补齐 ADUO 字段', () => {
    const s = cardGame('mercedes');
    const raw = JSON.parse(JSON.stringify(s));
    delete raw.rules.aduo;
    delete raw.aduo;
    for (const t of Object.values(raw.teams) as Array<Record<string, unknown>>) {
      delete t.worksTeam;
      delete t.puHomologations;
      delete t.aduoUpgrades;
      delete t.aduoCapBonus;
      delete t.aduoTier;
    }
    const m = migrateState(raw);
    expect(m.rules.aduo.enabled).toBe(true);
    expect(m.aduo).toEqual({ evaluations: [] });
    expect(m.teams.mclaren.worksTeam).toBe(false);
    // 旧存档没有厂商信息：客户车队可以自行研发
    expect(previewProject(m, 'mercedes', 'ice', 'standard').ok).toBe(true);
    expect(buildView(m).aduo.last).toBeNull();
  });

  it('同一动力单元填了两支厂商车队：只保留第一支并警告', () => {
    const sources = cardSources();
    const teamsSrc = sources.find(x => Array.isArray((x.data as { teams?: unknown })?.teams))!;
    const list = (teamsSrc.data as { teams: Array<Record<string, unknown>> }).teams;
    list.find(t => t.id === 'mclaren')!.worksTeam = true;
    const res = normalizeDatabase(sources);
    expect(res.issues.some(i => i.path.includes('mclaren.worksTeam'))).toBe(true);
    expect(res.db!.teams.find(t => t.id === 'mclaren')!.worksTeam).toBe(false);
  });

  it('档位按未取整的差距判断', () => {
    const s = cardGame('mercedes');
    s.rules.aduo.pctPerPoint = 1;
    const best = Math.max(...s.teams.mercedes.parts.ice.specs.map(x => x.perf));
    for (const spec of s.teams.ferrari.parts.ice.specs) spec.perf = best - 1.96;
    const row = measureManufacturers(s).find(r => r.engine === '法拉利')!;
    expect(row.deficitPct).toBe(2);
    expect(row.tier).toBe(0);
  });

  it('评估站的正赛结束后，下一次评估仍是本站', () => {
    const s = cardGame('mercedes');
    s.rules.aduo.evalRounds = [1, 2];
    const post = advanceUntil(s, x => x.season.phase === 'post_race');
    expect(nextEvalRound(post)).toBe(1);
    const next = advanceUntil(post, x => x.season.phase === 'pre_race');
    expect(nextEvalRound(next)).toBe(2);
    s.rules.aduo.evalRounds = [s.calendar.length];
    expect(nextEvalRound(s)).toBeNull();
  });

  it('旧存档中进行中的动力单元项目占用认证次数', () => {
    const s = cardGame('mercedes');
    expect(startProject(s, 'mercedes', 'ice', 'standard', false, new Rng(4)).ok).toBe(true);
    const raw = JSON.parse(JSON.stringify(s));
    delete raw.rules.aduo;
    for (const t of Object.values(raw.teams) as Array<Record<string, unknown>>) delete t.puHomologations;
    const m = migrateState(raw);
    expect(m.teams.mercedes.puHomologations).toBe(1);
    expect(previewProject(m, 'mercedes', 'mgu_k', 'standard').ok).toBe(false);
  });
});
