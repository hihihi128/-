import { STAFF_ROLES } from './defaults';
import { costCapOf } from './finance';
import { addNarration, addNews } from './log';
import { driverOverall } from './ratings';
import type {
  CandidatePreference,
  ContractOfferTerms,
  ContractQuote,
  DriverState,
  GameState,
  MarketAgreement,
  MarketRoster,
  MarketState,
  MarketWindow,
  StaffMember,
  StaffRole,
} from './types';
import { clamp, round1, round2 } from './util';

export interface MarketOutcome { ok: boolean; message: string }
const ok = (message: string): MarketOutcome => ({ ok: true, message });
const fail = (message: string): MarketOutcome => ({ ok: false, message });

/** Market cash is paid now but reserved against the target-year cap in quotes. */
function chargeMarketCash(state: GameState, teamId: string, amount: number): void {
  state.teams[teamId].funds = round2(state.teams[teamId].funds - amount);
}

function preference(id: string, askingSalary: number, reserve = true): CandidatePreference {
  let n = 0;
  for (const c of id) n = ((n * 31) + c.charCodeAt(0)) >>> 0;
  return {
    askingSalary: round2(Math.max(0.1, askingSalary)),
    preferredYears: 1 + (n % 3),
    desiredStrength: 40 + (n % 45),
    preferredTeamId: null,
    loyalty: 20 + (n % 61),
    acceptsReserve: reserve,
  };
}

function profileForDriver(d: DriverState): CandidatePreference {
  return d.preference ?? preference(d.id, d.salary || Math.max(0.5, driverOverall(d) / 20), true);
}

function profileForStaff(s: StaffMember): CandidatePreference {
  return s.preference ?? preference(s.id ?? s.name, s.salary || Math.max(0.3, s.skill / 35), false);
}

function initialRoster(state: GameState, teamId: string, year: number): MarketRoster {
  const team = state.teams[teamId];
  const seats: Record<string, string | null> = {};
  for (const car of team.cars) {
    const d = car.driverId ? state.drivers[car.driverId] : undefined;
    seats[String(car.slot)] = d && d.contractEnd >= year ? d.id : null;
  }
  const reserveIds = Object.values(state.drivers)
    .filter(d => d.teamId === teamId && d.role === 'reserve' && d.contractEnd >= year)
    .map(d => d.id);
  const staff = {} as Record<StaffRole, string | null>;
  for (const role of STAFF_ROLES) {
    const member = team.staff[role];
    staff[role] = member.contractEnd === undefined || member.contractEnd >= year ? member.id ?? `${teamId}-${role}` : null;
  }
  return { raceSeats: seats, reserveIds, staff };
}

function strengthSnapshot(state: GameState): Record<string, number> {
  const points = Object.values(state.standings.teams).some(s => s.points > 0);
  const ordered = [...state.teamOrder].sort((a, b) => {
    if (points) return (state.standings.teams[b]?.points ?? 0) - (state.standings.teams[a]?.points ?? 0) || a.localeCompare(b);
    return state.teams[a].targetPosition - state.teams[b].targetPosition || a.localeCompare(b);
  });
  const out: Record<string, number> = {};
  ordered.forEach((id, i) => { out[id] = ordered.length <= 1 ? 50 : round1(100 - (i * 100) / (ordered.length - 1)); });
  return out;
}

function createFallbackStaff(role: StaffRole, index: number): StaffMember {
  const id = `fictional-${role}-${index}`;
  const skill = 58 + ((index * 7 + role.length * 3) % 24);
  const abilities = role === 'strategist'
    ? { strategy: skill, weather: Math.max(1, skill - 3 + index), risk: Math.min(100, skill + 2 - index) }
    : role === 'raceEngineer' || role === 'raceEngineer2'
      ? { setup: skill, communication: Math.max(1, skill - 2 + index), reaction: Math.min(100, skill + 1), weather: Math.max(1, skill - 4) }
      : undefined;
  return { id, role, name: `自由${role}-${index}`, skill, abilities, salary: round2(skill / 38), contractStart: 0, contractEnd: 0, preference: preference(id, skill / 38, false) };
}

