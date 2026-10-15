# F1 领队模拟器 · 交接文档

更新时间：2026-10-12（UTC）
当前分支：`vorflux/f1-complete-handoff`
当前唯一 PR：https://github.com/dododesk53-ship-it/-/pull/5
旧 PR 1–4 已停用；旧远端分支已删除。

## 1. 现状

- 框架代码已经完成并推送。功能说明和使用方法见 `README.md`。
- 单元测试、集成测试、类型检查、构建都已通过。
- 在「模拟酒馆环境」的本地开发页里，人工检查过悬浮面板的 7 个页面和楼层状态条。
- 2026-10-12 已在真实的 SillyTavern 1.19 + 酒馆助手里做了端到端测试，并完成代码审查和修复，结果见第 4 节。
- 2026-10-12 占位数据扩到 11 支车队（每队 2 名正式车手），默认规则改成 2026 赛季数值，见第 6 节第 7 条。
- 2026-10-12 后端改成 2026 规则（排位 6/6/10、超车模式与 Boost 取代 DRS、内燃机 / 能量回收系统拆分与配额罚退），并写入法拉利车队与「过渡领队」机制，见第 6 节第 8 条。分支 `vorflux/f1-2026-ferrari`。
- 2026-10-12 车队与车手换成 2026 年真实阵容，并按用户给出的平均单圈差距重新校准，见第 6 节第 9 条。分支 `vorflux/f1-2026-grid-data`。
- 2026-10-12 已实现 ADUO 后端、动力单元厂商 / 客户车队供应关系和认证升级次数，见第 6 节第 10 条。分支 `vorflux/f1-aduo-ui`。
- F1 TV 转播风格界面已写入 Vue 面板与 HUD，待完成浏览器和真实 SillyTavern 验证，见第 6 节第 11 条。

## 2. 交付物

| 文件 | 说明 |
| --- | --- |
| `dist/F1领队模拟器.png` | 角色卡（推荐导入这个） |
| `dist/F1领队模拟器.json` | 同一张卡的 JSON 版本（chara_card_v3） |
| `dist/f1m-backend.js` | 后端脚本，已内嵌进角色卡 |
| `dist/f1m-panel.html` | 悬浮管理面板，已内嵌进后端脚本 |
| `dist/f1m-hud.html` | 楼层状态条，已内嵌进正则 |

导入方法：导入 PNG → 导入内嵌世界书选「是」→ 允许角色脚本（酒馆助手弹窗）和角色正则 → 点输入框附近的「F1管理面板」开局。

## 3. 需求对照

| 需求 | 实现位置 |
| --- | --- |
| 玩家扮演车队领队 | `src/card/description.md`、世界书 `[F1M] 叙事规则` |
| 2026 数据 | 世界书 `[F1M数据]` 条目包含 11 队、22 名正式车手、完整 24 站季前公布赛历和 24 条赛道；引擎测试继续使用占位车队夹具 |
| 调研酒馆助手能做什么 | `README.md` 第一节 |
| 车手水平 | `src/engine/ratings.ts`（6 项能力 + 心态 / 信任 / 体能 / 状态 / 自尊心，成长与衰退在 `season.ts`） |
| 零件升级 | `src/engine/development.ts`（研发方案、隐藏的真实收益、交付件数、生产、设施、训练） |
| 赛车水平 | `ratings.ts` 的 `carRatings` / `trackScore`（8 类零件 → 5 项属性 + 可靠性 → 赛道适配分） |
| 领队的策略选择 | `weekend.ts`、`race.ts`、`strategy.ts`（练习项目、排位方案、轮胎策略、驾驶模式、进站时机、安全车进站、车队指令） |
| 升级件给哪位车手 | 每台车独立装件（`fitPart`）；正赛前检查分配公平性（`season.ts` 的 `applyAllocationFairness`）；优先车手（`actions.ts` 的 `setPriority`） |
| 独立引擎，存档跟随楼层 | `src/tavern/store.ts` + `controller.ts` |
| 悬浮面板 + 楼层状态条 | `src/ui/panel/`（Vue 3）、`src/ui/hud/hud.html` |

