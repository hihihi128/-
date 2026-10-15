/**
 * 法拉利特殊机制。比赛效果对法拉利始终生效，交互操作只属于玩家车队。
 *
 * - 媒体支持率：直接使用车队的 mediaReputation。法拉利的媒体更苛刻：
 *   每站正赛后固定消耗一点耐心，成绩带来的涨跌也更大。
 * - 粉丝意见：两位正式车手各有一个粉丝阵营（满意度 0~100）。
 *   升级件分配、优先车手、车队指令、正赛成绩、换下车手都会影响两边的满意度。
 * - 撤职：正赛后检查。媒体支持率低于下限，或两边粉丝满意度差距超过上限 → 撤销领队职务。
 */
import { addNarration, addNews, driverName, playerTeam } from './log';
import type { ClassificationEntry, FerrariState, GameState, RaceResult } from './types';
import { clamp, pushCapped, round1, stamp } from './util';

const LOG_CAP = 8;

/** 当前存档是否启用了法拉利机制（且尚未撤职） */
export function ferrariActive(state: GameState): state is GameState & { ferrari: FerrariState } {
  return !!state.ferrari && !state.ferrari.dismissed;
}

/** 开局：玩家选择了 special = ferrari 的车队时初始化 */
export function initFerrari(state: GameState, preserveExisting = false): void {
  const ferrari = Object.values(state.teams).find(value => value.special === 'ferrari');
  const raceDrivers = ferrari?.cars.map(c => c.driverId).filter((id): id is string => !!id) ?? [];
  if (!ferrari || raceDrivers.length < 2) {
    if (!preserveExisting) state.ferrari = null;
    return;
  }
  if (preserveExisting && state.ferrari) return;
  const r = state.rules.ferrari;
  ferrari.mediaReputation = r.startMedia;
  state.ferrari = {
    fans: Object.fromEntries(raceDrivers.slice(0, 2).map(id => [id, r.startFans])),
    warned: { media: false, gap: false },
    dismissed: null,
    log: [],
    aduoAlliance: false,
    aduoLobbyGranted: false,
  };
}

/** 两边粉丝满意度的差距 */
export function fanGap(f: FerrariState): number {
  const v = Object.values(f.fans);
  return v.length < 2 ? 0 : round1(Math.max(...v) - Math.min(...v));
}

/** 粉丝阵营的车手 id（按开局顺序） */
export function fanCamps(f: FerrariState): string[] {
  return Object.keys(f.fans);
}

/**
 * 调整粉丝满意度。changes：车手 id → 变化量；不属于粉丝阵营的车手会被忽略。
 * 返回实际生效的可读描述（没有变化时为空字符串）。
 */
export function shiftFans(state: GameState, changes: Record<string, number>, why: string): string {
  if (!ferrariActive(state)) return '';
  const f = state.ferrari;
  const bits: string[] = [];
  for (const [id, delta] of Object.entries(changes)) {
    if (!(id in f.fans) || !Number.isFinite(delta)) continue;
    const before = f.fans[id];
    f.fans[id] = round1(clamp(before + delta, 0, 100));
    const applied = round1(f.fans[id] - before);
    if (applied !== 0) bits.push(`${driverName(state, id)}粉丝 ${applied > 0 ? '+' : ''}${applied}`);
  }
  if (!bits.length) return '';
  const text = `${why}：${bits.join('，')}`;
  pushCapped(f.log, { at: stamp(state), text }, LOG_CAP);
  return text;
}

/** 调整媒体支持率（法拉利），返回实际变化 */
function shiftMedia(state: GameState, delta: number, why: string): number {
  const team = Object.values(state.teams).find(value => value.special === 'ferrari');
  if (!team) return 0;
  const before = team.mediaReputation;
  team.mediaReputation = round1(clamp(before + delta, 0, 100));
  const applied = round1(team.mediaReputation - before);
  if (applied !== 0 && state.ferrari) {
    pushCapped(state.ferrari.log, { at: stamp(state), text: `${why}：媒体支持率 ${applied > 0 ? '+' : ''}${applied}` }, LOG_CAP);
  }
  return applied;
}