function ensureFallbackDrivers(state: GameState): void {
  const free = Object.values(state.drivers).filter(d => !d.teamId).length;
  for (let i = free; i < 4; i++) {
    const id = `fictional-driver-${i + 1}`;
    if (state.drivers[id]) continue;
    const base = 62 + i * 3;
    state.drivers[id] = {
      id, name: `虚构自由车手 ${String(i + 1).padStart(2, '0')}`, short: `FD${i + 1}`, number: 801 + i, nationality: '虚构', age: 22 + i,
      teamId: null, role: 'reserve', attrs: { pace: base, racecraft: base - 1, consistency: base + 1, tyre: base, wet: base - 2, feedback: base + 2 },
      potential: base + 8, morale: 60, fitness: 100, trust: 50, form: 0, ego: 45, salary: round2(base / 22), contractStart: 0, contractEnd: 0,
      preference: preference(id, base / 22, true), traits: ['虚构候选人'], description: '系统为自定义世界生成的虚构自由车手。', stats: { starts: 0, wins: 0, podiums: 0, poles: 0, points: 0, dnfs: 0 },
    };
  }
}

/** Additive initialization used by new games and migration. It never draws RNG. */
export function ensureMarket(state: GameState): MarketState {
  if (!state.market) state.market = { version: 1, revision: 0, freeStaff: {}, window: null, completed: [] };
  const market = state.market;
  if (market.version !== 1) throw new Error(`不支持的人员市场存档版本 ${market.version}`);
  market.freeStaff ??= {};
  market.completed ??= [];
  for (const [teamId, team] of Object.entries(state.teams)) {
    if (!team.staff.raceEngineer2) {
      const first = team.staff.raceEngineer;
      team.staff.raceEngineer2 = { ...first, id: `${teamId}-raceEngineer2`, role: 'raceEngineer2', name: `${first.name || team.name}（二号车）`, abilities: first.abilities ? { ...first.abilities } : undefined };
    }
    for (const role of STAFF_ROLES) {
      const staff = team.staff[role];
      if (!staff.id) staff.id = `${teamId}-${role}`;
      staff.role = role;
      if (!staff.name) staff.name = `${team.name} ${role}`;
      if (!staff.contractStart) staff.contractStart = state.season.year;
      if (!staff.contractEnd) staff.contractEnd = state.season.year;
      staff.preference ??= profileForStaff(staff);
    }
  }
  // Old open windows were created with one engineer slot. Keep those saves
  // closable by projecting the newly created second engineer into that slot.
  if (market.window) {
    for (const [teamId, roster] of Object.entries(market.window.projectedRosters ?? {})) {
      if (!roster.staff.raceEngineer2) roster.staff.raceEngineer2 = state.teams[teamId]?.staff.raceEngineer2?.id ?? null;
    }
  }
  for (const d of Object.values(state.drivers)) {
    d.contractStart ??= state.season.year;
    if (!d.contractEnd && d.teamId) d.contractEnd = state.season.year;
    d.preference ??= profileForDriver(d);
  }
  for (const role of STAFF_ROLES) {
    for (let index = 1; index <= 3; index++) {
      const id = `fictional-${role}-${index}`;
      if (market.freeStaff[id]) continue;
      const staff = createFallbackStaff(role, index);
      market.freeStaff[staff.id!] = staff;
    }
  }
  return market;
}

