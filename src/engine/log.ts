import type { GameState } from './types';
import { nextId, pushCapped, stamp } from './util';

const NEWS_CAP = 30;
const NARRATION_CAP = 12;

export function addNews(state: GameState, tag: string, text: string): void {
  pushCapped(state.news, { id: nextId(state, 'n'), at: stamp(state), tag, text }, NEWS_CAP);
}

/** 加入待 AI 叙述的事件（下一次 AI 回复时会写进提示词） */
export function addNarration(state: GameState, kind: string, title: string, detail: string): void {
  pushCapped(state.narration, { id: nextId(state, 'e'), at: stamp(state), kind, title, detail }, NARRATION_CAP);
}

export function playerTeam(state: GameState) {
  return state.teams[state.meta.playerTeamId];
}

export function driverName(state: GameState, id: string | null | undefined): string {
  if (!id) return '—';
  return state.drivers[id]?.name ?? id;
}

export function teamName(state: GameState, id: string | null | undefined): string {
  if (!id) return '—';
  return state.teams[id]?.name ?? id;
}
