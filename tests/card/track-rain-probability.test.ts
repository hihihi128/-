import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

describe('2026 赛道降雨概率', () => {
  it('保持调整后的 50% 基础降雨概率', () => {
    const file = resolve(__dirname, '../../src/card/worldbook/data-tracks.yaml');
    const tracks = YAML.parse(readFileSync(file, 'utf8')).tracks as Array<{ id: string; rainChance: number }>;
    expect(Object.fromEntries(tracks.map(track => [track.id, track.rainChance]))).toEqual({
      melbourne: 0.14,
      shanghai: 0.135,
      suzuka: 0.16,
      bahrain: 0.005,
      jeddah: 0.01,
      miami: 0.125,
      montreal: 0.155,
      monaco: 0.11,
      barcelona: 0.06,
      spielberg: 0.14,
      silverstone: 0.21,
      spa: 0.24,
      hungaroring: 0.12,
      zandvoort: 0.175,
      monza: 0.09,
      madrid: 0.075,
      baku: 0.04,
      singapore: 0.19,
      cota: 0.1,
      mexico: 0.09,
      interlagos: 0.22,
      las_vegas: 0.02,
      lusail: 0.005,
      yas_marina: 0.005,
    });
  });
});
