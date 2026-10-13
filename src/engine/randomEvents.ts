import { addNarration, addNews, playerTeam } from './log';
import { Rng } from './rng';
import type { GameState, RandomEventKind, RandomEventRecord } from './types';
import { clamp, pushCapped, round1 } from './util';

function weightedKind(state: GameState, rng: Rng): RandomEventKind {
  const r = state.rules.randomEvents;
  const rows: Array<[RandomEventKind, number]> = [['none', r.noneWeight], ['driver_injury', r.driverInjuryWeight], ['wind_tunnel_data', r.windTunnelWeight], ['part_issue', r.partIssueWeight]];
  let roll = rng.next() * rows.reduce((sum, row) => sum + Math.max(0, row[1]), 0);
  for (const [kind, weight] of rows) { roll -= Math.max(0, weight); if (roll <= 0) return kind; }
  return 'none';
}

export function triggerWeekendRandomEvent(state: GameState, rng: Rng): void {
  const key = `${state.season.number}-${state.season.roundIndex}`;
  state.randomEvents ??= { lastRoundKey: null, current: null, history: [] };
  if (state.randomEvents.lastRoundKey === key) return;
  const team = playerTeam(state);
  const kind = weightedKind(state, rng);
  let record: RandomEventRecord;
  if (kind === 'driver_injury') {
    const drivers = team.cars.map(car => state.drivers[car.driverId ?? '']).filter(Boolean);
    const driver = drivers[rng.int(0, Math.max(0, drivers.length - 1))];
    const loss = rng.int(8, 18);
    if (driver) driver.fitness = round1(clamp(driver.fitness - loss, 0, 100));
    record = { roundKey: key, kind, title: '车手在场外受伤', detail: `${driver?.name ?? '一名车手'}在自由活动中受伤，体能下降 ${loss} 点。车手仍可参赛，但状态会受影响。` };
  } else if (kind === 'wind_tunnel_data') {
    const project = team.projects.find(value => value.kind === 'design' && value.partType && state.rules.parts[value.partType]?.aero);
    const hours = Math.min(team.aeroHours, rng.int(4, 10));
    team.aeroHours = Math.max(0, team.aeroHours - hours);
    if (project) { project.weeksLeft += 1; project.weeksTotal += 1; }
    record = { roundKey: key, kind, title: '风洞数据异常', detail: `工程团队发现风洞相关性偏差，损失 ${hours} 小时时长${project ? `，${project.label} 延期 1 周` : ''}。` };
  } else if (kind === 'part_issue') {
    const car = team.cars[rng.int(0, Math.max(0, team.cars.length - 1))];
    const types = Object.keys(car?.fitted ?? {});
    const type = types[rng.int(0, Math.max(0, types.length - 1))];
    const spec = team.parts[type]?.specs.find(value => value.id === car?.fitted[type]);
    const loss = rng.int(2, 5);
    if (spec) spec.rel = round1(clamp(spec.rel - loss, 1, 100));
    record = { roundKey: key, kind, title: '新部件检查不合格', detail: `${state.rules.parts[type]?.name ?? '部件'}发现材料或装配问题，当前规格可靠性下降 ${loss} 点。` };
  } else record = { roundKey: key, kind, title: '平静的比赛周', detail: '本周没有发生需要领队处理的额外事件。' };
  state.randomEvents.lastRoundKey = key;
  state.randomEvents.current = record;
  pushCapped(state.randomEvents.history, record, 12);
  if (kind !== 'none') { addNews(state, '随机事件', record.detail); addNarration(state, 'random_event', record.title, record.detail); }
}
