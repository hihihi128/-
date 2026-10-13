/**
 * 暴露给前端（悬浮面板 / 楼层状态条 / 其他脚本）的接口：window.F1Manager
 *
 * 在酒馆助手的前端界面里：await waitGlobalInitialized('F1Manager') 之后直接使用 F1Manager。
 * 在普通 iframe 里：window.parent.F1Manager。
 * 返回的数据请自行 JSON 深拷贝后再放进响应式框架（跨 iframe 对象）。
 */
import type { NewGameOptions } from '../engine/newgame';
import type { Action, Ambition, ContractOfferTerms, DriverAttr, FacilityType, StaffRole } from '../engine/types';
import { VERSION, type F1Controller, type Settings } from './controller';
import type { PanelHost } from './panelHost';

export function createApi(ctrl: F1Controller, panel: () => PanelHost | null) {
  return {
    version: VERSION,
    status: () => ctrl.status(),
    view: (floor?: number) => ctrl.view(floor),
    hud: (floor: number) => ctrl.hud(floor),
    prompt: () => ctrl.promptForLatest(),
    dispatch: (action: Action) => ctrl.dispatch(action),
    previewProject: (partType: string, ambition: Ambition, rush = false) => ctrl.previewProject(partType, ambition, rush),
    previewManufacture: (partType: string, specId: string, qty: number) => ctrl.previewManufacture(partType, specId, qty),
    previewFacility: (facility: FacilityType) => ctrl.previewFacility(facility),
    previewDriverTraining: (driverId: string, attr: DriverAttr) => ctrl.previewDriverTraining(driverId, attr),
    previewContractOffer: (terms: ContractOfferTerms, kind: 'driver' | 'staff', role?: StaffRole) => ctrl.previewContractOffer(terms, kind, role),
    loadData: () => ctrl.loadData(),
    newGame: (opts: Partial<NewGameOptions> & { playerTeamId: string }) => ctrl.newGame(opts),
    listRevisions: () => ctrl.listRevisions(),
    restoreRevision: (id: string) => ctrl.restoreRevision(id),
    exportSave: () => ctrl.exportSave(),
    importSave: (text: string) => ctrl.importSave(text),
    getSettings: () => ({ ...ctrl.settings }),
    setSettings: (patch: Partial<Settings>) => ctrl.updateSettings(patch),
    requestNarration: (text?: string) => ctrl.requestNarration(text),
    requestEngineerStrategy: (driverId: string, api?: 'main' | 'secondary') => ctrl.requestEngineerStrategy(driverId, api),
    requestPerfectStrategy: (driverId: string, api?: 'main' | 'secondary') => ctrl.requestPerfectStrategy(driverId, api),
    requestSupernaturalIntervention: (request: { description: string; expectedRevisionId: string; api?: 'main' | 'secondary' }) => ctrl.requestSupernaturalIntervention(request),
    /** 强制重新结算最新一条 AI 回复的指令 */
    reprocessLatest: async () => {
      const last = ctrl.latestFloor();
      await ctrl.processAssistantMessage(last, { force: true });
      return { ok: true, message: '已重新结算最新楼层' };
    },
    openPanel: (tab?: string) => panel()?.open(tab),
    closePanel: () => panel()?.close(),
    togglePanel: (tab?: string) => panel()?.toggle(tab),
    subscribe: (fn: (reason: string) => void) => ctrl.subscribe(fn),
  };
}

export type F1ManagerApi = ReturnType<typeof createApi>;