## 4. 验证情况

已验证（本会话实际运行）：

- `npm test`：12 个文件、121 个测试全部通过（2026 规则、法拉利机制、真实数据和 ADUO 有单独测试文件）。
  - 引擎：数据校验、完整赛季、可复现、研发与装件、封闭车辆规则、分配不公、预算帽 / 风洞 / 槽位、比赛统计、车队指令、AI 指令、提示词防剧透。
  - 控制器（假酒馆环境）：楼层回滚、swipe、编辑、版本清理、导入导出、读档。
  - 打包产物冒烟测试：在 jsdom 里加载 `dist/f1m-backend.js`。
- `npm run typecheck`（vue-tsc）通过；`npm run build` 成功。
- 21 站的合成赛历跑完整赛季约 0.4 秒；退赛率约 6~7%；赛季末存档约 60 KB（压缩前）。
- 本地开发页（`npm run dev`，端口 5174）：开局、各页面渲染、推进赛程、AI 叙述、状态条显示本楼数值变化，都人工看过。

**真实酒馆端到端验证（2026-10-12，SillyTavern 1.19 release + 酒馆助手 + 假 OpenAI 服务器）：**

| # | 项目 | 结果 |
| --- | --- | --- |
| 1 | 导入：内嵌世界书、正则授权、脚本授权、「F1管理面板」「AI叙述」两个按钮 | 通过 |
| 2 | `<F1M_HUD/>` 渲染成 iframe 状态条 | 通过 |
| 3 | 请求里有 `f1m_state` 实时数据；旧楼层 `<F1M_UPDATE>` 被提示词正则去掉 | 通过（看了假服务器的请求日志） |
| 4 | 发送、重新生成、swipe、继续生成、停止生成、编辑、删除楼层 | 通过（继续生成、停止生成是修复后通过） |
| 5 | srcdoc 面板加载 Vue，`window.parent.F1Manager` 可用 | 通过 |
| 6 | 刷新后存档保留；390×844 窄屏面板 | 通过（窄屏表头是修复后通过） |

E2E 中发现并已修复的问题：
- 继续生成：酒馆用「发给 AI 的版本」（指令块已被正则去掉）拼接续写，原指令丢失；本楼有面板操作时续写的指令也被丢弃。现在按正文对齐，把原文放回，再结算续写部分。
- 在第一个字之前停止生成：留下的 `...` 占位楼层曾被结算，消耗待叙述事件并加状态条。现在跳过。
- 重新开局 / 导入后，旧楼层会显示新对局的状态。现在指针带对局 id，版本号不再重复。
- 窄屏下面板表头的车队名被挤成一列。

代码审查中发现并已修复的问题：规则数据没有类型和范围校验；未验证零件的真实性能会通过赛车属性泄露；多名车手同时罚退时排位错误；AI 罚退指令绕过单条消息累计上限；设置保存失败时仍提示成功。

**仍未在真实酒馆里验证：** §7 的「升级件分配引发不满」新闻（所用种子没有触发，引擎单元测试有覆盖）和车队指令「偏向」检查。

## 5. 关键约定（改代码前必读）

