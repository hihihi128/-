# 交接文档：迷你状态卡与超自然干预

日期：2026-10-13
分支：`vorflux/haas-alpine-williams`
PR：https://github.com/hihihi128/-/pull/5
最终提交：`e2c7b9a`（全部已推送）

## 1. 当前状态

已实现并通过全部自动化验证（26 个测试文件、236 项测试；typecheck、build 通过）：

- **迷你状态卡**：标题栏新增「−」最小化按钮；缩成可拖动小卡，实时显示车队、赛季、站次、阶段、待叙述数、生成状态；点击/Enter/Space 还原；iframe 全程保留不重载；手机可用。
- **超自然人设模式**：开局首屏默认关闭的开关；仅保存到本局（`GameMeta.supernaturalMode`）；旧存档迁移默认 false。
- **超自然干预面板**：桌面头部按钮 + 手机「更多」入口；白名单卡片显示真实硬上限与每类可用性；描述框限 1000 字；复用所选主/副策略 API；严格解析 `<F1M_UPDATE>` JSON 数组；每次一条 `ui` 存档版本；不触发叙述。
- **硬上限**（`src/engine/supernatural.ts` `SUPERNATURAL_LIMITS`）：心态/信任/体能 ±10/10/20；董事会/媒体/士气 ±8/10/10；车手属性、员工技能每人 ±1；资金每次 ±$3M（余额边界 $0–500M，不吸附旧存档越界值）；研发每局最多提前 1 周（重复行共享额度，不提前交付）；天气倾向每次 ±0.10、累计 ±0.20；调校单项 ±10、本站总偏移 ±15。

## 2. 本轮已修复的评审问题

两轮评审共提出 4 高、6 中、若干低。已修复并加回归测试（`tests/engine/supernatural.test.ts` 现 10 项）：

1. 资金越界吸附（负余额一次拉回 0）→ 只按请求方向应用受限增量。
2. 天气干预第 2 站起失效（旧 weekend 阻塞）→ 仅 `state.weekend?.roundIndex === state.season.roundIndex` 时拒绝。
3. 员工技能回退值错误（risk 应为 70 而非 skill）→ 使用 `staffAbility()`。
4. 同一次调用重复研发行可多周 → `research_progress` 每次调用共享 1 周额度。
5. 调校饱和时请求方向反转 → `inRequestedDirection`，饱和即拒绝。
6. 迁移时 `state.supernatural` 为原始值会抛错 → 迁移先验证对象。
7. 16KiB 限制按字符计数 → 改为 UTF-8 字节数。
8. 撤职后才拒绝（浪费一次 API）→ 生成前即拒绝。
9. 超自然 reason 泄入普通叙述提示词 → 已从叙述 prompt 排除。
10. 桌面最小化后还原位置/最大化错乱、拖动后首次点击失效、resize 不保存 → PanelHost 修复（`dc8060e`）。
11. 「最近干预记录」显示最旧 8 条 → 改 `.slice(0, 8)`。
12. 模态键盘焦点/Esc 失效、游戏切换不清草稿、结果可读性、每类可用性、季节末误报可用 → 已修（`7d2ce1e` + `e2c7b9a`）。

## 3. 待办（额度耗尽未做）

按优先级排序，接手后从这里继续：

1. **完整测试执行**（最重要）。测试代理已完成环境搭建但未执行计划：
   - 预览：`http://localhost:5184` / https://iqpdfn6k0lxk.preview.us1.vorflux.com（可能需重启）。
   - 已备好主/副 API 受控响应、开关两版生产数据存档、桌面 1440×900 与手机 390×844 上下文。
   - 计划要点：iframe+草稿跨最小化存活、键盘焦点流、受控结果渲染、中文响应式排版、无限次数但每次受限、天气/研发/调校效果、普通叙述隔离。
   - 全部验证完成后用标题 `Result` 重新提交测试报告（现有报告 ID 1074，勿新建）。
2. **低优先评审遗留**：
   - 超自然 reason 仍写入 `aiLog`（已不入叙述 prompt）；如需更严格可截短或过滤。
   - 迷你卡「AI 生成中」依赖 `notify()`；`onGenerationStart` 未调用 `notify()`，生成状态更新可能滞后。
   - 每次 notify 构建两次完整视图（`view()` + `hud()`），可合并。
   - `tests/ui/supernatural-ui.test.ts` 仍是源码字符串断言，未挂载组件。
   - 评审还建议补：零偏差天气确定性、forecast/trajectory 同概率、timeout/晚到响应、并发请求、无叙述调用、正赛中拒绝、调校在排位/正赛的生效与过期等测试。
3. **PR 收尾**：更新 PR 5 正文（迷你卡、超自然模式、上限表、验证证据）；全部通过后按需标记 ready。
4. **计划文档**：批准计划在 `/code/.plans/v1-mini-supernatural.md`；设计稿 6 份在 `/code/.plans/designs/`。

## 4. 关键入口

| 内容 | 文件 |
| --- | --- |
| 白名单、解析、上限、应用 | `src/engine/supernatural.ts` |
| 控制器入口（守卫、提示词、提交） | `src/tavern/controller.ts` `requestSupernaturalIntervention` |
| 面板 API | `src/tavern/api.ts` `requestSupernaturalIntervention` |
| 干预模态 | `src/ui/panel/components/SupernaturalPanel.vue` |
| 开局开关 | `src/ui/panel/views/NewGame.vue` |
| 迷你卡宿主 | `src/tavern/panelHost.ts` |
| 公开视图数据（含每类可用性） | `src/engine/view.ts` `supernaturalAvailability` |
| 引擎测试 | `tests/engine/supernatural.test.ts` |
| 宿主测试 | `tests/tavern/panelHost.test.ts` |

## 5. 验证命令

```bash
npm run typecheck
npm test -- --run
npm run build
```

当前全部通过（26 文件 / 236 测试）。
