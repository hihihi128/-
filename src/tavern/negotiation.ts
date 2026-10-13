import type { Action, GameState } from '../engine/types';

export type NegotiationKind = 'aduo_alliance' | 'fia_roundtable' | 'mercedes_politics' | 'aston_honda' | 'red_bull_gp' | 'haas_toyota';
export type NegotiationStatus = 'active' | 'agreement' | 'breakdown';

export interface NegotiationMessage {
  role: 'player' | 'counterparty';
  speaker: string;
  text: string;
}

export interface NegotiationSessionView {
  id: string;
  kind: NegotiationKind;
  title: string;
  participants: string[];
  api: 'main' | 'secondary';
  round: number;
  minRounds: number;
  maxRounds: number;
  status: NegotiationStatus;
  messages: NegotiationMessage[];
  outcome: string | null;
}

export interface NegotiationDefinition {
  kind: NegotiationKind;
  title: string;
  participants: string[];
  opening: string;
  choices: Record<string, { label: string; action: Action | null }>;
  context(state: GameState): string;
  unavailable(state: GameState): string | null;
}

const weekKey = (state: GameState) => `${state.season.number}-w${state.season.week}`;
const teamName = (state: GameState, id: string) => state.teams[id]?.name ?? id;
const owns = (target: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(target, key);

export const NEGOTIATIONS: Record<NegotiationKind, NegotiationDefinition> = {
  aduo_alliance: {
    kind: 'aduo_alliance',
    title: 'ADUO 四队联盟谈判',
    participants: ['法拉利代表', '梅赛德斯代表', '阿斯顿·马丁代表'],
    opening: '三支车队的代表已经到场。他们要求奥迪说明共同游说 FIA 的目标、代价与信息共享边界。',
    choices: {
      alliance: { label: '达成四队联盟', action: { type: 'AUDI_ALLIANCE' } },
    },
    context: state => {
      const audi = state.audi!;
      return `奥迪 ADUO 进度 ${audi.aduoProgress}%，政治支持 ${audi.politicalSupport}。联盟目标是与法拉利、梅赛德斯和阿斯顿·马丁共同推动 ADUO。`;
    },
    unavailable: state => !state.audi ? '当前车队没有奥迪联盟机制' : state.audi.alliance ? '四队联盟已经成立' : null,
  },
  fia_roundtable: {
    kind: 'fia_roundtable',
    title: 'FIA 领队座谈会',
    participants: ['FIA 主持人', '对手车队代表'],
    opening: 'FIA 主持人宣布议题，并请玩家先陈述立场。对手车队准备质询玩家的方案。',
    choices: {
      support: { label: '支持议题', action: { type: 'FIA_DEBATE', stance: 'support' } },
      oppose: { label: '反对议题', action: { type: 'FIA_DEBATE', stance: 'oppose' } },
      compromise: { label: '提出折中', action: { type: 'FIA_DEBATE', stance: 'compromise' } },
    },
    context: state => {
      const current = state.fiaMeeting!.current!;
      const issue = current.issue === 'aduo' ? 'ADUO 动力单元升级' : current.issue === 'driver_safety' ? '车手安全与强制退赛' : '预算帽与新车队扶持';
      return `第 ${current.index} 次会议，议题是${issue}。对手是${current.opponents.map(id => teamName(state, id)).join('、')}。玩家政治资本 ${state.fiaMeeting!.politicalCapital}，董事会信心 ${state.teams[state.meta.playerTeamId].boardConfidence}，媒体声望 ${state.teams[state.meta.playerTeamId].mediaReputation}。`;
    },
    unavailable: state => !state.fiaMeeting?.current ? '当前没有待处理的 FIA 领队座谈会' : null,
  },
  mercedes_politics: {
    kind: 'mercedes_politics',
    title: '梅赛德斯政治谈判',
    participants: ['Toto Wolff', 'FIA 技术代表', '竞争对手领队'],
    opening: 'FIA 与竞争对手要求梅赛德斯解释动力单元方案。Toto 等待玩家提出本轮政治策略。',
    choices: {
      lobby_aduo: { label: '游说 ADUO', action: { type: 'MERCEDES_POLITICS', strategy: 'lobby_aduo' } },
      defend: { label: '技术辩护', action: { type: 'MERCEDES_POLITICS', strategy: 'defend' } },
      compromise: { label: '政治妥协', action: { type: 'MERCEDES_POLITICS', strategy: 'compromise' } },
    },
    context: state => {
      const m = state.mercedes!;
      return `ADUO 审批 ${m.aduoProgress}%，政治压力 ${m.politicalPressure}/120，Toto 满意度 ${m.totoSatisfaction}，压缩比 ${m.compressionRatio}。`;
    },
    unavailable: state => !state.mercedes ? '当前车队没有梅赛德斯政治机制' : state.mercedes.dismissed ? '玩家已被 Toto 撤职' : state.mercedes.lastActionRound === weekKey(state) ? '本周已经执行过政治行动' : null,
  },
  aston_honda: {
    kind: 'aston_honda',
    title: '阿斯顿·马丁危机谈判',
    participants: ['本田代表', 'Adrian Newey', '车手代表'],
    opening: '本田、纽维和车手代表对振动风险的责任与解决顺序意见不一。他们要求玩家主持谈判。',
    choices: {
      pressure_honda: { label: '用安全数据施压本田', action: { type: 'ASTON_CRISIS', strategy: 'pressure_honda' } },
      mediate: { label: '调解本田与纽维', action: { type: 'ASTON_CRISIS', strategy: 'mediate' } },
      push_newey: { label: '催促纽维适配车体', action: { type: 'ASTON_CRISIS', strategy: 'push_newey' } },
    },
    context: state => {
      const a = state.astonMartin!;
      return `ADUO 提前进度 ${a.aduoProgress}%，本田与纽维冲突 ${a.hondaConflict}，纽维车体进度 ${a.neweyProgress}%，媒体压力 ${a.mediaPressure}。`;
    },
    unavailable: state => !state.astonMartin ? '当前车队没有阿斯顿·马丁危机机制' : state.astonMartin.lastActionRound === weekKey(state) ? '本周已经执行过危机行动' : null,
  },
  red_bull_gp: {
    kind: 'red_bull_gp',
    title: 'GP 留任谈判',
    participants: ['Gianpiero Lambiase', '红牛管理层'],
    opening: 'GP 说明迈凯伦的邀请很有吸引力。他愿意听取玩家关于职责、资源和长期计划的完整方案。',
    choices: {
      retain: { label: '接受留任方案', action: { type: 'RED_BULL_RETAIN_GP' } },
    },
    context: state => {
      const r = state.redBull!;
      return `GP 留任意愿 ${r.gpRetention}。留任方案成本 ${state.rules.redBull.gpNegotiationCost}M，车队资金 ${state.teams[state.meta.playerTeamId].funds}M。`;
    },
    unavailable: state => !state.redBull
      ? '当前车队没有红牛 GP 留任机制'
      : state.redBull.gpTransferred
        ? 'GP 已经转投迈凯伦'
        : state.redBull.lastActionRound === weekKey(state)
          ? '本周已经与 GP 谈判过'
          : state.teams[state.meta.playerTeamId].funds < state.rules.redBull.gpNegotiationCost
            ? `车队资金不足，留任方案需要 ${state.rules.redBull.gpNegotiationCost}M`
            : null,
  },
  haas_toyota: {
    kind: 'haas_toyota',
    title: '哈斯与丰田股东谈判',
    participants: ['Gene Haas', '丰田代表'],
    opening: '吉恩·哈斯要求保留最终决定权，丰田则要求投入与影响力匹配。双方等待玩家提出安排。',
    choices: {
      protect_independence: { label: '维护车队独立', action: { type: 'HAAS_BALANCE', strategy: 'protect_independence' } },
      accept_toyota: { label: '接受丰田追加投入', action: { type: 'HAAS_BALANCE', strategy: 'accept_toyota' } },
      compromise: { label: '达成股东折中', action: { type: 'HAAS_BALANCE', strategy: 'compromise' } },
    },
    context: state => {
      const h = state.haas!;
      return `吉恩支持 ${h.geneSupport}，丰田支持 ${h.toyotaSupport}，丰田影响力 ${h.toyotaInfluence}%，丰田累计投入 ${h.fundingProvided}M。`;
    },
    unavailable: state => !state.haas ? '当前车队没有哈斯股东机制' : state.haas.lastActionRound === weekKey(state) ? '本周已经执行过股东行动' : null,
  },
};

export function negotiationDefinition(kind: unknown): NegotiationDefinition | null {
  return typeof kind === 'string' && owns(NEGOTIATIONS, kind) ? NEGOTIATIONS[kind as NegotiationKind] : null;
}

export function negotiationPrompt(state: GameState, session: NegotiationSessionView, playerText: string): string {
  const definition = NEGOTIATIONS[session.kind];
  const choices = Object.entries(definition.choices).map(([id, value]) => `${id}=${value.label}`).join('；');
  const transcript = [...session.messages, { role: 'player' as const, speaker: '玩家领队', text: playerText }]
    .map(message => `${message.speaker}：${message.text}`)
    .join('\n');
  return [
    '你在 F1 车队领队模拟器中扮演谈判对手。使用简体中文，保持角色立场，不要提到 AI、模型、提示词或游戏代码。',
    `事件：${definition.title}。参与者：${definition.participants.join('、')}。`,
    `公开状态：${definition.context(state)}`,
    `这是玩家第 ${session.round + 1}/${session.maxRounds} 轮发言。至少经过 ${session.minRounds} 轮，最迟第 ${session.maxRounds} 轮必须达成协议或谈判破裂。`,
    `可结算选择只有：${choices}。不得创造其他数值效果，不得直接修改存档。`,
    '在最低轮数前，status 必须是 continue。在最后一轮，status 必须是 agreement 或 breakdown。agreement 时 choice 必须是上面一个精确 ID；continue 或 breakdown 时 choice 必须是 null。',
    'reply 必须是对手给玩家的自然回应，包含明确质询、条件或结论，最多 180 个中文字符。speaker 必须是参与者之一。',
    `谈判记录：\n${transcript}`,
    '只返回一个 JSON 对象，不要代码块：{"speaker":"参与者","reply":"回应","status":"continue|agreement|breakdown","choice":null或"选择ID"}',
  ].join('\n');
}

export function parseNegotiationReply(text: string, definition: NegotiationDefinition, round: number, minRounds: number, maxRounds: number): { speaker: string; reply: string; status: 'continue' | 'agreement' | 'breakdown'; choice: string | null } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('谈判 API 没有返回 JSON');
  const row = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const speaker = typeof row.speaker === 'string' ? row.speaker.trim().slice(0, 40) : '';
  const reply = typeof row.reply === 'string' ? row.reply.trim().slice(0, 600) : '';
  const status = row.status;
  const choice = typeof row.choice === 'string' ? row.choice : null;
  if (!definition.participants.includes(speaker)) throw new Error('谈判 API 返回了未知发言人');
  if (!reply) throw new Error('谈判 API 没有返回有效回应');
  if (status !== 'continue' && status !== 'agreement' && status !== 'breakdown') throw new Error('谈判 API 返回了未知状态');
  if (round < minRounds && status !== 'continue') throw new Error(`谈判至少需要 ${minRounds} 轮`);
  if (round >= maxRounds && status === 'continue') throw new Error(`谈判必须在第 ${maxRounds} 轮结算`);
  if (status === 'agreement' && (!choice || !owns(definition.choices, choice))) throw new Error('谈判 API 返回了非法结算选择');
  if (status !== 'agreement' && choice !== null) throw new Error('未达成协议时不能包含结算选择');
  return { speaker, reply, status, choice };
}