| 项目 | 约定 |
| --- | --- |
| 数据来源 | 世界书里名字以 `[F1M数据]` 开头的条目（YAML，条目本身禁用）；读取顺序：角色卡绑定的世界书 → 全局世界书 → 角色卡内嵌 `character_book` |
| 存档版本库 | 聊天变量 `f1m_store`：完整快照用 lz-string 压缩，默认最多 30 个，近 12 楼引用的不会被清理 |
| 楼层变量 | `f1m_rev`（指针）、`f1m_ai_rev`（AI 结算后的版本）、`f1m_hash`（已结算文本的哈希）、`f1m_changes` / `f1m_narrated`（状态条显示用） |
| 设置 | 脚本变量 `settings` |
| 变化事件 | `f1m_changed`（走酒馆 eventSource；状态条用 `eventOn` 监听，面板用 `SillyTavern.getContext().eventSource` 监听） |
| 标签 | `<F1M_HUD/>` 状态条占位符；`<F1M_UPDATE>…</F1M_UPDATE>` AI 指令块，每行一个 JSON |
| 提示词 | 注入 id `f1m_state`，默认深度 1、system 角色；另注册了宏 `{{f1m_state}}` |
| 对外接口 | `window.F1Manager`：`status / view / hud / dispatch / preview* / loadData / newGame / listRevisions / restoreRevision / exportSave / importSave / getSettings / setSettings / requestNarration / reprocessLatest / openPanel / closePanel / togglePanel / subscribe` |
| 状态条 HTML | 会被原样放进正则替换串，所以不能出现 `{{`、`$数字`、`$<`、三个反引号、`<user>`/`<bot>`/`<char>`（`scripts/build.mjs` 会检查） |
| 后端打包 | 脚本在 `<script type="module">` 里执行，打包后会把 `</script` 转义成 `<\/script` |
| 随机性 | 随机数状态存在存档里，同一存档加同一操作得到同一结果；开局可选「每次重抽」 |
| AI 权限 | AI 只能改心态、信任、体能、董事会、媒体、士气、小额资金、新闻、罚退、剧情标记，并且有单条和累计上限；赛车性能、零件、比赛结果改不了 |

## 6. 已知风险与待办

1. **端到端测试缺失**（见第 4 节）。最可能出问题的地方：正则替换串在 ST 1.19 里的处理、酒馆助手对角色脚本的授权流程、追加 `<F1M_HUD/>` 时用到的 `setChatMessages` 与流式输出或其他扩展的交互。
2. **存档体积**：每个版本是完整快照（换成正式数据后，赛季末每个版本压缩后约 20~30 KB），30 个版本最多约 1 MB，存在聊天元数据里。如果保存变慢，可以改成「关键帧 + 差分」存储，或者调低版本上限。
3. **回滚语义**：面板操作挂在最新楼层。如果之后重 roll 这一楼，这些操作会跟着旧 swipe 一起回滚。这是有意的设计，需要确认玩家是否接受。
4. **数值平衡只用占位数据粗调过**：车队资金偏宽裕；安全车偏少（每场约 0.1~0.3 次）；大多数赛道一停最优。正式数据填好后需要重新调整 `rules` 里的参数。
5. **未实现**：群聊。合同市场、员工招聘、比赛中途变天和实时比赛决策已经实现，见文末“合同市场与实时正赛”。
6. **代码审查与精简没有做**。建议重点审查：
   - 引擎在极端数据下的健壮性（单车队、超短赛历、奇怪的 YAML）；
   - 控制器在重新生成、继续生成、停止生成时的事件顺序；
   - 角色卡 JSON 字段与酒馆助手 zod 结构、ST 导入逻辑的兼容性。
7. **11 支车队与 2026 规则**（2026-10-12）：
   - 默认规则：预算帽 215M；正赛积分 25-18-15-12-10-8-6-4-2-1，冲刺赛 8-1，最快圈不加分（与 2025 相同）；奖金表和风洞时长表各 11 档，第 11 名（新车队）风洞时长为 115%。
   - 占位数据：测试车队 A~K，每队 2 名正式车手，A 队另有 1 名替补。董事会目标排名 1~11。
   - 排位赛淘汰数已在第 8 条改为 6 / 6 / 10（`rules.qualiFinalists`）。
   - 预算帽为 215M。完整 24 站赛历已接入并通过整季流程测试，但经济和各车队特殊机制仍需要长期数值观察。
   - 存档快照变大：3 站后的单个快照 JSON 从约 36 KB 增加到约 82 KB（约 2.3 倍），第 2 条的估算要相应放大。

