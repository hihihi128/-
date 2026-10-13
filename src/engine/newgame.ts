/**
 * 开局：由数据库构建初始存档。
 */
import { seedFrom } from './rng';
import type {
  CarState,
  Database,
  Difficulty,
  DriverState,
  GameState,
  PartType,
  Randomness,
  Standings,
  TeamParts,
  TeamState,
} from './types';
import { deepClone, round1 } from './util';
import { aeroAllowance } from './development';
import { recordAduoBaseline } from './aduo';
import { initFerrari } from './ferrari';
import { initTeamSpecials } from './teamSpecials';
import { initNextTeamSpecials } from './nextTeamSpecials';
import { initManagementSpecials } from './managementSpecials';
import { ensureMarket, openMarket } from './market';
import { resetPuUsage } from './powerunit';

export interface NewGameOptions {
  playerTeamId: string;
  principalName: string;
  difficulty?: Difficulty;
  randomness?: Randomness;
  seed?: number;
  gameId?: string;
  now?: number;
  /** 玩家自填的「为什么被选中」（可选，最多 300 字） */
  selectionReason?: string;
  supernaturalMode?: boolean;
}

export const SELECTION_REASON_MAX = 300;

/** 清理玩家填写的入选理由：去掉首尾空白与控制字符，限制长度 */
export function cleanSelectionReason(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, SELECTION_REASON_MAX);
}

export function emptyDriverStanding(rounds: number) {
  return {
    points: 0,
    wins: 0,
    podiums: 0,
    poles: 0,
    fastestLaps: 0,
    dnfs: 0,
    best: null,
    results: new Array(rounds).fill(null),
    sprintPoints: 0,
  };
}

export function emptyStandings(state: Pick<GameState, 'drivers' | 'teamOrder' | 'calendar'>): Standings {
  const rounds = state.calendar.length;
  const standings: Standings = { drivers: {}, teams: {} };
  for (const d of Object.values(state.drivers)) {
    if (d.teamId) standings.drivers[d.id] = emptyDriverStanding(rounds);
  }
  for (const tid of state.teamOrder) standings.teams[tid] = { points: 0, wins: 0, podiums: 0, best: null };
  return standings;
}