export function openMarket(state: GameState, targetYear: number): MarketWindow {
  const market = ensureMarket(state);
  if (market.window?.status === 'open' || market.window?.status === 'ai_resolved') return market.window;
  ensureFallbackDrivers(state);
  const candidateProfiles: Record<string, CandidatePreference> = {};
  for (const d of Object.values(state.drivers)) candidateProfiles[d.id] = { ...profileForDriver(d) };
  for (const s of Object.values(market.freeStaff)) if (s.id) candidateProfiles[s.id] = { ...profileForStaff(s) };
  for (const team of Object.values(state.teams)) for (const s of Object.values(team.staff)) if (s.id) candidateProfiles[s.id] = { ...profileForStaff(s) };
  const window: MarketWindow = {
    id: `market-${targetYear}-${state.season.number}`,
    targetYear,
    status: 'open',
    strengthByTeam: strengthSnapshot(state),
    candidateProfiles,
    agreements: [],
    releases: [],
    projectedRosters: Object.fromEntries(state.teamOrder.map(id => [id, initialRoster(state, id, targetYear)])),
    escrow: [],
    aiResolved: false,
  };
  market.window = window;
  market.revision++;
  addNews(state, '合同市场', `${targetYear} 赛季合同市场已开放。当前阵容保持不变，签约将在新赛季统一生效。`);
  return window;
}

function staffById(state: GameState, id: string): { staff: StaffMember; teamId: string | null; role: StaffRole | null } | null {
  const freeStaff = state.market?.freeStaff ?? {};
  if (freeStaff[id]) return { staff: freeStaff[id], teamId: null, role: freeStaff[id].role ?? null };
  for (const [teamId, team] of Object.entries(state.teams)) for (const role of STAFF_ROLES) if (team.staff[role].id === id) return { staff: team.staff[role], teamId, role };
  return null;
}

function currentOwner(state: GameState, id: string, kind: 'driver' | 'staff'): string | null {
  if (kind === 'driver') return state.drivers[id]?.teamId ?? null;
  return staffById(state, id)?.teamId ?? null;
}

function isAssigned(roster: MarketRoster, personId: string): boolean {
  return Object.values(roster.raceSeats).includes(personId) || roster.reserveIds.includes(personId) || Object.values(roster.staff).includes(personId);
}

function validMoney(value: number): boolean { return Number.isFinite(value) && value > 0 && Math.round(value * 100) === value * 100; }

function buyoutFor(state: GameState, kind: 'driver' | 'staff', id: string, targetYear: number, fromTeamId: string | null): number {
  if (!fromTeamId) return 0;
  const annual = kind === 'driver' ? state.drivers[id]?.salary : staffById(state, id)?.staff.salary;
  const end = kind === 'driver' ? state.drivers[id]?.contractEnd : staffById(state, id)?.staff.contractEnd;
  if (!annual || !end || end < targetYear) return 0;
  return round2(annual * (end - targetYear + 1) * state.rules.market.buyoutRate);
}

function findProjectedOwner(window: MarketWindow, personId: string): string | null {
  for (const [teamId, roster] of Object.entries(window.projectedRosters)) if (isAssigned(roster, personId)) return teamId;
  return null;
}

function payrollForRoster(state: GameState, roster: MarketRoster, window?: MarketWindow): number {
  const agreed = (id: string, salary: number) => window?.agreements.find(a => a.personId === id)?.annualSalary ?? salary;
  let total = 0;
  for (const id of [...Object.values(roster.raceSeats), ...roster.reserveIds]) if (id) total += agreed(id, state.drivers[id]?.salary ?? 0);
  for (const id of Object.values(roster.staff)) if (id) total += agreed(id, staffById(state, id)?.staff.salary ?? 0);
  return round2(total);
}

function termsCheck(state: GameState, terms: ContractOfferTerms): string[] {
  const r = state.rules.market;
  const errors: string[] = [];
  if (!validMoney(terms.annualSalary)) errors.push('年薪必须是最多两位小数的正数');
  if (!Number.isInteger(terms.years) || terms.years < r.minYears || terms.years > r.maxYears) errors.push(`合同年限必须为 ${r.minYears}–${r.maxYears} 年`);
  return errors;
}