8. **2026 规则与法拉利**（2026-10-12，分支 `vorflux/f1-2026-ferrari`）：
   - 比赛：DRS 换成超车模式（`overtakeModeGap`、`overtakeModeBonus`，乘以能量回收系统系数）和 Boost（`boostAttack`、`boostDefence`，对应驾驶模式「进攻」）。
   - 零件：`power_unit` 改名「内燃机」，新增 `ers`「能量回收系统」。配额 `puAllocation`（4 / 3），超额罚退 `puPenaltyFirst` / `puPenaltyNext`（10 / 5），逻辑在 `src/engine/powerunit.ts`。
   - 法拉利：替换原测试车队 F（`team_f` → `ferrari`），车手 `hamilton`、`leclerc`，替补 `giovinazzi`。仍然是 11 队 22 车。
   - 过渡领队机制在 `src/engine/ferrari.ts`，阈值在 `rules.ferrari`。撤职时设置 `flags.fired` 和 `ferrari.dismissed`，之后除 `CLEAR_NARRATION` 以外的操作都被拒绝，玩家可以读档。
   - 车队数据的 `special` 字段决定特殊机制（目前只有 `ferrari`）。开局可填写「为什么被选中」（`meta.selectionReason`，最多 300 字）。
   - 新增世界书资料条目：法拉利、汉密尔顿、勒克莱尔（关键字触发）。
   - 新机制已接入 24 站整季流程测试；媒体、支持度、股东影响和车手留队阈值仍需根据长期游玩反馈调优。

9. **2026 真实阵容数值**（2026-10-12，分支 `vorflux/f1-2026-grid-data`）：
   - `data-teams.yaml`：11 支真实车队（id：`mercedes`、`mclaren`、`red_bull`、`ferrari`、`williams`、`racing_bulls`、`aston_martin`、`haas`、`audi`、`alpine`、`cadillac`），9 种零件全部写明 perf / rel。赛车数值按 2026 赛季实测的平均单圈差距（相对梅赛德斯，法拉利 +0.422 秒 … 阿斯顿·马丁 +3.783 秒）校准，计入了车手能力差，误差 < 0.02 秒；同一动力单元供应商的客户车队动力单元数值相同。
   - `data-drivers.yaml`：22 名正式车手 + 4 名替补（角田、乔维纳兹、杜汉、周冠宇），id 用姓氏小写。年薪与合同年份是估计值。
   - 引擎测试改用 `tests/fixtures/placeholder-teams.yaml` 与 `placeholder-drivers.yaml`（原占位数据），调整真实数值不会让引擎测试失效；`tests/engine/carddata.test.ts` 检查真实数据。
   - 24 条赛道已提供模拟基准圈速与需求权重。马德里参数按公开布局估算；全部参数仍需根据完整赛季结果继续调优。


10. **ADUO 后端**（2026-10-12，现收录于分支 `vorflux/f1-complete-handoff`，PR：https://github.com/dododesk53-ship-it/-/pull/5）：
   - 入口在 `src/engine/aduo.ts`。动力单元厂商车队用 `TeamDef.worksTeam` 标记。当前厂商车队是梅赛德斯、法拉利、红牛、奥迪、阿斯顿·马丁。
   - 客户车队不能自行研发 `power_unit` / `ers`。厂商车队的新件会复制给同一 `engine` 的客户车队；AI 客户自动装车，玩家客户收到新闻。
   - 每赛季基础认证升级次数为 1。动力单元设计项目开工时计数，取消时返还。旧存档迁移时，进行中的动力单元项目会计入次数。
   - 默认在第 6 / 12 / 18 站后评估。落后最佳厂商至少 2% 为一档，至少 4% 为二档。档位按未取整差距判断，显示值才取一位小数。
   - 一档 / 二档每次分别追加 1 / 2 次认证升级、3 / 5 M$ 本赛季预算帽额度，并把动力单元研发周期乘以 0.9 / 0.8。
   - 新赛季重置次数、档位和预算帽补偿，并把客户车队的动力单元规格与厂商同步。
   - `GameView.aduo` 只提供已公布的评估结果，不泄漏实时真实性能。AI 提示词也只显示公开状态。
   - 测试在 `tests/engine/aduo.test.ts`，覆盖客户限制、认证次数、取消返还、客户供件、评估档位、补偿、新赛季、旧存档和重复厂商校验。
   - 第一轮代码审查给出 7/10 高风险并阻止合并。提交 `86a67aa` 已修复审查发现的旧存档计数、门槛取整和评估站次问题。建议下一位开发者再做一次复审。

