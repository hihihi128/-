import { describe, expect, it } from 'vitest';
import { previewProject } from '../../src/engine/development';
import { carRatings } from '../../src/engine/ratings';
import { act, advanceUntil, newTestGame, tryAct } from '../helpers';

describe('研发与升级件', () => {
  it('预览给出花费、周期与收益区间', () => {
    const s = newTestGame();
    const cons = previewProject(s, 'team_c', 'floor', 'conservative');
    const aggr = previewProject(s, 'team_c', 'floor', 'aggressive');
    expect(cons.ok).toBe(true);
    expect(aggr.cost).toBeGreaterThan(cons.cost);
    expect(aggr.gain[1]).toBeGreaterThan(cons.gain[1]);
    expect(aggr.gain[1] - aggr.gain[0]).toBeGreaterThan(cons.gain[1] - cons.gain[0]);
    expect(cons.units).toBe(2);
    expect(aggr.units).toBe(1);
  });

  it('项目完工后生成新规格并进入库存，领队可以分配给指定赛车', () => {
    let s = newTestGame(31);
    const fundsBefore = s.teams.team_c.funds;
    s = act(s, { type: 'START_PROJECT', partType: 'front_wing', ambition: 'aggressive' });
    const team = s.teams.team_c;
    expect(team.funds).toBeLessThan(fundsBefore);
    expect(team.projects).toHaveLength(1);
    expect(team.aeroHours).toBeLessThan(newTestGame(31).teams.team_c.aeroHours);
    // 推进时间：开始赛季（3 周）+ 第一站周末之后的间隔
    s = advanceUntil(s, x => x.teams.team_c.parts.front_wing.specs.length > 1);
    const fw = s.teams.team_c.parts.front_wing;
    const v2 = fw.specs.find(x => x.version === 2)!;
    expect(v2.verified).toBe(false);
    expect(fw.stock[v2.id]).toBe(1);
    // 在可换件的阶段分配给 2 号车
    s = advanceUntil(s, x => ['pre_race', 'practice', 'preseason', 'post_race'].includes(x.season.phase) && !x.weekend?.parcFerme);
    const before = carRatings(s.teams.team_c, s.teams.team_c.cars[1], s.rules).overall;
    const oldSpec = s.teams.team_c.cars[1].fitted.front_wing;
    const oldStock = s.teams.team_c.parts.front_wing.stock[oldSpec] ?? 0;
    s = act(s, { type: 'FIT_PART', slot: 2, partType: 'front_wing', specId: v2.id });
    const t2 = s.teams.team_c;
    expect(t2.cars[1].fitted.front_wing).toBe(v2.id);
    expect(t2.parts.front_wing.stock[v2.id]).toBe(0);
    // 旧件回到库存
    expect(t2.parts.front_wing.stock[oldSpec]).toBe(oldStock + 1);
    const after = carRatings(t2, t2.cars[1], s.rules).overall;
    expect(after).not.toBe(before);
    // 没有备件时不能再装到 1 号车
    const res = tryAct(s, { type: 'FIT_PART', slot: 1, partType: 'front_wing', specId: v2.id });
    expect(res.ok).toBe(false);
  });

  it('排位后封闭车辆规则禁止换件', () => {
    let s = newTestGame(8);
    s = advanceUntil(s, x => x.season.phase === 'race');
    expect(s.weekend!.parcFerme).toBe(true);
    const team = s.teams.team_c;
    team.parts.front_wing.specs.push({ id: 'front_wing-7', type: 'front_wing', version: 7, perf: 90, rel: 85, verified: true, expected: null, introduced: 't' });
    team.parts.front_wing.stock['front_wing-7'] = 2;
    const res = tryAct(s, { type: 'FIT_PART', slot: 1, partType: 'front_wing', specId: 'front_wing-7' });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('封闭车辆');
    // 正赛结束后解锁
    s = act(s, { type: 'RUN_RACE' });
    expect(tryAct(s, { type: 'FIT_PART', slot: 1, partType: 'front_wing', specId: 'front_wing-7' }).ok).toBe(true);
  });

  it('升级件分配不均会让吃亏的车手不满（受自尊心影响）', () => {
    let s = newTestGame(55, 'team_a');
    // 直接构造一个大幅领先的新底板只装在 1 号车
    const team = s.teams.team_a;
    team.parts.floor.specs.push({ id: 'floor-9', type: 'floor', version: 9, perf: 99, rel: 85, verified: true, expected: null, introduced: 'test' });
    team.parts.floor.stock['floor-9'] = 1;
    s = act(s, { type: 'FIT_PART', slot: 1, partType: 'floor', specId: 'floor-9' });
    s = advanceUntil(s, x => x.season.phase === 'race');
    const a2Before = s.drivers.a2.morale;
    const trustBefore = s.drivers.a2.trust;
    s = act(s, { type: 'RUN_RACE' });
    const news = s.news.map(n => n.text).join('\n');
    expect(news).toContain('升级件分配');
    expect(s.drivers.a2.trust).toBeLessThan(trustBefore);
    // 心态还受比赛成绩影响，因此只检查新闻和信任；同时确认叙事事件里有分配不满
    expect(s.narration.some(e => e.kind === 'allocation') || s.narrated.some(e => e.kind === 'allocation')).toBe(true);
    void a2Before;
  });

  it('预算帽与风洞时长会阻止研发', () => {
    let s = newTestGame(3);
    s.teams.team_c.costCapSpent = s.rules.costCap - 0.5;
    const p = previewProject(s, 'team_c', 'floor', 'standard');
    expect(p.ok).toBe(false);
    expect(p.blockers.join()).toContain('预算帽');
    s = newTestGame(3);
    s.teams.team_c.aeroHours = 1;
    expect(previewProject(s, 'team_c', 'floor', 'standard').blockers.join()).toContain('风洞');
    // 非空动部件不受风洞限制
    expect(previewProject(s, 'team_c', 'suspension', 'standard').ok).toBe(true);
  });

  it('研发槽位上限', () => {
    let s = newTestGame(4);
    s.teams.team_c.funds = 500;
    s.teams.team_c.aeroHours = 999;
    const parts = ['floor', 'front_wing', 'rear_wing', 'sidepods', 'suspension'];
    let started = 0;
    for (const pt of parts) {
      const r = tryAct(s, { type: 'START_PROJECT', partType: pt, ambition: 'standard' });
      if (r.ok) {
        s = r.state;
        started++;
      } else {
        expect(r.message).toContain('槽位');
      }
    }
    expect(started).toBe(3); // 工厂 3 级：2 + floor((3-1)/2) = 3
  });

  it('设施升级与训练会在时间推进后生效', () => {
    let s = newTestGame(9);
    const sim = s.teams.team_c.facilities.simulator;
    const crew = s.teams.team_c.staff.pitCrew.skill;
    s = act(s, { type: 'UPGRADE_FACILITY', facility: 'simulator' });
    s = act(s, { type: 'TRAIN_PIT_CREW' });
    s = act(s, { type: 'TRAIN_DRIVER', driverId: 'c2', attr: 'consistency' });
    const c2 = s.drivers.c2.attrs.consistency;
    s = advanceUntil(s, x => x.season.week >= 6);
    expect(s.teams.team_c.facilities.simulator).toBe(sim + 1);
    expect(s.teams.team_c.staff.pitCrew.skill).toBeGreaterThan(crew);
    expect(s.drivers.c2.attrs.consistency).toBeGreaterThan(c2);
  });

  it('AI 车队也会研发', () => {
    const s = advanceUntil(newTestGame(21), x => x.season.phase === 'season_end');
    const aiSpecs = ['team_a', 'team_b', 'team_d'].map(t => Object.values(s.teams[t].parts).reduce((a, p) => a + p.specs.length, 0));
    expect(Math.max(...aiSpecs)).toBeGreaterThan(8);
  });
});