export function previewContractOffer(state: GameState, teamId: string, terms: ContractOfferTerms, kind: 'driver' | 'staff', staffRole?: StaffRole): ContractQuote {
  // Previews must not migrate or synthesize candidates: callers use them while
  // editing a form and rely on this path being read-only.
  const market = state.market;
  const window = market?.window;
  const blockers = termsCheck(state, terms);
  const none: ContractQuote = { windowId: terms.windowId, marketRevision: market?.revision ?? 0, terms, candidateDecision: 'reject', score: 0, threshold: state.rules.market.acceptanceThreshold, factors: {}, blockers, buyout: 0, severance: 0, cashDueNow: 0, annualPayrollBefore: 0, annualPayrollAfter: 0, guaranteedSalaryTotal: 0, capYear: window?.targetYear ?? state.season.year, capCharge: 0, projectedCapRemaining: 0, replacedPersonId: terms.replacePersonId ?? null };
  if (!window || window.status === 'closed') return { ...none, blockers: [...blockers, '合同市场尚未开放'] };
  if (window.id !== terms.windowId || terms.marketRevision !== market!.revision) return { ...none, blockers: [...blockers, '报价已过期，请刷新'] };
  const roster = window.projectedRosters[teamId];
  if (!roster) return { ...none, blockers: [...blockers, '车队不存在'] };
  const person = kind === 'driver' ? state.drivers[terms.personId] : staffById(state, terms.personId)?.staff;
  if (!person) return { ...none, blockers: [...blockers, '候选人不存在'] };
  if (window.agreements.some(a => a.personId === terms.personId)) blockers.push('候选人已接受其他合同');
  // A projected rival incumbent is a valid buyout target. A binding agreement,
  // checked above, is the only market lock; clients cannot choose replacements.
  let replaced: string | null = null;
  if (kind === 'driver') {
    if (terms.role !== 'race' && terms.role !== 'reserve') blockers.push('请选择正式或替补岗位');
    if (terms.role === 'race') {
      const key = terms.slot === undefined ? '' : String(terms.slot);
      if (!key || !(key in roster.raceSeats)) blockers.push('请选择有效车位');
      else replaced = roster.raceSeats[key];
    }
    const pref = window.candidateProfiles[terms.personId] ?? profileForDriver(person as DriverState);
    if (terms.role === 'reserve' && !pref.acceptsReserve) blockers.push('该车手不接受替补合同');
  } else {
    if (!staffRole || (person as StaffMember).role !== staffRole) blockers.push('员工岗位不匹配');
    else replaced = roster.staff[staffRole];
  }
  const fromTeamId = currentOwner(state, terms.personId, kind);
  const buyout = fromTeamId === teamId ? 0 : buyoutFor(state, kind, terms.personId, window.targetYear, fromTeamId);
  const severance = replaced && replaced !== terms.personId ? buyoutFor(state, kind, replaced, window.targetYear, teamId) : 0;
  const profile = window.candidateProfiles[terms.personId] ?? preference(terms.personId, (person as { salary: number }).salary || 1);
  const strength = window.strengthByTeam[teamId] ?? 50;
  const staying = fromTeamId === teamId ? 6 : 0;
  const preferred = profile.preferredTeamId === teamId ? 8 : 0;
  const factors = {
    salary: clamp(50 * (terms.annualSalary / Math.max(0.01, profile.askingSalary) - 1), -30, 30),
    term: -6 * Math.abs(terms.years - profile.preferredYears),
    teamStrength: 0.2 * (strength - profile.desiredStrength),
    loyalty: Math.min(6, profile.loyalty / 10),
    preference: Math.min(8, preferred),
    staying,
  };
  const score = 50 + Object.values(factors).reduce((a, b) => a + b, 0);
  const annualBefore = payrollForRoster(state, roster, window);
  const replacedSalary = replaced ? (kind === 'driver' ? state.drivers[replaced]?.salary ?? 0 : staffById(state, replaced)?.staff.salary ?? 0) : 0;
  const annualAfter = round2(annualBefore - (replaced ? (window.agreements.find(a => a.personId === replaced)?.annualSalary ?? replacedSalary) : 0) + terms.annualSalary);
  const immediate = round2(buyout + severance);
  const team = state.teams[teamId];
  const buffer = annualAfter / 52 * state.rules.market.payrollBufferWeeks;
  if (team.funds + 1e-9 < immediate + buffer) blockers.push('资金不足以支付费用并保留工资缓冲');
  const reservedFees = window.escrow.filter(e => e.payerTeamId === teamId && e.capYear === window.targetYear && !e.settled).reduce((sum, e) => sum + e.amount, 0);
  // Quotes reserve the target season, not this completed season's spent cap.
  const capCharge = state.rules.costCapIncludesSalaries ? round2(annualAfter + reservedFees + immediate) : 0;
  const capRemain = round2(costCapOf(team, state.rules) - capCharge);
  if (state.rules.costCapIncludesSalaries && capRemain < -1e-9) blockers.push('预计工资和人员费用会超出预算帽');
  return {
    windowId: window.id,
    marketRevision: market!.revision,
    terms,
    candidateDecision: score >= state.rules.market.acceptanceThreshold ? 'accept' : 'reject',
    score: round1(score), threshold: state.rules.market.acceptanceThreshold, factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, round1(v)])), blockers,
    buyout, severance, cashDueNow: immediate, annualPayrollBefore: annualBefore, annualPayrollAfter: annualAfter,
    guaranteedSalaryTotal: round2(terms.annualSalary * terms.years), capYear: window.targetYear, capCharge, projectedCapRemaining: capRemain, replacedPersonId: replaced,
  };
}