11. **F1 TV 转播风格界面**（设计与实现已完成）：
   - 全部文件在 `docs/designs/broadcast-ui/`。入口是 `design-plan.json`，设计令牌是 `tokens.css`，赛车线稿是 `car-topdown.svg`。
   - 桌面管理面板：左侧常驻排名塔。比赛时显示实时顺序、差距、轮胎、PIT / DNF / 最快圈；其他页面显示车手或车队积分榜。
   - 手机管理面板：390 px 宽适配，顶部是紧凑排名条；点击后从侧边展开完整排名塔；底部是「总览 / 比赛周末 / 车手 / 赛车 / 研发 / 更多」标签栏。
   - 研发页：2026 赛车俯视线稿有 9 个零件热点（SVG 组 id 为 `part-<partType>`）。热点按玩家可见的零件性能着色，点击后选择研发零件。
   - ADUO 卡：显示厂商 / 客户身份、公开差距、档位、升级次数、预算帽额度、研发周期倍率和下次评估站。客户车队的内燃机与 ERS 显示锁定。
   - HUD：`hud-desktop.html` 与 `hud-phone.html` 各包含正常、法拉利、比赛周末、旧楼层变暗、尚未开局五种状态。
   - 已实现 `TimingTower.vue`、`CarTopdown.vue`、`AduoCard.vue`、`MobileTabBar.vue`，并把转播设计令牌合并到面板与 HUD 样式。
   - 排名塔、赛车热点和 ADUO 卡都读取实时 `GameView` 数据；未验证零件只显示预估值，不向前端暴露真实性能。
   - `src/tavern/panelHost.ts` 已在手机宽度使用带安全区边距的近全屏面板；桌面继续使用可拖动浮动面板。
   - `npm run typecheck`、`npm test`（124 项）和 `npm run build` 已通过。980×720 与 390×844 浏览器检查已通过；仍需在真实 SillyTavern 中检查 HUD 和 iframe 高度。
   - 设计稿中的阿斯顿·马丁 / 本田 ADUO、摩纳哥第 8 站、积分和比赛顺序都是示例，不是真实存档数据。

12. **本次停止点**：
   - 已完成：真实 2026 阵容、圈速差距校准、法拉利与 ADUO 后端、F1 TV 风格 Vue 面板与 HUD、手机近全屏面板、构建产物。
   - 法拉利世界书已补充底盘、动力单元、项目工程、空气动力、赛道工程、比赛策略和两位车手比赛工程师等关键人员。
   - 已完成：界面第二轮代码审查；980×720 与 390×844 浏览器测试；排名塔、手机导航和赛车热点的组件测试。
   - 未完成：真实 SillyTavern 端到端测试。

## 7. 建议的端到端测试步骤

1. 启动 SillyTavern 1.19：`git clone -b release https://github.com/SillyTavern/SillyTavern` → `npm install` → `node server.js`。
2. 安装酒馆助手：在 ST 扩展面板用仓库地址 https://github.com/N0VI028/JS-Slash-Runner 安装。
3. 准备一个假的 OpenAI 兼容服务（`POST /v1/chat/completions`，同时支持 `stream: true` 的 SSE，外加 `GET /v1/models`）：
   - 把请求体写进日志；
   - 返回一段叙事，末尾附带
     `<F1M_UPDATE>{"op":"morale","driver":"c1","delta":3}</F1M_UPDATE>`；
   - 每次请求换一个 delta，方便区分 swipe。
   在 ST 里选择「Chat Completion → Custom (OpenAI-compatible)」并填入这个地址。
