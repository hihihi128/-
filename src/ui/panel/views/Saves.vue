<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { call, peek, store, toast } from '../bridge';
import type { RevisionInfo } from '../../../tavern/store';
import type { SettingsPatch, SettingsView } from '../../../tavern/controller';

const v = computed(() => store.view!);
const st = computed(() => store.status);
const revisions = ref<RevisionInfo[]>([]);
const settings = ref<SettingsView | null>(null);
const importText = ref('');
const promptPreview = ref('');
const showApiKey = ref(false);

function load() {
  revisions.value = peek(a => a.listRevisions()) ?? [];
  settings.value = peek(a => a.getSettings());
}
onMounted(load);

const kindLabel: Record<string, string> = { new: '开局', ai: 'AI 结算', ui: '面板操作', restore: '读档', import: '导入' };

async function restore(r: RevisionInfo) {
  if (!confirm(`读取「${r.label}」？\n该版本会作为新存档挂到当前最新楼层（不会删除任何消息）。`)) return;
  await call(a => a.restoreRevision(r.id));
  load();
}

async function save() {
  if (!settings.value) return;
  const patch: SettingsPatch = { ...settings.value };
  const saved = await call(a => a.setSettings(patch), false);
  if (saved) {
    toast('ok', '设置已保存');
    load();
  }
}

async function clearApiKey() {
  const saved = await call(a => a.setSettings({ clearEngineerApiKey: true }), false);
  if (saved) toast('ok', '副 API Key 已清除');
  load();
}

