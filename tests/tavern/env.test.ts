import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTavernEnv } from '../../src/tavern/env';

describe('酒馆环境独立生成', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('把前端填写的副 API 站点、Key 和模型交给酒馆助手', async () => {
    const generateRaw = vi.fn(async () => '  测试响应  ');
    vi.stubGlobal('generateRaw', generateRaw);

    const result = await createTavernEnv().generateText('系统提示', {
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'secret-key',
      model: 'test-model',
    });

    expect(result).toBe('测试响应');
    expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({
      custom_api: {
        apiurl: 'https://api.example.com/v1',
        key: 'secret-key',
        model: 'test-model',
        source: 'openai',
      },
    }));
  });

  it('保留代理预设的优先配置', async () => {
    const generateRaw = vi.fn(async () => 'ok');
    vi.stubGlobal('generateRaw', generateRaw);

    await createTavernEnv().generateText('系统提示', {
      proxyPreset: '副线预设',
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'fallback-key',
      model: 'test-model',
    });

    expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({
      custom_api: { proxy_preset: '副线预设', model: 'test-model' },
    }));
  });

  it('设备存储不可用时返回明确错误', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new Error('quota'); }),
      removeItem: vi.fn(() => { throw new Error('blocked'); }),
    });

    const env = createTavernEnv();
    expect(() => env.setLocalSecret('secondary-api-key', 'secret')).toThrow('浏览器无法保存副 API Key');
    expect(() => env.setLocalSecret('secondary-api-key', '')).toThrow('浏览器无法保存副 API Key');
  });
});

describe('酒馆环境世界书写入', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('按精确条目名恢复或禁用管理层条目，并保留完整条目数据', async () => {
    const entries = [
      { uid: 40, name: '[F1M管理层] [mercedes:principal] 托托·沃尔夫', content: 'a', enabled: false, extra: 'keep' },
      { uid: 42, name: '[F1M管理层] [mclaren:principal] 安德里亚·斯特拉', content: 'b', enabled: true, extra: 'keep' },
      { uid: 1, name: '[F1M数据] 规则', content: 'c', enabled: false },
    ];
    const replaceWorldbook = vi.fn(async () => undefined);
    vi.stubGlobal('getCharWorldbookNames', () => ({ primary: 'F1 领队模拟器', additional: [] }));
    vi.stubGlobal('getGlobalWorldbookNames', () => ['F1 领队模拟器']);
    vi.stubGlobal('getWorldbook', async () => structuredClone(entries));
    vi.stubGlobal('replaceWorldbook', replaceWorldbook);

    const result = await createTavernEnv().syncWorldbookEntryStates('[F1M管理层]', [entries[0].name, entries[1].name], [entries[1].name]);

    expect(result).toEqual({ found: 2, changed: 2, failed: 0 });
    expect(replaceWorldbook).toHaveBeenCalledTimes(1);
    expect(replaceWorldbook).toHaveBeenCalledWith('F1 领队模拟器', [
      { ...entries[0], enabled: true },
      { ...entries[1], enabled: false },
      entries[2],
    ], { render: 'debounced' });
  });

  it('缺少世界书写入 API 时安全跳过', async () => {
    vi.stubGlobal('getWorldbook', async () => []);
    const result = await createTavernEnv().syncWorldbookEntryStates('[F1M管理层]', [], []);
    expect(result).toEqual({ found: 0, changed: 0, failed: 0 });
  });

  it('不改动脚本未管理的条目，且无变化时不写回世界书', async () => {
    const managed = '[F1M管理层] [mclaren:principal] 安德里亚·斯特拉';
    const manual = '[F1M管理层] [mercedes:principal] 托托·沃尔夫';
    const replaceWorldbook = vi.fn(async () => undefined);
    vi.stubGlobal('getCharWorldbookNames', () => ({ primary: 'book', additional: [] }));
    vi.stubGlobal('getGlobalWorldbookNames', () => ['book']);
    vi.stubGlobal('getWorldbook', async () => [
      { uid: 42, name: managed, content: '', enabled: false },
      { uid: 40, name: manual, content: '', enabled: false },
    ]);
    vi.stubGlobal('replaceWorldbook', replaceWorldbook);

    const result = await createTavernEnv().syncWorldbookEntryStates('[F1M管理层]', [managed], [managed]);
    expect(result).toEqual({ found: 1, changed: 0, failed: 0 });
    expect(replaceWorldbook).not.toHaveBeenCalled();
  });
});