4. 按第 4 节「未验证」的 6 项逐条检查，然后：
   - 研发完成后，把新件只装给一台车，下一场正赛前应出现「升级件分配引发不满」的新闻；
   - 设置车队指令「偏向」，比赛事件里应出现让车或抗命。
5. 本地开发页 `npm run dev` 可以在不装 ST 的情况下调试面板和状态条。
   在没有中文字体的 Linux 截图环境里，可以把 `DroidSansFallbackFull.ttf` 复制到 `dev/public/cjk.ttf`（已被 gitignore）来显示中文。

## 8. 开发命令

```bash
npm install
npm test          # 测试
npm run typecheck # 类型检查
npm run build     # 生成 dist/（角色卡、后端、面板、状态条）
npm run dev       # 本地开发页 http://localhost:5174（先 build 一次）
```

目录结构见 `README.md` 第五节。

## 9. 调研参考

- 酒馆助手文档：https://n0vi028.github.io/JS-Slash-Runner-Doc/
- 酒馆助手源码与类型定义：https://github.com/N0VI028/JS-Slash-Runner（`@types/`）
- 编写模板：https://github.com/StageDog/tavern_helper_template
- MVU 变量框架：https://github.com/MagicalAstrogy/MagVarUpdate（本卡没有使用）
- 法拉利官方车队与技术管理人员：https://www.ferrari.com/en-EN/formula1/team
- 法拉利组织调整（塞拉、蒙特基等）：https://www.ferrari.com/en-EN/formula1/articles/organisational-changes
- 2026 比赛工程师资料：https://www.formula1.com/en/latest/article/hamilton-to-get-new-race-engineer-for-2026-season-as-adami-moves-to-ferrari.1WVOwZfz9mnJ1XKjmgz8Yu
- 本次实现依赖的几个行为（来自源码阅读）：
  - 酒馆助手只把内容包含 `html>`、`<head>` 或 `<body` 的代码块渲染成前端界面。
  - 角色脚本存放在 `data.extensions.tavern_helper.scripts`（数组）。
  - 楼层变量按 swipe 分开存（`chat[i].variables[swipe_id]`）。
  - ST 的「重新生成」会在 `GENERATION_AFTER_COMMANDS` 之后才删除最后一条 AI 消息，所以注入时要用上一楼的状态。
  - 正则替换串会先处理 `{{match}}` 和 `$1`、`$<name>`，再做宏替换。
# 合同市场与实时正赛（本次交接）

- 面板的「车手」页在市场开放时提供“本队阵容 / 车手市场与员工招聘”切换。候选列表、报价表、接受分解、买断 / 解约费用、市场阻塞和 AI 市场处理都读取 `GameView.market` 与 `previewContractOffer()`；不会显示对手资金、私下报价或隐藏偏好。
- 「比赛周末」在正赛或冲刺赛阶段提供实时比赛控制。它使用 `START_RACE`、`ADVANCE_RACE`、`SET_RACE_TACTICS` 与 `RESOLVE_RACE_DECISION` 的会话 / 修订 / 窗口令牌。桌面同时显示两车遥测和事件；390px 手机将确认操作固定在安全区上方。
- 计时塔优先使用 `GameView.weekend.liveRace.timing`，并明确标记 LIVE；完赛后才回退到结果分类。HUD 只显示公开的圈数、SC/VSC 与是否等待决策，链接到比赛周末。
- 打包前请运行 `npm run typecheck && npm test && npm run build`。实际 SillyTavern 仍需验证 iframe、HUD 重载、长比赛恢复和公共预览。
