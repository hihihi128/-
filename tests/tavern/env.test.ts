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
      custom_api: expect.objectContaining({ proxy_preset: '副线预设' }),
    }));
  });
});
