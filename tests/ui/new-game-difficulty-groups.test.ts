// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import { normalizeDatabase } from '../../src/engine/data';
import NewGame from '../../src/ui/panel/views/NewGame.vue';
import { cardSources } from '../helpers';

const expected = {
  easy: ['梅赛德斯车队', '法拉利车队', '小红牛车队', '阿尔派车队'],
  medium: ['迈凯伦车队', '红牛车队', '哈斯车队', '奥迪车队'],
  hard: ['威廉姆斯车队', '阿斯顿·马丁车队', '凯迪拉克车队'],
};

afterEach(() => {
  delete (window as any).F1Manager;
  document.body.replaceChildren();
});

describe('开局选队难度分组', () => {
  it('世界书为每支车队提供选队难度', () => {
    const loaded = normalizeDatabase(cardSources());
    const groups = { easy: [] as string[], medium: [] as string[], hard: [] as string[] };
    for (const team of loaded.db!.teams) groups[team.selectionDifficulty].push(team.name);
    expect(groups).toEqual(expected);
  });

  it('按简单、中等、困难顺序分组，并分别使用蓝、黄、红框', async () => {
    const loaded = normalizeDatabase(cardSources());
    const teams = loaded.db!.teams.map(t => ({
      id: t.id,
      name: t.name,
      color: t.color,
      targetPosition: t.targetPosition,
      selectionDifficulty: t.selectionDifficulty,
      description: '',
      special: t.special,
      drivers: [],
    }));
    (window as any).F1Manager = {
      loadData: () => ({ ok: true, origin: '测试', entries: [], issues: [], teams, summary: '' }),
    };
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(NewGame);
    app.mount(host);
    await new Promise(resolve => setTimeout(resolve, 0));
    await nextTick();

    const sections = [...host.querySelectorAll<HTMLElement>('.team-group')];
    expect(sections.map(s => s.dataset.difficulty)).toEqual(['easy', 'medium', 'hard']);
    expect(sections.map(s => s.querySelector('.group-head b')?.textContent)).toEqual(['简单车队', '中等车队', '困难车队']);
    for (const section of sections) {
      const names = [...section.querySelectorAll('.team-card b')].map(b => b.textContent);
      expect(names).toEqual(expected[section.dataset.difficulty as keyof typeof expected]);
    }
    app.unmount();
  });

  it('缺失或未知的选队难度回退为中等并给出提示', () => {
    const sources = cardSources();
    const teamSource = sources.find(s => Array.isArray((s.data as { teams?: unknown })?.teams))!;
    const teams = (teamSource.data as { teams: Array<Record<string, unknown>> }).teams;
    teams.find(t => t.id === 'mercedes')!.selectionDifficulty = 'extreme';
    const loaded = normalizeDatabase(sources);
    expect(loaded.db!.teams.find(t => t.id === 'mercedes')!.selectionDifficulty).toBe('medium');
    expect(loaded.issues.some(i => i.path.endsWith('selectionDifficulty') && i.level === 'warning')).toBe(true);
  });
});
