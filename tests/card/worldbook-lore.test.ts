import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = resolve(__dirname, '../../src/card/worldbook');
const drivers = YAML.parse(readFileSync(resolve(ROOT, 'data-drivers.yaml'), 'utf8')).drivers as Array<{
  id: string;
  name: string;
  team: string;
  role: string;
}>;
const teams = YAML.parse(readFileSync(resolve(ROOT, 'data-teams.yaml'), 'utf8')).teams as Array<{ id: string; name: string }>;
const teamFiles: Record<string, string> = {
  mercedes: 'lore-mercedes.md', mclaren: 'lore-mclaren.md', red_bull: 'lore-redbull.md', ferrari: 'lore-ferrari.md',
  williams: 'lore-williams.md', racing_bulls: 'lore-racing-bulls.md', aston_martin: 'lore-aston-martin.md', haas: 'lore-haas.md',
  audi: 'lore-audi.md', alpine: 'lore-alpine.md', cadillac: 'lore-cadillac.md',
};
const prohibited = /——|似乎|仿佛|宛如|如同|几乎|近似|不是.*?(?:而是|只是)|极其|极大|本卡|写作要点|暂不展开|素材池|戏剧用途|核心冲突_/;

describe('2026 世界书资料', () => {
  it('forbids narration from exposing internal staff ratings', () => {
    const rules = readFileSync(resolve(ROOT, 'narrator-rules.md'), 'utf8');
    expect(rules).toContain('能力分、技能分、等级、内部评分');
    expect(rules).toContain('某个 XX 分水平的工程师做了某事');
    expect(rules).toContain('只能用姓名、职务、实际言行和定性表现来叙述');
  });

  it('为 11 支车队提供统一结构的独立条目', () => {
    expect(teams).toHaveLength(11);
    expect(Object.keys(teamFiles)).toEqual(expect.arrayContaining(teams.map(team => team.id)));
    for (const team of teams) {
      const file = teamFiles[team.id];
      const content = readFileSync(resolve(ROOT, file), 'utf8');
      expect(content).toMatch(/^<车队资料 name=".+" year="2026">/);
      for (const section of ['车队身份:', '2026 形势:', '管理文化:', '技术档案:', '关键人员:', '正式车手:', '玩家角色压力:', '叙事指引:']) {
        expect(content, `${file} 缺少 ${section}`).toContain(section);
      }
      expect(content).toMatch(/<\/车队资料>\s*$/);
      expect(content).not.toMatch(prohibited);
      expect(content).not.toMatch(/一号车手|二号车手/);
      expect(content).toContain('实时数据表明玩家执掌本队时生效');
      const raceDrivers = drivers.filter(driver => driver.role === 'race' && driver.team === team.id);
      expect(raceDrivers).toHaveLength(2);
      for (const driver of raceDrivers) expect(content).toContain(driver.name);
    }
  });

  it('为恰好 22 名正式车手提供独立条目', () => {
    const raceDrivers = drivers.filter(driver => driver.role === 'race');
    const files = readdirSync(ROOT).filter(file => file.startsWith('lore-driver-') && file.endsWith('.md'));
    expect(raceDrivers).toHaveLength(22);
    expect(files).toHaveLength(22);
    for (const driver of raceDrivers) {
      const file = `lore-driver-${driver.id}.md`;
      const content = readFileSync(resolve(ROOT, file), 'utf8');
      expect(content).toContain(`<车手资料 name="${driver.name}" year="2026">`);
      for (const field of ['身份与背景', '性格与说话方式', '驾驶强项与短板', '队友与车队关系', '管理触发点', '无线电与叙述指引']) {
        expect(content, `${file} 缺少 ${field}`).toContain(`- ${field}：`);
      }
      expect(content).toMatch(/<\/车手资料>\s*$/);
      expect(content).not.toMatch(prohibited);
    }
    expect(readFileSync(resolve(ROOT, 'lore-driver-verstappen.md'), 'utf8')).toContain('仅在玩家执掌红牛时');
    expect(readFileSync(resolve(ROOT, 'lore-driver-hamilton.md'), 'utf8')).toContain('仅在玩家执掌法拉利时');
    expect(readFileSync(resolve(ROOT, 'lore-driver-leclerc.md'), 'utf8')).toContain('仅在玩家执掌法拉利时');
    expect(readFileSync(resolve(ROOT, 'lore-driver-stroll.md'), 'utf8')).toContain('仅在玩家执掌阿斯顿·马丁时');
  });
});