/** 指定 / 取消优先车手 */
export function ferrariOnPriority(state: GameState, driverId: string | null): void {
  if (playerTeam(state).special !== 'ferrari' || !ferrariActive(state)) return;
  const amt = state.rules.ferrari.priorityFans;
  const changes: Record<string, number> = {};
  for (const id of fanCamps(state.ferrari)) {
    if (driverId === null) changes[id] = 1;
    else changes[id] = id === driverId ? amt : -amt * 1.2;
  }
  const text = shiftFans(state, changes, driverId ? `${driverName(state, driverId)} 被确立为优先车手` : '取消优先车手');
  if (text) addNews(state, '粉丝', text);
}

/** 把一位正式车手换下（启用替补） */
export function ferrariOnBench(state: GameState, benchedId: string, inId: string): void {
  if (playerTeam(state).special !== 'ferrari' || !ferrariActive(state) || !(benchedId in state.ferrari.fans)) return;
  const text = shiftFans(state, { [benchedId]: -state.rules.ferrari.priorityFans * 1.5 }, `${driverName(state, benchedId)} 被 ${driverName(state, inId)} 换下`);
  if (text) addNews(state, '粉丝', text);
}

/**
 * 正赛前的升级件分配：两台车综合性能差距 gap（≥ 0.4 才会调用）。
 * 拿到好车的一方粉丝满意，另一方粉丝认为车队偏心。
 */
export function ferrariOnAllocation(state: GameState, favoredId: string, slightedId: string, gap: number): string {
  if (playerTeam(state).special !== 'ferrari' || !ferrariActive(state)) return '';
  const amt = state.rules.ferrari.allocationFans * gap;
  return shiftFans(state, { [favoredId]: round1(amt * 0.5), [slightedId]: round1(-amt) }, '升级件分配');
}

/** 车队指令执行结果（粉丝反应写入新闻） */
export function ferrariOnOrder(state: GameState, yieldedId: string, favoredId: string, complied: boolean): void {
  if (playerTeam(state).special !== 'ferrari' || !ferrariActive(state)) return;
  const amt = state.rules.ferrari.orderFans;
  let text: string;
  if (complied) {
    shiftMedia(state, -1, '车队指令引发争议');
    text = shiftFans(state, { [yieldedId]: -amt, [favoredId]: round1(amt * 0.4) }, `${driverName(state, yieldedId)} 被要求让车`);
  } else {
    text = shiftFans(state, { [yieldedId]: 1, [favoredId]: round1(-amt * 0.6) }, `${driverName(state, yieldedId)} 拒绝让车`);
  }
  if (text) addNews(state, '粉丝', text);
}

/** 法拉利媒体对正赛成绩的反应：基础变化 × 倍率 − 每站耐心消耗 */
export function ferrariMediaDelta(state: GameState, base: number): number {
  if (!ferrariActive(state)) return base;
  const r = state.rules.ferrari;
  return round1(base * r.mediaResultMul - r.mediaPerRace);
}

function isMechanical(e: ClassificationEntry): boolean {
  return e.pos === null && /故障|过热/.test(e.reason);
}