function detachProjected(roster: MarketRoster, id: string): void {
  for (const key of Object.keys(roster.raceSeats)) if (roster.raceSeats[key] === id) roster.raceSeats[key] = null;
  roster.reserveIds = roster.reserveIds.filter(x => x !== id);
  for (const role of STAFF_ROLES) if (roster.staff[role] === id) roster.staff[role] = null;
}

function acceptOffer(state: GameState, teamId: string, quote: ContractQuote, kind: 'driver' | 'staff', staffRole?: StaffRole): MarketOutcome {
  if (quote.blockers.length) return fail(quote.blockers[0]);
  if (quote.candidateDecision !== 'accept') return fail('候选人拒绝了当前报价');
  const market = ensureMarket(state); const window = market.window!; const terms = quote.terms;
  const target = window.projectedRosters[teamId];
  const cancelAgreement = (personId: string) => {
    const old = window.agreements.find(a => a.personId === personId);
    if (!old) return;
    window.agreements = window.agreements.filter(a => a !== old);
    // Pending escrow was paid at signing but never settled to a recipient. Return
    // exactly this agreement's matching charges and remove its cap reservation.
    const amounts = new Set([old.buyout, old.severance].filter(Boolean));
    const cancelled = window.escrow.filter(e => e.payerTeamId === old.toTeamId && !e.settled && amounts.has(e.amount));
    for (const escrow of cancelled) {
      state.teams[escrow.payerTeamId].funds = round2(state.teams[escrow.payerTeamId].funds + escrow.amount);
    }
    window.escrow = window.escrow.filter(e => !cancelled.includes(e));
    window.releases = window.releases.filter(r => r.personId !== personId);
  };
  for (const roster of Object.values(window.projectedRosters)) detachProjected(roster, terms.personId);
  if (kind === 'driver') {
    if (terms.role === 'race') target.raceSeats[String(terms.slot)] = terms.personId;
    else target.reserveIds.push(terms.personId);
  } else target.staff[staffRole!] = terms.personId;
  if (quote.replacedPersonId && quote.replacedPersonId !== terms.personId) {
    cancelAgreement(quote.replacedPersonId);
    detachProjected(target, quote.replacedPersonId);
    window.releases.push({ id: `release-${window.id}-${quote.replacedPersonId}`, personKind: kind, personId: quote.replacedPersonId, teamId, effectiveYear: window.targetYear, severance: quote.severance });
  }
  const fromTeamId = currentOwner(state, terms.personId, kind);
  const agreement: MarketAgreement = { id: `agreement-${window.id}-${terms.personId}`, personKind: kind, personId: terms.personId, fromTeamId, toTeamId: teamId, annualSalary: terms.annualSalary, startYear: window.targetYear, endYear: window.targetYear + terms.years - 1, buyout: quote.buyout, severance: quote.severance, windowId: window.id, ...(kind === 'driver' ? { driverRole: terms.role, slot: terms.slot } : { staffRole }) };
  window.agreements.push(agreement);
  for (const item of [{ amount: quote.buyout, category: 'buyout' as const, recipientTeamId: fromTeamId, recipientPersonId: null }, { amount: quote.severance, category: 'severance' as const, recipientTeamId: null, recipientPersonId: quote.replacedPersonId }]) {
    if (item.amount <= 0) continue;
    chargeMarketCash(state, teamId, item.amount);
    window.escrow.push({ id: `escrow-${window.id}-${window.escrow.length + 1}`, payerTeamId: teamId, recipientTeamId: item.recipientTeamId, recipientPersonId: item.recipientPersonId, amount: item.amount, category: item.category, capYear: window.targetYear, settled: false });
  }
  market.revision++;
  if (fromTeamId && fromTeamId !== teamId && fromTeamId !== state.meta.playerTeamId) {
    // A player buyout can reopen an AI vacancy; require the bounded repair pass
    // before the window can close, without allowing new discretionary poaching.
    window.aiResolved = false;
    window.status = 'open';
  }
  addNews(state, '合同市场', `${terms.personId} 接受了 ${state.teams[teamId].name} 的 ${terms.years} 年合同（年薪 $${terms.annualSalary.toFixed(2)}M）。`);
  addNarration(state, 'market_agreement', '合同达成', `${terms.personId} 接受了 ${state.teams[teamId].name} 的合同；协议将在 ${window.targetYear} 赛季生效。`);
  return ok('合同已确认，将在市场关闭时生效');
}

