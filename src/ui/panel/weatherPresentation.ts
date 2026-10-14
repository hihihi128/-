export type IntensityRange = [number, number];

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function boundedPercent(value: number): number | null {
  return Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value * 100))) : null;
}

export function validRange(range: IntensityRange): [number, number] | null {
  const low = boundedPercent(range[0]);
  const high = boundedPercent(range[1]);
  return low === null || high === null || low > high ? null : [Math.round(low), Math.round(high)];
}

/** Positions a relative future-lap interval as complete cells on a clipped timeline. */
export function lapWindowStyle(range: [number, number] | null, visibleLaps: number): Record<string, string> | null {
  if (!range || !Number.isFinite(visibleLaps) || visibleLaps < 1 || !range.every(Number.isFinite) || range[0] > range[1] || range[1] < 1 || range[0] > visibleLaps) return null;
  const low = Math.max(1, range[0]);
  const high = Math.min(visibleLaps, range[1]);
  return { left: `${((low - 1) / visibleLaps) * 100}%`, width: `${((high - low + 1) / visibleLaps) * 100}%` };
}

export function intensitySegments(value: number, count = 10): number[] {
  const bounded = boundedPercent(value);
  if (bounded === null) return [];
  return Array.from({ length: count }, (_, index) => Math.min(1, Math.max(0, (bounded - index * (100 / count)) / (100 / count))));
}

export function clippedInterval(range: [number, number] | null, start: number, end: number): [number, number] | null {
  if (!range || !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || end <= start || range[0] > range[1] || range[1] < start || range[0] > end) return null;
  const low = Math.max(start, Math.min(end, range[0]));
  const high = Math.max(start, Math.min(end, range[1]));
  return [low, high];
}

export function intervalStyle(range: [number, number] | null, start: number, end: number): Record<string, string> | null {
  const clipped = clippedInterval(range, start, end);
  if (!clipped) return null;
  const length = end - start;
  return {
    left: `${((clipped[0] - start) / length) * 100}%`,
    width: `${Math.max(1, ((clipped[1] - clipped[0]) / length) * 100)}%`,
  };
}

export function forecastSummary(issuedLap: number, horizonLaps: number, range: IntensityRange, arrival: [number, number] | null, probability: number, confidence: number): string {
  const intensity = validRange(range);
  const arrivalText = arrival ? `可能在 ${arrival[0]} 至 ${arrival[1]} 圈后到达` : '暂无明确降雨窗口';
  return `第 ${issuedLap} 圈发布，未来 ${horizonLaps} 圈预报。${intensity ? `降雨强度范围 ${intensity[0]}% 至 ${intensity[1]}%。` : '降雨强度范围暂不可用。'}降雨概率 ${percent(probability)}，预报置信度 ${percent(confidence)}。${arrivalText}；预报存在不确定性。`;
}
