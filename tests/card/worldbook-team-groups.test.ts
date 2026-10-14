import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const dir = path.resolve('src/card/worldbook');
const strategyFiles = readdirSync(dir).filter(name => /^lore-strategy-.*\.md$/.test(name)).sort();
const staffFiles = readdirSync(dir).filter(name => /^lore-staff-.*\.md$/.test(name)).sort();
const teams = YAML.parse(readFileSync(path.join(dir, 'data-teams.yaml'), 'utf8')).teams as Array<{
  id: string;
  name: string;
  staff: {
    technicalDirector: { name?: string };
    aeroChief: { name?: string };
    raceEngineer: { name: string };
    raceEngineer2: { name: string };
    pitCrew: { name?: string };
    strategist: { name: string; abilities: { risk: number } };
  };
}>;
const drivers = YAML.parse(readFileSync(path.join(dir, 'data-drivers.yaml'), 'utf8')).drivers as Array<{ name: string; team: string; role: string }>;
const slugs: Record<string, string> = {
  mercedes: 'mercedes', mclaren: 'mclaren', red_bull: 'red-bull', ferrari: 'ferrari', williams: 'williams',
  racing_bulls: 'racing-bulls', aston_martin: 'aston-martin', haas: 'haas', audi: 'audi', alpine: 'alpine', cadillac: 'cadillac',
};
const strategySections = ['负责人:', '决策风格:', '数据优势:', '风险偏好:', '沟通流程:', '常见失误与剧情触发:', '叙事指引:'];
const staffSections = ['组成人员:', '技术分工:', '赛道执行:', '储备与后备:', '内部协作:', '玩家关系:', '叙事指引:'];
const expectedReserves: Record<string, string[]> = {
  mercedes: ['弗雷德里克·维斯蒂'],
  mclaren: ['莱昂纳多·福纳罗利', '帕托·奥沃德'],
  red_bull: ['角田裕毅'],
  ferrari: ['安东尼奥·乔维纳兹'],
  williams: ['卢克·布朗宁'],
  racing_bulls: ['岩佐步梦'],
  aston_martin: ['杰克·克劳福德'],
  haas: ['杰克·杜汉', '平川亮'],
  audi: ['泰奥·普尔谢尔'],
  alpine: ['保罗·阿隆'],
  cadillac: ['周冠宇'],
};
const leadershipNames = readdirSync(dir)
  .filter(name => /^lore-leadership-.*\.md$/.test(name))
  .map(name => readFileSync(path.join(dir, name), 'utf8').match(/^<管理层资料 name="([^"]+)"/)?.[1])
  .filter((name): name is string => Boolean(name));
const mechanicFragments = [
  '获得 ADUO 前的动力单元故障',
  '软件适配完成前的动力单元异常放电',
  '赛车准备不足会提高车手失误概率',
  'GP 与迈凯伦的谈判',
  '偏袒任何一位车手都会引发',
  '预算方向每周在设施',
  '资金投给设施',
  '正式车手可能被红牛临时调走',
  '振动风险触发强制退赛',
  '丰田影响力达到阈值',
  '联盟进度决定动力单元性能',
  '通过政治联盟争取动力单元补偿',
  '长期忽视加斯利会让他赛季后离队',
  '内燃机性能与可靠性受损',
  '匹配进度由管理资源推动',
  '每站记录动力与可靠性损失',
  '动力与可靠性都有缺口',
];

