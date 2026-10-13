import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve('src/card/worldbook');
const files = readdirSync(dir).filter(name => /^lore-leadership-.*\.md$/.test(name)).sort();
const required = ['职位与职责:', '性格与说话方式:', '决策偏好:', '与玩家关系:', '剧情触发点:', '叙事指引:'];

describe('管理层世界书', () => {
  it('11 支车队各有两名核心管理层人物', () => {
    expect(files).toHaveLength(22);
    const teams = new Map<string, number>();
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      const team = text.match(/^<管理层资料 name="[^"]+" team="([^"]+)" year="2026">/)?.[1];
      expect(team, file).toBeTruthy();
      teams.set(team!, (teams.get(team!) ?? 0) + 1);
    }
    expect([...teams.values()]).toHaveLength(11);
    expect([...teams.values()].every(count => count === 2)).toBe(true);
  });

  it('每个条目都有完整标签和六个必需章节', () => {
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      expect(text.trimEnd().endsWith('</管理层资料>'), file).toBe(true);
      expect(text.includes('玩家关系与专属机制只在实时数据表明玩家执掌本队时生效'), file).toBe(true);
      for (const heading of required) expect(text.includes(heading), `${file}: ${heading}`).toBe(true);
    }
  });
});