export function offerDriverContract(state: GameState, teamId: string, terms: ContractOfferTerms): MarketOutcome { return acceptOffer(state, teamId, previewContractOffer(state, teamId, terms, 'driver'), 'driver'); }
export function offerStaffContract(state: GameState, teamId: string, terms: ContractOfferTerms, role: StaffRole): MarketOutcome { return acceptOffer(state, teamId, previewContractOffer(state, teamId, terms, 'staff', role), 'staff', role); }

export function releasePerson(state: GameState, teamId: string, windowId: string, revision: number, kind: 'driver' | 'staff', personId: string): MarketOutcome {
  const market = ensureMarket(state); const window = market.window;
  if (!window || window.id !== windowId || revision !== market.revision || window.status === 'closed') return fail('市场状态已更新，请刷新');
  if (findProjectedOwner(window, personId) !== teamId) return fail('只能解约本队预计人员');
  const cost = buyoutFor(state, kind, personId, window.targetYear, teamId);
  if (state.teams[teamId].funds < cost) return fail('资金不足以支付解约金');
  detachProjected(window.projectedRosters[teamId], personId);
  // Releasing a person after signing must not leave an agreement that later
  // overwrites the released person's salary/term during market activation.
  window.agreements = window.agreements.filter(a => a.personId !== personId);
  window.releases = window.releases.filter(r => r.personId !== personId);
  if (cost) { chargeMarketCash(state, teamId, cost); window.escrow.push({ id: `escrow-${window.id}-${window.escrow.length + 1}`, payerTeamId: teamId, recipientTeamId: null, recipientPersonId: personId, amount: cost, category: 'severance', capYear: window.targetYear, settled: false }); }
  window.releases.push({ id: `release-${window.id}-${personId}`, personKind: kind, personId, teamId, effectiveYear: window.targetYear, severance: cost });
  market.revision++; return ok('预计阵容已解约；请在关闭市场前补齐必需岗位');
}