function source(file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

describe('车队策略组与技术赛道核心组世界书', () => {
  it('11 支车队各有一个策略组和一个核心组条目', () => {
    expect(strategyFiles).toHaveLength(11);
    expect(staffFiles).toHaveLength(11);
    for (const team of teams) {
      expect(strategyFiles).toContain(`lore-strategy-${slugs[team.id]}.md`);
      expect(staffFiles).toContain(`lore-staff-${slugs[team.id]}.md`);
    }
  });

  it('所有员工条目都有可显示的姓名或组名', () => {
    for (const team of teams) {
      for (const [role, staff] of Object.entries(team.staff)) {
        expect(staff.name?.trim(), `${team.id}.${role}`).toBeTruthy();
      }
    }
  });

  it('策略组包含负责人、团队风格、作用域和完整标签', () => {
    for (const team of teams) {
      const file = `lore-strategy-${slugs[team.id]}.md`;
      const text = source(file);
      expect(text.startsWith(`<策略组资料 team="${team.name.replace('车队', '')}" year="2026">`), file).toBe(true);
      expect(text.trimEnd().endsWith('</策略组资料>'), file).toBe(true);
      expect(text.includes(team.staff.strategist.name), `${file}: ${team.staff.strategist.name}`).toBe(true);
      expect(text.split(team.staff.strategist.name).length, `${file}: 负责人需有独立表达风格`).toBeGreaterThanOrEqual(3);
      expect(text.includes('玩家关系与专属机制只在实时数据表明玩家执掌本队时生效'), file).toBe(true);
      expect(text.includes('人员与能力以实时数据为准；负责人更换后，策略风格随之调整。'), file).toBe(true);
      const riskLine = text.match(/风险偏好:\n- ([^\n]+)/)?.[1] ?? '';
      const risk = team.staff.strategist.abilities.risk;
      const expectedLabel = risk <= 69 ? '偏低' : risk <= 72 ? '中等，' : risk <= 77 ? '中等偏高' : '高，';
      expect(riskLine, `${file}: risk=${risk}`).toContain(expectedLabel);
      for (const heading of strategySections) expect(text.includes(heading), `${file}: ${heading}`).toBe(true);
    }
  });

  it('玩家专属机制在具体规则行显式限定车队作用域', () => {
    for (const file of [...strategyFiles, ...staffFiles]) {
      for (const line of source(file).split('\n')) {
        if (mechanicFragments.some(fragment => line.includes(fragment))) {
          expect(line, `${file}: ${line}`).toMatch(/^- 玩家执掌本队时，/);
        }
      }
    }
  });

  it('核心组收录赛道人员和储备车手，但不重复正式车手或独立管理层人物', () => {
    for (const team of teams) {
      const file = `lore-staff-${slugs[team.id]}.md`;
      const text = source(file);
      expect(text.startsWith(`<核心人员组资料 team="${team.name.replace('车队', '')}" year="2026">`), file).toBe(true);
      expect(text.trimEnd().endsWith('</核心人员组资料>'), file).toBe(true);
      expect(text.includes(team.staff.raceEngineer.name), `${file}: ${team.staff.raceEngineer.name}`).toBe(true);
      expect(text.includes(team.staff.raceEngineer2.name), `${file}: ${team.staff.raceEngineer2.name}`).toBe(true);
      expect(text.includes('玩家关系与专属机制只在实时数据表明玩家执掌本队时生效'), file).toBe(true);
      for (const heading of staffSections) expect(text.includes(heading), `${file}: ${heading}`).toBe(true);

      for (const driver of drivers.filter(driver => driver.team === team.id && driver.role === 'race')) {
        expect(text.includes(driver.name), `${file} 不应重复正式车手 ${driver.name}`).toBe(false);
      }
      for (const leader of leadershipNames) {
        expect(text.includes(leader), `${file} 不应重复独立管理层 ${leader}`).toBe(false);
      }
      for (const reserve of drivers.filter(driver => driver.team === team.id && driver.role !== 'race')) {
        expect(text.includes(reserve.name), `${file} 应包含储备车手 ${reserve.name}`).toBe(true);
      }
    }

    const ferrari = source('lore-staff-ferrari.md');
    expect(ferrari).toContain('马泰奥·托尼纳利');
    expect(ferrari).toContain('恩里科·瓜尔蒂耶里');
  });

  it('每支 2026 车队都有可用储备车手和对应人物资料', () => {
    for (const team of teams) {
      const reserves = drivers.filter(driver => driver.team === team.id && driver.role === 'reserve').map(driver => driver.name);
      expect(reserves, team.id).toEqual(expectedReserves[team.id]);
    }
    expect(source('lore-staff-audi.md')).toContain('泰奥·普尔谢尔');
    expect(source('lore-staff-racing-bulls.md')).toContain('角田裕毅');
  });
});
