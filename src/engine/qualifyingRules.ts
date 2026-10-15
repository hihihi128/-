import type { QualifyingSector, TrackDef } from './types';
import { clamp, round3 } from './util';

export const QUALIFYING_TICKS_PER_SECOND = 10;
export const QUALIFYING_MAX_ADVANCE_TICKS = 80;

export function qualifyingDurationTicks(kind: 'qualifying' | 'sprint_qualifying', segmentIndex: number): number {
  const minutes = kind === 'qualifying' ? [18, 15, 12] : [12, 10, 8];
  return (minutes[Math.min(segmentIndex, minutes.length - 1)] ?? minutes[0]) * 60 * QUALIFYING_TICKS_PER_SECOND;
}

export function qualifyingRunAllowance(kind: 'qualifying' | 'sprint_qualifying', segmentCount: number): number {
  return kind === 'sprint_qualifying' ? 1 : segmentCount === 1 ? 3 : 2;
}

export function resolvedQualifyingSectors(track: TrackDef): QualifyingSector[] {
  const source = Array.isArray(track.qualifyingSectors) && track.qualifyingSectors.length
    ? track.qualifyingSectors
    : [
        { endProgress: 1 / 3, timeWeight: 0.34, trafficSensitivity: 1.15, yieldSeconds: 1.8 },
        { endProgress: 2 / 3, timeWeight: 0.36, trafficSensitivity: 1.3, yieldSeconds: 2.2 },
        { endProgress: 1, timeWeight: 0.3, trafficSensitivity: 0.85, yieldSeconds: 1.2 },
      ];
  const total = source.reduce((sum, sector) => sum + Math.max(0.001, Number(sector.timeWeight) || 0), 0);
  return source.map((sector, index) => ({
    endProgress: index === source.length - 1 ? 1 : round3(clamp(Number(sector.endProgress) || 0, 0.001, 0.999)),
    timeWeight: round3(Math.max(0.001, Number(sector.timeWeight) || 0) / total),
    trafficSensitivity: round3(clamp(Number(sector.trafficSensitivity) || 1, 0, 3)),
    yieldSeconds: round3(clamp(Number(sector.yieldSeconds) || 0, 0, 10)),
  }));
}

export function qualifyingSectorIndex(sectors: QualifyingSector[], progress: number): number {
  const p = ((progress % 1) + 1) % 1;
  const index = sectors.findIndex(sector => p < sector.endProgress);
  return index < 0 ? Math.max(0, sectors.length - 1) : index;
}