/** 正赛后：成绩影响粉丝，然后检查警告与撤职 */
export function ferrariAfterRace(state: GameState, result: RaceResult): void {
  if (!ferrariActive(state) || result.kind !== 'race') return;
  const f = state.ferrari;
  const r = state.rules.ferrari;
  const team = Object.values(state.teams).find(value => value.special === 'ferrari');
  if (!team) return;
  const amt = r.resultFans;
  const camps = fanCamps(f);
  const entries = camps.map(id => result.classification.find(c => c.driverId === id));
  const changes: Record<string, number> = Object.fromEntries(camps.map(id => [id, 0]));
  const notes: string[] = [];

  camps.forEach((id, i) => {
    const e = entries[i];
    if (!e) {
      // 被换下 / 没有参赛：粉丝认为车队在排挤他
      changes[id] -= amt * 2;
      notes.push(`${driverName(state, id)} 没有出赛`);
      return;
    }
    if (e.pos === 1) changes[id] += amt * 2;
    else if (e.pos !== null && e.pos <= 3) changes[id] += amt;
    if (isMechanical(e)) {
      changes[id] -= amt * 2;
      notes.push(`${driverName(state, id)} 机械故障退赛，粉丝怀疑车队不重视他`);
    } else if (e.pos === null) {
      changes[id] -= amt;
    }
  });
  // 队内对比：名次靠后一方的粉丝不满
  const [a, b] = entries;
  if (a && b && a.pos !== null && b.pos !== null) {
    const [ahead, behind] = a.pos < b.pos ? camps : [camps[1], camps[0]];
    changes[ahead] += amt;
    changes[behind] -= amt;
  }
  const fanText = shiftFans(state, changes, `${state.tracks[state.calendar[state.season.roundIndex]?.trackId]?.name ?? '本站'}正赛`);

  // 粉丝内讧会被媒体放大
  const gap = fanGap(f);
  if (gap >= r.warnFanGap) shiftMedia(state, -1, '粉丝内讧登上头条');

  const media = team.mediaReputation;
  // 首个赛季的前 graceRounds 站是适应期：只警告、不撤职
  const inGrace = state.season.number === 1 && state.season.roundIndex + 1 <= r.graceRounds;
  const graceLeft = Math.max(0, r.graceRounds - (state.season.roundIndex + 1));
  let reason: string | null = null;
  if (media < r.minMedia) reason = `媒体支持率跌至 ${media.toFixed(0)}（下限 ${r.minMedia}）`;
  else if (gap > r.maxFanGap) reason = `两位车手的粉丝意见相差 ${gap.toFixed(0)}（上限 ${r.maxFanGap}）`;

  const fansLine = camps.map(id => `${driverName(state, id)}粉丝 ${f.fans[id].toFixed(0)}`).join(' / ');
  if (reason && !inGrace && team.isPlayer) {
    f.dismissed = reason;
    state.flags.fired = true;
    state.flags.firedReason = reason;
    addNews(state, '车队', `法拉利宣布解除 ${state.meta.principalName} 的过渡领队职务：${reason}。`);
    addNarration(
      state,
      'fired',
      '过渡领队被撤职',
      `赛后，埃尔坎召见了 ${state.meta.principalName}，宣布立即撤销其过渡领队职务。原因：${reason}。当前：媒体支持率 ${media.toFixed(0)}，${fansLine}。${fanText ? `本站变化：${fanText}。` : ''}${notes.join('；')}`,
    );
    return;
  }

  const warnings: string[] = [];
  if (reason && inGrace) warnings.push(`${reason}——念在适应期${graceLeft ? `（还剩 ${graceLeft} 站）` : '即将结束'}，埃尔坎暂不追究，之后将不再宽容`);
  if (!reason && media < r.warnMedia) {
    if (!f.warned.media) warnings.push(`媒体支持率只剩 ${media.toFixed(0)}，意大利媒体开始呼吁换人（低于 ${r.minMedia} 将被撤职）`);
    f.warned.media = true;
  } else if (media >= r.warnMedia + 5) f.warned.media = false;
  if (!reason && gap > r.warnFanGap) {
    if (!f.warned.gap) warnings.push(`两边粉丝意见相差 ${gap.toFixed(0)}，社交媒体上的骂战愈演愈烈（超过 ${r.maxFanGap} 将被撤职）`);
    f.warned.gap = true;
  } else if (gap <= r.warnFanGap - 5) f.warned.gap = false;

  if (warnings.length) addNews(state, '媒体', warnings.join('；'));
  if (team.isPlayer) {
    addNarration(
      state,
      'ferrari_pressure',
      warnings.length ? '马拉内罗的压力升级' : '媒体与粉丝的反应',
      [`媒体支持率 ${media.toFixed(0)}，${fansLine}（差距 ${gap.toFixed(0)}）。`, fanText ? `本站变化：${fanText}。` : '', notes.join('；'), warnings.length ? `警告：${warnings.join('；')}。` : '']
        .filter(Boolean)
        .join(''),
    );
  }
}
