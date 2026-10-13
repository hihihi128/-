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
    strategist: { name: string };
  };
}>;
const drivers = YAML.parse(readFileSync(path.join(dir, 'data-drivers.yaml'), 'utf8')).drivers as Array<{ name: string; team: string; role: string }>;
const slugs: Record<string, string> = {
  mercedes: 'mercedes', mclaren: 'mclaren', red_bull: 'red-bull', ferrari: 'ferrari', williams: 'williams',
  racing_bulls: 'racing-bulls', aston_martin: 'aston-martin', haas: 'haas', audi: 'audi', alpine: 'alpine', cadillac: 'cadillac',
};
const strategySections = ['负责人:', '决策风格:', '数据优势:', '风险偏好:', '沟通流程:', '常见失误与剧情触发:', '叙事指引:'];
const staffSections = ['组成人员:', '技术分工:', '赛道执行:', '储备与后备:', '内部协作:', '玩家关系:', '叙事指引:'];
const leadershipNames = readdirSync(dir)
  .filter(name => /^lore-leadership-.*\.md$/.test(name))
  .map(name => readFileSync(path.join(dir, name), 'utf8').match(/^<管理层资料 name="([^"]+)"/)?.[1])
  .filter((name): name is string => Boolean(name));

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

  it('策略组包含负责人、团队风格、作用域和完整标签', () => {
    for (const team of teams) {
      const file = `lore-strategy-${slugs[team.id]}.md`;
      const text = source(file);
      expect(text.startsWith(`<策略组资料 team="${team.name.replace('车队', '')}" year="2026">`), file).toBe(true);
      expect(text.trimEnd().endsWith('</策略组资料>'), file).toBe(true);
      expect(text.includes(team.staff.strategist.name), `${file}: ${team.staff.strategist.name}`).toBe(true);
      expect(text.includes('玩家关系与专属机制只在实时数据表明玩家执掌本队时生效'), file).toBe(true);
      for (const heading of strategySections) expect(text.includes(heading), `${file}: ${heading}`).toBe(true);
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
  });
});