export function marketCloseBlockers(state: GameState): string[] {
  const window = state.market?.window; if (!window || window.status === 'closed') return [];
  const blockers: string[] = [];
  if (!window.aiResolved) blockers.push('请先处理其他车队的合同市场');
  for (const [teamId, roster] of Object.entries(window.projectedRosters)) {
    if (Object.values(roster.raceSeats).some(id => !id)) blockers.push(`${state.teams[teamId].name} 有空缺正式车位`);
    for (const role of STAFF_ROLES) if (!roster.staff[role]) blockers.push(`${state.teams[teamId].name} 缺少${role}`);
  }
  return blockers;
}

/** Activate agreements atomically, called only after close blockers pass. */
export function closeMarket(state: GameState): MarketOutcome {
  const market = ensureMarket(state); const window = market.window;
  if (!window) return ok('没有待关闭的合同市场');
  const blockers = marketCloseBlockers(state); if (blockers.length) return fail(blockers[0]);
  for (const escrow of window.escrow) {
    if (escrow.settled) continue;
    if (escrow.recipientTeamId) state.teams[escrow.recipientTeamId].funds = round2(state.teams[escrow.recipientTeamId].funds + escrow.amount);
    escrow.settled = true;
  }
  if (state.rules.costCapIncludesSalaries && window.targetYear <= state.season.year) {
    for (const escrow of window.escrow) state.teams[escrow.payerTeamId].costCapSpent = round2(state.teams[escrow.payerTeamId].costCapSpent + escrow.amount);
  }
  // Snapshot staff objects before overwriting inline slots. This makes transfers
  // and releases true ownership moves rather than duplicate mutable copies.
  const staffPool = new Map<string, StaffMember>();
  for (const team of Object.values(state.teams)) for (const staff of Object.values(team.staff)) if (staff.id) staffPool.set(staff.id, { ...staff });
  for (const staff of Object.values(market.freeStaff)) if (staff.id) staffPool.set(staff.id, { ...staff });
  for (const d of Object.values(state.drivers)) { d.teamId = null; d.role = 'reserve'; }
  const employedStaff = new Set<string>();
  for (const [teamId, roster] of Object.entries(window.projectedRosters)) {
    const team = state.teams[teamId];
    for (const car of team.cars) { const id = roster.raceSeats[String(car.slot)]!; car.driverId = id; const d = state.drivers[id]; d.teamId = teamId; d.role = 'race'; }
    for (const id of roster.reserveIds) { const d = state.drivers[id]; if (d) { d.teamId = teamId; d.role = 'reserve'; } }
    for (const role of STAFF_ROLES) {
      const id = roster.staff[role]!; const source = staffPool.get(id); if (!source) return fail(`找不到员工 ${id}`);
      const agreement = window.agreements.find(a => a.personKind === 'staff' && a.personId === id);
      team.staff[role] = agreement ? { ...source, id, role, salary: agreement.annualSalary, contractStart: agreement.startYear, contractEnd: agreement.endYear } : { ...source, id, role };
      employedStaff.add(id);
    }
  }
  for (const a of window.agreements) {
    if (a.personKind === 'driver') { const d = state.drivers[a.personId]; if (d) { d.salary = a.annualSalary; d.contractStart = a.startYear; d.contractEnd = a.endYear; } }
    else { const s = staffById(state, a.personId)?.staff; if (s) { s.salary = a.annualSalary; s.contractStart = a.startYear; s.contractEnd = a.endYear; } }
    market.completed.push({ year: window.targetYear, personId: a.personId, fromTeamId: a.fromTeamId, toTeamId: a.toTeamId, role: a.driverRole ?? a.staffRole ?? '', annualSalary: a.annualSalary });
  }
  // Rebuild the free pool after every destination is installed. Staff no longer
  // employed by a projected roster remain available exactly once.
  market.freeStaff = Object.fromEntries([...staffPool.entries()].filter(([id]) => !employedStaff.has(id)));
  window.status = 'closed'; market.revision++;
  return ok(`${window.targetYear} 赛季阵容与员工合同已生效`);
}