function exportSave() {
  const text = peek(a => a.exportSave());
  if (!text) return;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `f1m-save-${v.value.season.year}-R${v.value.season.roundIndex + 1}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copySave() {
  const text = peek(a => a.exportSave());
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('ok', '已复制到剪贴板');
  } catch {
    importText.value = text;
    toast('info', '无法访问剪贴板，已放进下方文本框');
  }
}

async function onFile(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (f) importText.value = await f.text();
}

async function doImport() {
  if (!importText.value.trim()) return;
  if (!confirm('导入会替换本聊天的存档历史，确定吗？')) return;
  await call(a => a.importSave(importText.value));
  load();
}

function newGame() {
  store.forceNewGame = true;
}

function showPrompt() {
  promptPreview.value = peek(a => a.prompt()) ?? '';
}

function kb(n: number) {
  return `${(n / 1024).toFixed(1)} KB`;
}
</script>

<template>
  <div class="stack">
    <div class="grid g2">
      <div class="card stack-s">
        <h3>存档状态</h3>
        <div class="small">
          当前版本 <b class="mono">{{ st?.revisionId ?? '—' }}</b>（挂在第 {{ st?.anchorFloor ?? '—' }} 楼，最新楼层 #{{ st?.latestFloor }}）
        </div>
        <div class="small muted">共保留 {{ st?.revisions }} 个版本，约 {{ kb(st?.storeSize ?? 0) }}。重 roll、删除楼层、切换 swipe 时存档会自动跟随楼层回滚。</div>
        <div class="row">
          <button class="small" @click="exportSave">导出存档文件</button>
          <button class="small" @click="copySave">复制存档 JSON</button>
          <button class="small" @click="showPrompt">查看注入给 AI 的数据</button>
          <button class="small" @click="call(a => a.reprocessLatest())">重新结算最新 AI 回复</button>
        </div>
        <pre v-if="promptPreview" class="prompt">{{ promptPreview }}</pre>
      </div>

      <div class="card stack-s">
        <h3>导入 / 重开</h3>
        <input type="file" accept=".json,application/json" @change="onFile" />
        <textarea v-model="importText" rows="3" placeholder="或在此粘贴存档 JSON"></textarea>
        <div class="row">
          <button class="small" :disabled="!importText.trim()" @click="doImport">导入存档</button>
          <button class="small danger" title="打开开局界面；确认开局前不会改动现有存档" @click="newGame">重新开局…</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="spread">
        <h3>版本历史（读档）</h3>
        <button class="small" @click="load">刷新</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>版本</th><th>楼层</th><th>类型</th><th>说明</th><th>进度</th><th>时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in revisions" :key="r.id" :class="{ me: r.current }">
              <td class="mono">{{ r.id }}<span v-if="r.referenced" class="tiny muted" title="被近期楼层引用，不会被自动清理"> ●</span></td>
              <td class="mono">#{{ r.floor }}</td>
              <td><span class="badge">{{ kindLabel[r.kind] ?? r.kind }}</span></td>
              <td class="small" style="white-space: normal">{{ r.label }}</td>
              <td class="tiny muted">{{ r.summary }}</td>
              <td class="tiny muted mono">{{ new Date(r.created).toLocaleTimeString() }}</td>
              <td><button v-if="!r.current" class="small" @click="restore(r)">读取</button><span v-else class="badge ok">当前</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="settings" class="card stack-s">
      <h3>设置</h3>
      <div class="grid g3">
        <label class="row small"><input v-model="settings.inject" type="checkbox" />每次生成前注入实时数据</label>
        <label class="field">注入深度（0 = 最新消息之后）<input v-model.number="settings.injectDepth" type="number" min="0" max="20" /></label>
        <label class="field">注入角色
          <select v-model="settings.injectRole"><option value="system">system</option><option value="user">user</option><option value="assistant">assistant</option></select>
        </label>
        <label class="row small" title="让注入的文本参与世界书绿灯关键词扫描（例如车手名触发车手资料条目）"><input v-model="settings.scanWorldInfo" type="checkbox" />参与世界书关键词扫描</label>
        <label class="row small"><input v-model="settings.protocolReminder" type="checkbox" />在数据末尾附带指令格式提醒</label>
        <label class="row small"><input v-model="settings.hudEnabled" type="checkbox" />在 AI 回复末尾显示状态条</label>
        <label class="field">最多保留版本数<input v-model.number="settings.maxRevisions" type="number" min="8" max="200" /></label>
        <label class="row small" title="模拟练习赛/排位/正赛后自动发送一条消息让 AI 叙述"><input v-model="settings.autoNarrate" type="checkbox" />模拟后自动请求 AI 叙述</label>
      </div>
      <label class="field">「让 AI 叙述」时发送的消息<input v-model="settings.narrationText" type="text" /></label>
      <div class="grid g2 api-settings">
        <label class="field">车队工程师默认 API
          <select v-model="settings.engineerApi"><option value="main">主 API</option><option value="secondary">副 API</option></select>
        </label>
        <label class="field">副 API 站点（OpenAI 兼容）<input v-model="settings.engineerApiUrl" type="url" inputmode="url" placeholder="https://api.example.com/v1" /></label>
        <label class="field">副 API Key
          <span class="api-key-row">
            <input v-model="settings.engineerApiKey" :type="showApiKey ? 'text' : 'password'" autocomplete="new-password" :placeholder="settings.hasEngineerApiKey ? '已在本设备保存；留空则保持不变' : 'sk-…'" />
            <button v-if="settings.engineerApiKey" type="button" class="small ghost" @click="showApiKey = !showApiKey">{{ showApiKey ? '隐藏' : '显示' }}</button>
            <button v-else-if="settings.hasEngineerApiKey" type="button" class="small ghost danger" @click="clearApiKey">清除</button>
          </span>
        </label>
        <label class="field">副 API 模型<input v-model="settings.engineerModel" type="text" placeholder="例如 gpt-4o-mini" /></label>
        <label class="field">代理预设名称（可选，高级）<input v-model="settings.engineerProxyPreset" type="text" placeholder="留空则使用上面的站点和 Key" /></label>
      </div>
      <div class="tiny muted">副 API 可直接填写 OpenAI 兼容站点、Key 和模型。填写代理预设后将只使用该预设。</div>
      <div class="tiny muted">Key 由同一浏览器配置中的所有 F1 卡共用，不会写入角色卡、游戏存档或导出的存档文件。其他同源脚本仍可能访问浏览器数据，请勿在共享设备保存 Key。</div>
      <div class="row" style="justify-content: flex-end"><button class="primary small" @click="save">保存设置</button></div>
    </div>

    <div class="card">
      <h3>AI 数值指令日志</h3>
      <div v-if="!v.aiLog.length" class="tiny muted">AI 还没有输出过任何 &lt;F1M_UPDATE&gt; 指令。</div>
      <div v-for="(e, i) in v.aiLog" :key="i" class="small log" :class="{ bad: !e.ok }">
        <span class="mono tiny muted">{{ e.at }}{{ e.messageId !== null ? ` #${e.messageId}` : '' }}</span> {{ e.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.prompt {
  white-space: pre-wrap;
  max-height: 260px;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px;
  font-size: 11px;
}
.log {
  padding: 2px 0;
  border-bottom: 1px dashed var(--line);
}
.log.bad {
  color: #ff9a9a;
}
.api-key-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
}
.api-key-row input {
  min-width: 0;
}
</style>
