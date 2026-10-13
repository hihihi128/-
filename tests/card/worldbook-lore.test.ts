import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = resolve(__dirname, '../../src/card/worldbook');
const drivers = YAML.parse(readFileSync(resolve(ROOT, 'data-drivers.yaml'), 'utf8')).drivers as Array<{
  id: string;
  name: string;
  role: string;
}>;
const teamFiles = [
  'lore-mercedes.md', 'lore-mclaren.md', 'lore-redbull.md', 'lore-ferrari.md', 'lore-williams.md',
  'lore-racing-bulls.md', 'lore-aston-martin.md', 'lore-haas.md', 'lore-audi.md', 'lore-alpine.md', 'lore-cadillac.md',
];
const prohibited = /——|似乎|仿佛|宛如|如同|几乎|近似|不是.*?(?:而是|只是)|极其|极大|本卡|写作要点|暂不展开|素材池|戏剧用途|核心冲突_/;

describe('2026 世界书资料', () => {
  it('为 11 支车队提供统一结构的独立条目', () => {
    expect(teamFiles).toHaveLength(11);
    for (const file of teamFiles) {
      const content = readFileSync(resolve(ROOT, file), 'utf8');
      expect(content).toMatch(/^<车队资料 name=".+" year="2026">/);
      for (const section of ['车队身份:', '2026 形势:', '管理文化:', '技术档案:', '关键人员:', '正式车手:', '玩家角色压力:', '叙事指引:']) {
        expect(content, `${file} 缺少 ${section}`).toContain(section);
      }
      expect(content).toMatch(/<\/车队资料>\s*$/);
      expect(content).not.toMatch(prohibited);
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
  });
});
