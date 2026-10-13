import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const newGame = readFileSync('src/ui/panel/views/NewGame.vue', 'utf8');
const app = readFileSync('src/ui/panel/App.vue', 'utf8');
const panel = readFileSync('src/ui/panel/components/SupernaturalPanel.vue', 'utf8');
const saves = readFileSync('src/ui/panel/views/Saves.vue', 'utf8');

describe('超自然人设前端', () => {
  it('在开局首屏提供默认关闭且持久化到新游戏的开关', () => {
    expect(newGame).toContain('const supernaturalMode = ref(false)');
    expect(newGame).toContain('supernaturalMode: supernaturalMode.value');
    expect(newGame).toContain('普通聊天和“让 AI 叙述”不会自动发动能力');
  });

  it('在桌面和移动更多菜单提供显式入口', () => {
    expect(app.match(/view\.supernatural\.enabled/g)).toHaveLength(2);
    expect(app).toContain('<SupernaturalPanel');
  });

  it('展示真实硬上限、所选 API、严格结果和键盘关闭', () => {
    expect(panel).toContain('supernatural.value?.caps');
    expect(panel).toContain('api.getSettings()');
    expect(panel).toContain('requestSupernaturalIntervention');
    expect(panel).toContain("event.key === 'Escape'");
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('maxlength="1000"');
  });

  it('允许在前端直接填写副 API 站点、Key 和模型', () => {
    expect(saves).toContain('settings.engineerApiUrl');
    expect(saves).toContain('settings.engineerApiKey');
    expect(saves).toContain('settings.engineerModel');
    expect(saves).toContain(':type="showApiKey ? \'text\' : \'password\'"');
    expect(saves).toContain('填写代理预设后将只使用该预设');
    expect(saves).toContain('if (saved)');
  });
});
