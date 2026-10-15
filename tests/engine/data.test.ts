import { describe, expect, it } from 'vitest';
import { normalizeDatabase } from '../../src/engine/data';
import { cardSources, placeholderSources } from '../helpers';

describe('数据解析（世界书 YAML）', () => {
  it('占位测试数据可以无错误加载', () => {
    const res = normalizeDatabase(placeholderSources());
    const errors = res.issues.filter(i => i.level === 'error');
    expect(errors).toEqual([]);
    expect(res.issues).toEqual([]);
    expect(res.canStart).toBe(true);
    expect(res.db!.teams).toHaveLength(11);
    expect(res.db!.drivers).toHaveLength(24);
    for (const t of res.db!.teams) {
      expect(res.db!.drivers.filter(d => d.teamId === t.id && d.role === 'race')).toHaveLength(2);
    }
    expect(new Set(res.db!.drivers.map(d => d.number)).size).toBe(24);
    // 2026 规则：每支车队都有自己的奖金档和风洞时长档
    const rules = res.db!.rules;
    expect(rules.costCap).toBe(215);
    expect(rules.pointsRace).toEqual([25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
    expect(rules.pointsSprint).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(rules.fastestLapPoint).toBe(0);
    expect(rules.prizeMoney).toHaveLength(11);
    expect(rules.aeroAllowanceByPosition).toHaveLength(11);
    expect(rules.aeroAllowanceByPosition[10]).toBe(1.15);
    expect(res.db!.tracks).toHaveLength(24);
    expect(res.db!.calendar).toHaveLength(24);
    expect(res.db!.calendar.filter(round => round.sprint)).toHaveLength(6);
    // 赛道权重自动归一化
    for (const t of res.db!.tracks) {
      const s = Object.values(t.weights).reduce((a, b) => a + b, 0);
      expect(s).toBeCloseTo(1, 2);
    }
  });

  it('11 支真实车队都提供具名的两位比赛工程师和策略负责人', () => {
    const db = normalizeDatabase(cardSources()).db!;
    const expected: Record<string, [string, string, string]> = {
      mercedes: ['马库斯·达德利', '彼得·博宁顿', '罗茜·韦特'], mclaren: ['威尔·约瑟夫', '汤姆·斯托拉德', '兰迪普·辛格'], red_bull: ['詹皮耶罗·兰比亚塞', '理查德·伍德', '汉娜·施密茨'],
      ferrari: ['卡洛·桑蒂', '布莱恩·博齐', '拉文·贾恩'], williams: ['詹姆斯·厄文', '加埃唐·热戈', '夏尔-安托万·弗洛朗坦'], racing_bulls: ['亚历山大·伊利奥普洛斯', '皮埃尔·哈梅林', '马蒂厄·迪布瓦-卢卡'],
      aston_martin: ['克里斯·克罗宁', '加里·甘农', '彼得·霍尔'], haas: ['劳拉·穆勒', '罗南·奥黑尔', '卡琳·克里德利希'], audi: ['史蒂文·佩特里克', '何塞·曼努埃尔·洛佩斯', '里特维克·达南贾亚·雷迪'],
      alpine: ['乔什·佩克特', '斯图尔特·巴洛', '奥里奥尔·伊塞恩'], cadillac: ['约翰·霍华德', '卡洛·帕塞蒂', '亚历克斯·古迪纳夫'],
    };
    expect(db.teams).toHaveLength(11);
    for (const team of db.teams) {
      expect([team.staff.raceEngineer, team.staff.raceEngineer2, team.staff.strategist].every(member => member.name && !member.name.includes('比赛工程师') && member.name !== '首席策略组')).toBe(true);
      expect([team.staff.raceEngineer.name, team.staff.raceEngineer2.name, team.staff.strategist.name]).toEqual(expected[team.id]);
      expect(Object.keys(team.staff.raceEngineer.abilities ?? {})).toEqual(expect.arrayContaining(['setup', 'communication', 'reaction', 'weather']));
      expect(Object.keys(team.staff.raceEngineer2.abilities ?? {})).toEqual(expect.arrayContaining(['setup', 'communication', 'reaction', 'weather']));
      expect(Object.keys(team.staff.strategist.abilities ?? {})).toEqual(expect.arrayContaining(['strategy', 'weather', 'reaction', 'risk']));
    }
  });

  it('提供带赛事标签和简介的 IndyCar/WEC 自由车手与工程候选人', () => {
    const db = normalizeDatabase(cardSources()).db!;
    for (const id of ['palou', 'newgarden', 'herta', 'fuoco', 'bamber']) {
      const driver = db.drivers.find(d => d.id === id)!;
      expect(driver.teamId, id).toBeNull();
      expect(['IndyCar', 'WEC']).toContain(driver.series);
      expect(driver.description.length, id).toBeGreaterThan(8);
    }
    for (const id of ['cannon', 'leena_gade', 'kyle_moyer', 'urs_kuratle']) {
      const staff = db.staffCandidates!.find(candidate => candidate.id === id)!;
      expect(['IndyCar', 'WEC']).toContain(staff.series);
      expect(staff.description!.length, id).toBeGreaterThan(8);
    }
  });

  it('数据指纹稳定', () => {
    const a = normalizeDatabase(placeholderSources()).db!.signature;
    const b = normalizeDatabase(placeholderSources()).db!.signature;
    expect(a).toBe(b);
  });

  it('支持中文顶层键与多条目合并（同 id 后者覆盖）', () => {
    const res = normalizeDatabase([
      ...placeholderSources(),
      { name: '补丁', data: { 车队: [{ id: 'team_d', name: '改名车队D', carBase: { perf: 75, rel: 80 } }] } },
    ]);
    expect(res.db!.teams.find(t => t.id === 'team_d')!.name).toBe('改名车队D');
    expect(res.issues.some(i => i.level === 'warning' && i.message.includes('重复'))).toBe(true);
  });

  it('规则深度合并', () => {
    const res = normalizeDatabase([...placeholderSources(), { name: '规则补丁', data: { rules: { costCap: 200, parts: { ice: { developable: false } } } } }]);
    expect(res.db!.rules.costCap).toBe(200);
    expect(res.db!.rules.parts.ice.developable).toBe(false);
    expect(res.db!.rules.parts.ice.baseCost).toBe(2.4);
  });

  it('引用错误会阻止开局并给出路径', () => {
    const res = normalizeDatabase([
      {
        name: '坏数据',
        data: {
          teams: [{ id: 'x' }, { id: 'y' }],
          drivers: [
            { id: 'd1', team: 'x' },
            { id: 'd2', team: 'nope' },
          ],
          tracks: [{ id: 't1' }],
          calendar: [{ track: 't1' }, { track: 'missing' }],
        },
      },
    ]);
    expect(res.canStart).toBe(false);
    const msgs = res.issues.filter(i => i.level === 'error').map(i => `${i.path} ${i.message}`);
    expect(msgs.some(m => m.includes('nope'))).toBe(true);
    expect(msgs.some(m => m.includes('missing'))).toBe(true);
    expect(msgs.some(m => m.includes('teams.y') && m.includes('正式车手'))).toBe(true);
  });

  it('空数据给出明确错误', () => {
    const res = normalizeDatabase([]);
    expect(res.canStart).toBe(false);
    expect(res.issues.map(i => i.path)).toEqual(expect.arrayContaining(['teams', 'tracks', 'calendar']));
  });

  it('非法数值会被修正并警告', () => {
    const src = placeholderSources();
    const res = normalizeDatabase([
      ...src,
      { name: '越界', data: { drivers: [{ id: 'z1', team: 'team_d', role: 'reserve', attrs: { pace: 150, wet: 'abc' } }] } },
    ]);
    const z = res.db!.drivers.find(d => d.id === 'z1')!;
    expect(z.attrs.pace).toBe(100);
    expect(res.issues.some(i => i.message.includes('不是有效数字'))).toBe(true);
  });

  it('规则里结构错误或数值非法时阻止开局并恢复默认值', () => {
    const cases: Array<[string, unknown, (r: ReturnType<typeof normalizeDatabase>) => void]> = [
      ['dryCompounds: []', { dryCompounds: [] }, r => expect(r.db!.rules.dryCompounds.length).toBeGreaterThan(0)],
      ['负的研发花费', { parts: { floor: { baseCost: -10 } } }, r => expect(r.db!.rules.parts.floor.baseCost).toBe(3)],
      ['NaN 预算帽', { costCap: Number.NaN }, r => expect(r.db!.rules.costCap).toBe(215)],
      ['文本当数字', { costCap: 'abc' }, r => expect(r.db!.rules.costCap).toBe(215)],
      ['parts 不是对象', { parts: [1, 2] }, () => {}],
      ['facilities 条目类型错误', { facilities: { cfd: 5 } }, r => expect(r.db!.rules.facilities.cfd.maxLevel).toBe(5)],
      ['tyres 条目缺 pace', { tyres: { soft: { pace: 'fast' } } }, r => expect(typeof r.db!.rules.tyres.soft.pace).toBe('number')],
      ['零件权重为负', { parts: { floor: { weights: { downforce: -1 } } } }, r => expect(r.db!.rules.parts.floor.weights.downforce).toBe(0.4)],
      ['设施升级表长度不足', { facilities: { cfd: { upgradeCost: [1] } } }, () => {}],
    ];
    for (const [name, rules, check] of cases) {
      const res = normalizeDatabase([...placeholderSources(), { name, data: { rules } }]);
      expect(res.canStart, name).toBe(false);
      expect(res.issues.some(i => i.level === 'error' && i.path.startsWith('rules')), name).toBe(true);
      check(res);
    }
  });

  it('用 null 删除必填规则字段时恢复默认值并警告', () => {
    const res = normalizeDatabase([...placeholderSources(), { name: '删除', data: { rules: { dryCompounds: null } } }]);
    expect(res.canStart).toBe(true);
    expect(res.db!.rules.dryCompounds).toEqual(['soft', 'medium', 'hard']);
    expect(res.issues.some(i => i.level === 'warning' && i.path === 'rules.dryCompounds')).toBe(true);
  });

  it('设施/研发激进程度里的未知条目（拼写错误）会被忽略并警告，而不是让解析崩溃', () => {
    const res = normalizeDatabase([
      ...placeholderSources(),
      { name: '拼错', data: { rules: { facilities: { wind_tunel: {}, cfd: 'x' }, ambition: { crazy: { units: 2 } } } } },
    ]);
    expect(res.db!.rules.facilities).not.toHaveProperty('wind_tunel');
    expect(res.db!.rules.ambition).not.toHaveProperty('crazy');
    expect(res.issues.some(i => i.level === 'warning' && i.path === 'rules.facilities.wind_tunel')).toBe(true);
    expect(res.issues.some(i => i.level === 'error' && i.path === 'rules.facilities.cfd')).toBe(true);
    expect(res.db!.rules.facilities.cfd.upgradeCost.length).toBeGreaterThan(0);
  });

  it('允许为负的规则字段（轮胎速度、可靠性变化）不会被误报', () => {
    const res = normalizeDatabase([
      ...placeholderSources(),
      { name: '合法', data: { rules: { tyres: { medium: { pace: -0.1 } }, ambition: { aggressive: { relDelta: -8 } }, parts: { gearbox: null } } } },
    ]);
    expect(res.issues.filter(i => i.level === 'error')).toEqual([]);
    expect(res.db!.rules.tyres.medium.pace).toBe(-0.1);
    expect(res.db!.rules.parts.gearbox).toBeUndefined();
  });
});
