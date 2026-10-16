import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

describe('2026 赛道降雨概率', () => {
  it('保持调整后的 50% 基础降雨概率', () => {
    const file = resolve(__dirname, '../../src/card/worldbook/data-tracks.yaml');
    const tracks = YAML.parse(readFileSync(file, 'utf8')).tracks as Array<{ id: string; rainChance: number }>;
    const baseline = {
      melbourne: 0.28, shanghai: 0.27, suzuka: 0.32, bahrain: 0.01, jeddah: 0.02, miami: 0.25,
      montreal: 0.31, monaco: 0.22, barcelona: 0.12, spielberg: 0.28, silverstone: 0.42, spa: 0.48,
      hungaroring: 0.24, zandvoort: 0.35, monza: 0.18, madrid: 0.15, baku: 0.08, singapore: 0.38,
      cota: 0.2, mexico: 0.18, interlagos: 0.44, las_vegas: 0.04, lusail: 0.01, yas_marina: 0.01,
    };
    expect(tracks).toHaveLength(24);
    expect(tracks.map(track => track.id).sort()).toEqual(Object.keys(baseline).sort());
    for (const track of tracks) {
      expect(track.rainChance).toBe(baseline[track.id as keyof typeof baseline] / 2);
      expect(track.rainChance).toBeGreaterThanOrEqual(0);
      expect(track.rainChance).toBeLessThanOrEqual(1);
    }
  });
});