export function createGame(db: Database, opts: NewGameOptions): GameState {
  const now = opts.now ?? Date.now();
  const gameId = opts.gameId ?? `g${now.toString(36)}`;
  const selectionReason = cleanSelectionReason(opts.selectionReason);
  if (!db.teams.some(t => t.id === opts.playerTeamId)) {
    throw new Error(`找不到车队「${opts.playerTeamId}」`);
  }
  const rules = deepClone(db.rules);
  const teams: Record<string, TeamState> = {};
  const teamOrder = db.teams.map(t => t.id);

  // 按董事会预期排名估算初始风洞时长
  const expectedRank = [...db.teams].sort((a, b) => a.targetPosition - b.targetPosition).map(t => t.id);

  for (const def of db.teams) {
    const parts: Record<PartType, TeamParts> = {};
    const fitted: Record<PartType, string> = {};
    for (const pt of Object.keys(rules.parts)) {
      const p = def.parts[pt] ?? { perf: 70, rel: 80 };
      const specId = `${pt}-1`;
      parts[pt] = {
        specs: [
          { id: specId, type: pt, version: 1, perf: round1(p.perf), rel: round1(p.rel), verified: true, expected: null, introduced: '初始' },
        ],
        stock: { [specId]: pt === 'front_wing' ? 2 : 1 },
      };
      fitted[pt] = specId;
    }
    const raceDrivers = db.drivers.filter(d => d.teamId === def.id && d.role === 'race');
    const cars: CarState[] = raceDrivers.map((d, i) => ({ slot: i + 1, driverId: d.id, fitted: { ...fitted } }));
    const isPlayer = def.id === opts.playerTeamId;
    teams[def.id] = {
      id: def.id,
      name: def.name,
      short: def.short,
      color: def.color,
      principal: isPlayer ? opts.principalName : def.principal,
      engine: def.engine,
      worksTeam: def.worksTeam,
      puHomologations: 0,
      aduoUpgrades: 0,
      aduoCapBonus: 0,
      aduoTier: 0,
      base: def.base,
      isPlayer,
      funds: def.funds,
      costCapSpent: 0,
      sponsorIncome: def.sponsorIncome,
      operatingCost: def.operatingCost,
      facilities: { ...def.facilities },
      staff: deepClone(def.staff),
      pitCrewTraining: { speed: def.staff.pitCrew.skill, consistency: def.staff.pitCrew.skill, error_control: def.staff.pitCrew.skill },
      tyreInventory: {},
      parts,
      cars,
      projects: [],
      aeroHours: aeroAllowance(rules, expectedRank.indexOf(def.id)),
      driverPriority: null,
      boardConfidence: 60,
      targetPosition: def.targetPosition,
      mediaReputation: 50,
      staffMorale: 65,
      nextSeasonFocus: isPlayer ? 0 : 10,
      description: def.description,
      ...(def.special ? { special: def.special } : {}),
    };
  }

  const drivers: Record<string, DriverState> = {};
  for (const d of db.drivers) {
    drivers[d.id] = {
      ...deepClone(d),
      trust: d.teamId === opts.playerTeamId ? 55 : 50,
      form: 0,
      stats: { starts: 0, wins: 0, podiums: 0, poles: 0, points: 0, dnfs: 0 },
    };
  }

  const state: GameState = {
    schema: 1,
    gameId,
    meta: {
      createdAt: now,
      playerTeamId: opts.playerTeamId,
      principalName: opts.principalName || '领队',
      difficulty: opts.difficulty ?? 'normal',
      randomness: opts.randomness ?? 'deterministic',
      dataSignature: db.signature,
      dataSources: [...db.sources],
      supernaturalMode: opts.supernaturalMode === true,
      ...(selectionReason ? { selectionReason } : {}),
    },
    rng: opts.seed ?? seedFrom(`${gameId}:${db.signature}`),
    seq: 0,
    rules,
    tracks: Object.fromEntries(db.tracks.map(t => [t.id, deepClone(t)])),
    calendar: deepClone(db.calendar),
    season: { year: rules.seasonYear, number: 1, roundIndex: 0, phase: 'preseason', week: 0, weeksUntilRound: 0 },
    teams,
    teamOrder,
    drivers,
    standings: { drivers: {}, teams: {} },
    weekend: null,
    history: [],
    news: [],
    narration: [],
    narrated: [],
    flags: {},
    aiLog: [],
    supernatural: { pendingWeather: null },
    aduo: { evaluations: [] },
    lastSeason: null,
  };
  state.standings = emptyStandings(state);
  ensureMarket(state);
  for (const candidate of db.staffCandidates ?? []) {
    if (!candidate.id || state.market!.freeStaff[candidate.id]) continue;
    state.market!.freeStaff[candidate.id] = deepClone(candidate);
  }
  // A first-season window exposes the same deterministic roster/offer APIs as
  // later offseasons; incumbent contracts are projected into it by default.
  openMarket(state, state.season.year);
  recordAduoBaseline(state);
  for (const d of Object.values(drivers)) {
    resetPuUsage(state, d, d.teamId ? teams[d.teamId]?.cars.find(c => c.driverId === d.id) : undefined);
  }

  const team = teams[opts.playerTeamId];
  const firstTrack = state.tracks[state.calendar[0]?.trackId]?.name ?? '首站';
  const reason = selectionReason.replace(/[。．.!！?？\s]+$/, '');
  const name = state.meta.principalName;
  const reasonLine = reason ? `外界普遍认为 ${name} 被选中的原因是：${reason}。` : '';
  const tail = `距离首站（${firstTrack}）还有 ${state.calendar[0]?.weeksGap ?? 0} 周。董事会对本赛季的目标是车队积分榜第 ${team.targetPosition} 名。`;
  initFerrari(state, team);
  initTeamSpecials(state, team);
  initNextTeamSpecials(state, team);
  initManagementSpecials(state, team);
  let newsText: string;
  let title: string;
  let detail: string[];
  if (state.ferrari) {
    const names = Object.keys(state.ferrari.fans).map(id => drivers[id].name).join('与');
    const fr = rules.ferrari;
    newsText = `法拉利宣布 ${name} 出任 ${state.season.year} 赛季过渡领队，接替被解职的弗雷德·瓦塞尔。`;
    title = '临危受命：法拉利过渡领队';
    detail = [
      `2025 年底，由恩里科·瓜尔蒂耶里主导、为 2026 新规准备的钢制气缸盖发动机方案宣告失败，SF-25 的赛季也是一场灾难。约翰·埃尔坎随即解除了弗雷德·瓦塞尔的领队职务。`,
      `内部继任人选还需要时间考察，埃尔坎把 ${state.season.year} 年定为过渡年，从外部招来一位过渡领队——${name}。`,
      reasonLine,
      `埃尔坎的要求只有两条：稳住意大利媒体（媒体支持率 ${fr.startMedia}，低于 ${fr.minMedia} 即撤职），并让${names}两边的粉丝都满意（粉丝意见差距超过 ${fr.maxFanGap} 即撤职）。`,
      tail,
    ];
  } else if (state.mclaren) {
    newsText = `安德烈亚·斯特拉因交通事故受伤后，扎克·布朗任命 ${name} 为迈凯伦临时领队。`;
    title = '临危受命：迈凯伦临时领队';
    detail = ['2026 年初，安德烈亚·斯特拉驾车时发生事故。他没有生命危险，但至少需要一年恢复。', `扎克·布朗因此招来 ${name} 临时执掌车队。`, reasonLine, 'MCL40 与梅赛德斯动力单元软件存在适配问题。解决前，每场比赛都有动力单元异常放电风险；同时必须控制诺里斯与皮亚斯特里的队内关系。', tail];
  } else if (state.mercedes) {
    newsText = `Toto Wolff 任命 ${name} 为梅赛德斯副领队，并将其列入接班人培养计划。`;
    title = '接班人计划：梅赛德斯副领队';
    detail = [`Toto Wolff 决定培养自己的接班人，${name} 以副领队身份加入梅赛德斯。`, reasonLine, 'W17 的动力单元软件匹配良好，但可靠性不足。车队必须向 FIA 争取 ADUO，同时在政治斗争中保住利用热胀冷缩实现的 1:18 压缩比。', tail];
  } else if (state.redBull) {
    newsText = `红牛任命 ${name} 辅助洛朗·梅基斯管理 2026 赛季。`;
    title = '人手危机：协助梅基斯';
    detail = ['红牛在 2025 年失去大量人才，赫尔穆特·马尔科也被解雇。由于管理与技术人手不足，车队招来玩家辅助梅基斯。', reasonLine, 'RB23 的准备因 2025 年全力争冠而严重不足。车手更容易失误，GP 正与迈凯伦谈判；夏休时若维斯塔潘不在积分榜前三，他将触发解约条款。', tail];
  } else if (state.astonMartin) {
    newsText = `劳伦斯·斯特罗尔撤掉 Jonathan Wheatley，并让 ${name} 接手预计垫底的阿斯顿·马丁。`;
    title = '替罪羊危机：阿斯顿·马丁领队';
    detail = ['2026 年初，AMR26 的预计表现极差。愤怒的老斯特罗尔撤掉 Jonathan Wheatley，并找来玩家与纽维收拾残局。', reasonLine, '本田动力单元预计少约 100 马力，且与车体结合后产生危险振动。首批 ADUO 动力单元到货前，赛车每十圈检查一次并可能为保护车手手部而强制退赛。', '玩家还必须调解本田与纽维，催促适配车体，并在照顾兰斯与避免激怒阿隆索粉丝之间维持平衡。', tail];
  } else if (state.racingBulls) {
    newsText = `${name} 加入小红牛，担任艾伦·佩尔曼的副领队。`;
    title = '临时调度：小红牛副领队';
    detail = ['梅基斯转往红牛后，小红牛请玩家担任副领队，辅佐艾伦·佩尔曼。', reasonLine, '红牛可能因伤病或突发事件临时调走正式车手。事件发生时，玩家必须从储备车手中选人顶替一站。', tail];
  } else if (state.audi) {
    newsText = `比诺托邀请 ${name} 担任奥迪副领队，负责围场政治。`;
    title = '四环入局：奥迪副领队';
    detail = ['Jonathan Wheatley 在 2025 年底转往阿斯顿·马丁。技术背景出身的比诺托上位，并邀请玩家处理车队间政治斗争。', reasonLine, '奥迪自研动力单元存在涡轮问题，修复前起步会随机丢失两到三个位置。玩家可以与阿斯顿·马丁、梅赛德斯和法拉利组成四队联盟，共同争取 ADUO。', tail];
  } else if (state.alpine) {
    newsText = `布里亚托利任命 ${name} 为阿尔派副领队，并把其列入接班人培养计划。`;
    title = '布里亚托利的接班人：阿尔派副领队';
    detail = ['2026 年初，Flavio Briatore 决定培养一名未来接班人，玩家因此加入阿尔派管理层。', reasonLine, '布里亚托利保留研发大方向等关键决定。玩家必须适当照顾科拉平托及其庞大粉丝群，同时避免加斯利失去信心。A526 与新换装的梅赛德斯动力单元也需要逐步完成匹配。', tail];
  } else if (state.haas) {
    newsText = `${name} 加入 TGR 哈斯，与小松礼雄共同管理车队。`;
    title = '两方股东之间：哈斯共同领队';
    detail = ['随着丰田逐步增加对车队的投入，小松礼雄已无法独自处理全部事务，玩家被任命为共同领队。', reasonLine, '车队开局资金有限，生产能力不足。玩家必须在吉恩·哈斯的独立性与丰田的资金、技术和日益增强的干涉之间保持平衡。', tail];
  } else if (state.williams) {
    newsText = `Williams 宣布 ${name} 将在 2026 年作为 James Vowles 的接班人接受培养。`;
    title = '格罗夫的交接年：威廉姆斯接班人';
    detail = ['James Vowles 计划在 2026 年底返回梅赛德斯，威廉姆斯从赛季初开始培养玩家接任领队。', reasonLine, '格罗夫的资金有限，设施仍落后。玩家每个比赛周必须决定优先投资长期设施、当季赛车升级，还是保留现金，并用整个赛季证明自己能够接班。', tail];
  } else if (team.id === 'cadillac') {
    newsText = `新军凯迪拉克通过全球公开招募，任命 ${name} 为首任领队。`;
    title = '从零开始：凯迪拉克新军';
    detail = ['作为全新加入 F1 的车队，凯迪拉克急需工程、比赛与管理人才，因此在全球公开招募。', reasonLine, '凯迪拉克没有额外特殊机制，但初始赛车性能很差。玩家必须用研发、市场与稳定完赛逐步建立一支真正的 F1 车队。', tail];
  } else {
    newsText = `${name} 正式出任 ${team.name} 领队，${state.season.year} 赛季季前准备开始。`;
    title = '就任领队';
    detail = [`${name} 刚刚正式出任 ${team.name} 的车队领队。`, reasonLine, tail];
  }
  state.news.push({ id: 'n0', at: 'S1R1', tag: '车队', text: newsText });
  state.narration.push({ id: 'e0', at: 'S1R1', kind: 'new_game', title, detail: detail.join('') });
  return state;
}
