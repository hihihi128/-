<script setup lang="ts">
import { computed } from 'vue';
import { store } from '../bridge';

const v = computed(() => store.view!);
const me = computed(() => v.value.player.team.id);
const statusLabel = { done: '已结束', current: '进行中', upcoming: '未开始' } as const;
</script>

<template>
  <div class="stack">
    <div v-if="v.lastSeason" class="notice ok small">
      上赛季（{{ v.lastSeason.year }}）：车手冠军 {{ v.drivers.find(d => d.id === v.lastSeason!.driverChampion)?.name ?? '—' }} · 车队冠军
      {{ v.teams.find(t => t.id === v.lastSeason!.constructorChampion)?.name ?? '—' }} · 你的车队第 {{ v.lastSeason.playerPosition }}
    </div>

    <div class="grid g2">
      <div class="card">
        <h3>车队积分榜</h3>
        <table>
          <thead><tr><th>#</th><th>车队</th><th>积分</th><th>胜</th><th>领奖台</th></tr></thead>
          <tbody>
            <tr v-for="t in v.standings.teams" :key="t.teamId" :class="{ me: t.teamId === me }">
              <td class="mono">{{ t.pos }}</td>
              <td><span class="swatch" :style="{ background: t.color }"></span>{{ t.name }}</td>
              <td class="mono"><b>{{ t.points }}</b></td>
              <td class="mono">{{ t.wins }}</td>
              <td class="mono">{{ t.podiums }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3>赛历</h3>
        <table>
          <thead><tr><th>站</th><th>大奖赛</th><th>状态</th><th>冠军</th><th>本队最佳</th></tr></thead>
          <tbody>
            <tr v-for="r in v.calendar" :key="r.id" :class="{ me: r.status === 'current' }">
              <td class="mono">{{ r.index + 1 }}</td>
              <td>
                {{ r.name }}
                <span v-if="r.sprint" class="badge warn">冲刺</span>
                <div class="tiny muted">{{ r.trackName }} · {{ r.trackType }}{{ r.dateLabel ? ` · ${r.dateLabel}` : '' }}</div>
              </td>
              <td class="small">{{ statusLabel[r.status] }}</td>
              <td class="small">{{ r.winner ?? '—' }}</td>
              <td class="mono">{{ r.playerBest ? `P${r.playerBest}` : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>车手积分榜</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>车手</th><th>车队</th><th>积分</th><th>胜</th><th>领奖台</th>
              <th v-for="r in v.calendar" :key="r.id" class="tiny" :title="r.name">R{{ r.index + 1 }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in v.standings.drivers" :key="d.driverId" :class="{ me: d.teamId === me }">
              <td class="mono">{{ d.pos }}</td>
              <td><span class="swatch" :style="{ background: d.color }"></span>{{ d.name }}</td>
              <td class="small muted">{{ d.teamName }}</td>
              <td class="mono"><b>{{ d.points }}</b></td>
              <td class="mono">{{ d.wins }}</td>
              <td class="mono">{{ d.podiums }}</td>
              <td v-for="(res, i) in d.results" :key="i" class="mono tiny" :class="{ pos: res === 1, neg: res === 'DNF' }">{{ res ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
