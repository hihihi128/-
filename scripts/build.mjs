/**
 * 构建脚本：
 *   1. 打包悬浮管理面板（Vue → 单个 HTML）
 *   2. 打包后端脚本（TypeScript → 单个 JS，内联面板 HTML）
 *   3. 校验楼层状态条 HTML（正则替换串里的特殊符号）
 *   4. 组装 SillyTavern 角色卡（chara_card_v3 JSON + 内嵌数据的 PNG）
 *
 * 用法：npm run build
 */
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const cardDir = path.join(root, 'src/card');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const CARD_NAME = 'F1 领队模拟器';
const FILE_BASE = 'F1领队模拟器';
const BOOK_NAME = 'F1 领队模拟器';
const REPO = 'https://github.com/dododesk53-ship-it/-';

const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const readCard = p => fs.readFileSync(path.join(cardDir, p), 'utf8').trim();
const log = (...a) => console.log('[build]', ...a);

fs.mkdirSync(dist, { recursive: true });

// ───────────── 1. 面板 ─────────────
log('打包悬浮面板…');
await viteBuild({ configFile: path.join(root, 'vite.panel.config.ts'), logLevel: 'warn' });
const panelHtml = fs.readFileSync(path.join(dist, '.panel/index.html'), 'utf8');
fs.writeFileSync(path.join(dist, 'f1m-panel.html'), panelHtml);
log(`面板 HTML：${(panelHtml.length / 1024).toFixed(1)} KB`);

// ───────────── 2. 后端 ─────────────
log('打包后端脚本…');
const res = await esbuild({
  entryPoints: [path.join(root, 'src/tavern/index.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  loader: { '.html': 'text' },
  write: false,
  banner: { js: `/* F1 领队模拟器 · 后端脚本 v${VERSION} · 源码：${REPO} */` },
});
let backend = res.outputFiles[0].text;
// 脚本会被放进 <script type="module"> 里执行，必须转义字符串中的 </script
backend = backend.replace(/<\/(script)/gi, '<\\/$1');
if (/<\/script/i.test(backend)) throw new Error('后端脚本中仍有未转义的 </script>');
fs.writeFileSync(path.join(dist, 'f1m-backend.js'), backend);
log(`后端 JS：${(backend.length / 1024).toFixed(1)} KB`);

// ───────────── 3. 状态条 ─────────────
const hud = read('src/ui/hud/hud.html').trim();
const forbidden = [
  [/\{\{/, '「{{」会被酒馆当作宏替换'],
  [/\$\d/, '「$数字」会被正则当作捕获组'],
  [/\$</, '「$<」会被正则当作命名捕获组'],
  [/```/, '「```」会提前结束代码块'],
  [/<(user|bot|char)>/i, '<user>/<bot>/<char> 会被酒馆替换'],
];
for (const [re, why] of forbidden) {
  if (re.test(hud)) throw new Error(`状态条 HTML 不合法：${why}`);
}
if (!/<body/i.test(hud)) throw new Error('状态条 HTML 必须包含 <body>，酒馆助手才会把它渲染成前端界面');
fs.writeFileSync(path.join(dist, 'f1m-hud.html'), hud);

// ───────────── 4. 角色卡 ─────────────
log('组装角色卡…');

/** SillyTavern 世界书条目（v2 character_book 格式 + ST 扩展字段） */
function entry(id, comment, content, opt = {}) {
  const constant = opt.constant ?? false;
  return {
    id,
    keys: opt.keys ?? [],
    secondary_keys: [],
    comment,
    content,
    constant,
    selective: !constant && (opt.keys?.length ?? 0) > 0,
    insertion_order: opt.order ?? 100,
    enabled: opt.enabled ?? true,
    position: opt.position === 0 ? 'before_char' : 'after_char',
    use_regex: false,
    extensions: {
      position: opt.position ?? 1,
      exclude_recursion: true,
      prevent_recursion: true,
      delay_until_recursion: false,
      display_index: id,
      probability: 100,
      useProbability: true,
      depth: opt.depth ?? 4,
      selectiveLogic: 0,
      group: '',
      group_override: false,
      group_weight: 100,
      scan_depth: null,
      case_sensitive: null,
      match_whole_words: null,
      use_group_scoring: false,
      automation_id: '',
      role: 0,
      vectorized: false,
      sticky: 0,
      cooldown: 0,
      delay: 0,
    },
  };
}

const wb = 'worldbook';
const teamLore = [
  { id: 7, slug: 'ferrari', name: '法拉利车队（2026）', keys: ['法拉利', 'Ferrari', '马拉内罗', '埃尔坎', '瓦塞尔', '瓜尔蒂耶里', 'SF-26', '过渡领队'] },
  { id: 10, slug: 'mclaren', name: '迈凯伦车队（2026）', keys: ['迈凯伦', 'McLaren', '斯特拉', '扎克·布朗', 'MCL40'] },
  { id: 11, slug: 'mercedes', name: '梅赛德斯车队（2026）', keys: ['梅赛德斯', 'Mercedes', '梅奔', 'Toto Wolff', '托托', 'W17', '压缩比'] },
  { id: 12, slug: 'redbull', name: '红牛车队（2026）', keys: ['红牛车队', 'Red Bull Racing', '梅基斯', 'RB23'] },
  { id: 13, slug: 'aston-martin', name: '阿斯顿·马丁车队（2026）', keys: ['阿斯顿·马丁', 'Aston Martin', 'AMR26', '劳伦斯·斯特罗尔'] },
  { id: 14, slug: 'racing-bulls', name: '小红牛车队（2026）', keys: ['小红牛', 'Racing Bulls', 'VCARB', '佩尔曼'] },
  { id: 15, slug: 'audi', name: '奥迪车队（2026）', keys: ['奥迪', 'Audi', '比诺托'] },
  { id: 16, slug: 'cadillac', name: '凯迪拉克车队（2026）', keys: ['凯迪拉克', 'Cadillac', '格雷姆·洛登'] },
  { id: 17, slug: 'alpine', name: '阿尔派车队（2026）', keys: ['阿尔派', 'Alpine', '布里亚托利', 'A526'] },
  { id: 18, slug: 'haas', name: '哈斯车队（2026）', keys: ['哈斯', 'Haas', '丰田', 'Toyota Gazoo Racing', '小松礼雄', 'Gene Haas', '吉恩·哈斯'] },
  { id: 19, slug: 'williams', name: '威廉姆斯车队（2026）', keys: ['威廉姆斯', 'Williams', 'James Vowles', '沃尔斯', 'FW48'] },
];
const driverLore = [
  { id: 8, slug: 'hamilton', name: '刘易斯·汉密尔顿', keys: ['刘易斯·汉密尔顿', '汉密尔顿', '刘易斯', 'Lewis Hamilton', 'Hamilton'] },
  { id: 9, slug: 'leclerc', name: '夏尔·勒克莱尔', keys: ['夏尔·勒克莱尔', '勒克莱尔', '夏尔', 'Charles Leclerc', 'Leclerc'] },
  { id: 20, slug: 'russell', name: '乔治·拉塞尔', keys: ['乔治·拉塞尔', '拉塞尔', 'George Russell', 'Russell'] },
  { id: 21, slug: 'antonelli', name: '基米·安东内利', keys: ['基米·安东内利', '安东内利', 'Kimi Antonelli', 'Antonelli'] },
  { id: 22, slug: 'norris', name: '兰多·诺里斯', keys: ['兰多·诺里斯', '诺里斯', 'Lando Norris', 'Norris'] },
  { id: 23, slug: 'piastri', name: '奥斯卡·皮亚斯特里', keys: ['奥斯卡·皮亚斯特里', '皮亚斯特里', 'Oscar Piastri', 'Piastri'] },
  { id: 24, slug: 'verstappen', name: '马克斯·维斯塔潘', keys: ['马克斯·维斯塔潘', '维斯塔潘', '维斯塔彭', 'Max Verstappen', 'Verstappen'] },
  { id: 25, slug: 'hadjar', name: '伊萨克·哈贾尔', keys: ['伊萨克·哈贾尔', '哈贾尔', 'Isack Hadjar', 'Hadjar'] },
  { id: 26, slug: 'albon', name: '亚历山大·阿尔本', keys: ['亚历山大·阿尔本', '阿尔本', 'Alexander Albon', 'Albon'] },
  { id: 27, slug: 'sainz', name: '卡洛斯·塞恩斯', keys: ['卡洛斯·塞恩斯', '塞恩斯', 'Carlos Sainz', 'Sainz'] },
  { id: 28, slug: 'lawson', name: '利亚姆·劳森', keys: ['利亚姆·劳森', '劳森', 'Liam Lawson', 'Lawson'] },
  { id: 29, slug: 'lindblad', name: '阿尔维德·林德布拉德', keys: ['阿尔维德·林德布拉德', '林德布拉德', 'Arvid Lindblad', 'Lindblad'] },
  { id: 30, slug: 'alonso', name: '费尔南多·阿隆索', keys: ['费尔南多·阿隆索', '阿隆索', 'Fernando Alonso', 'Alonso'] },
  { id: 31, slug: 'stroll', name: '兰斯·斯特罗尔', keys: ['兰斯·斯特罗尔', '兰斯', 'Lance Stroll'] },
  { id: 32, slug: 'ocon', name: '埃斯特班·奥孔', keys: ['埃斯特班·奥孔', '奥孔', 'Esteban Ocon', 'Ocon'] },
  { id: 33, slug: 'bearman', name: '奥利弗·贝尔曼', keys: ['奥利弗·贝尔曼', '贝尔曼', 'Oliver Bearman', 'Bearman'] },
  { id: 34, slug: 'hulkenberg', name: '尼科·霍肯伯格', keys: ['尼科·霍肯伯格', '霍肯伯格', 'Nico Hulkenberg', 'Nico Hülkenberg', 'Hulkenberg', 'Hülkenberg'] },
  { id: 35, slug: 'bortoleto', name: '加布里埃尔·博托莱托', keys: ['加布里埃尔·博托莱托', '博托莱托', 'Gabriel Bortoleto', 'Bortoleto'] },
  { id: 36, slug: 'gasly', name: '皮埃尔·加斯利', keys: ['皮埃尔·加斯利', '加斯利', 'Pierre Gasly', 'Gasly'] },
  { id: 37, slug: 'colapinto', name: '弗朗哥·科拉平托', keys: ['弗朗哥·科拉平托', '科拉平托', '克拉平托', 'Franco Colapinto', 'Colapinto'] },
  { id: 38, slug: 'bottas', name: '瓦尔特利·博塔斯', keys: ['瓦尔特利·博塔斯', '博塔斯', 'Valtteri Bottas', 'Bottas'] },
  { id: 39, slug: 'perez', name: '塞尔吉奥·佩雷斯', keys: ['塞尔吉奥·佩雷斯', '佩雷斯', 'Sergio Perez', 'Sergio Pérez', 'Perez', 'Pérez'] },
];
const book = {
  name: BOOK_NAME,
  entries: [
    entry(0, '[F1M] 叙事规则', readCard(`${wb}/narrator-rules.md`), { constant: true, position: 1, order: 100 }),
    entry(1, '[F1M数据] 规则', readCard(`${wb}/data-rules.yaml`), { enabled: false, order: 900 }),
    entry(2, '[F1M数据] 车队', readCard(`${wb}/data-teams.yaml`), { enabled: false, order: 901 }),
    entry(3, '[F1M数据] 车手', readCard(`${wb}/data-drivers.yaml`), { enabled: false, order: 902 }),
    entry(4, '[F1M数据] 赛道', readCard(`${wb}/data-tracks.yaml`), { enabled: false, order: 903 }),
    entry(5, '[F1M数据] 赛历', readCard(`${wb}/data-calendar.yaml`), { enabled: false, order: 904 }),
    entry(6, '[F1M资料] 车手资料模板（复制后使用）', readCard(`${wb}/lore-template.md`), { enabled: false, keys: ['填写车手名'], order: 200 }),
    ...teamLore.map((lore, index) => entry(lore.id, `[F1M资料] ${lore.name}`, readCard(`${wb}/lore-${lore.slug}.md`), { keys: lore.keys, order: 201 + index })),
    ...driverLore.map((lore, index) => entry(lore.id, `[F1M资料] ${lore.name}`, readCard(`${wb}/lore-driver-${lore.slug}.md`), { keys: lore.keys, order: 220 + index })),
  ],
};

/** SillyTavern 正则脚本；placement: 1 = 用户输入, 2 = AI 输出 */
function regex(id, scriptName, findRegex, replaceString, opt) {
  return {
    id,
    scriptName,
    findRegex,
    replaceString,
    trimStrings: [],
    placement: opt.placement ?? [2],
    disabled: false,
    markdownOnly: !!opt.markdownOnly,
    promptOnly: !!opt.promptOnly,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

const rid = n => `6f1e0a2c-0b1d-4c55-9a3e-0f1e0000000${n}`;
const regexScripts = [
  regex(rid(1), '[F1M] 状态条（显示）', '/<F1M_HUD\\/>/g', '```html\n' + hud + '\n```', { markdownOnly: true }),
  regex(rid(2), '[F1M] 状态条占位符（不发给AI）', '/<F1M_HUD\\/>/g', '', { promptOnly: true, placement: [1, 2] }),
  regex(rid(3), '[F1M] 数值指令（不发给AI）', '/<F1M_UPDATE>[\\s\\S]*?<\\/F1M_UPDATE>/gi', '', { promptOnly: true }),
  regex(
    rid(4),
    '[F1M] 数值指令（折叠显示）',
    '/<F1M_UPDATE>([\\s\\S]*?)<\\/F1M_UPDATE>/gi',
    '<details><summary>数值指令（已由引擎结算，见状态条）</summary>\n\n```\n$1\n```\n\n</details>',
    { markdownOnly: true },
  ),
  regex(rid(5), '[F1M] 数值指令生成中（隐藏）', '/<F1M_UPDATE>(?![\\s\\S]*<\\/F1M_UPDATE>)[\\s\\S]*$/gi', '（数值结算中…）', {
    markdownOnly: true,
  }),
];

const script = {
  type: 'script',
  enabled: true,
  name: 'F1M 后端（数值引擎 + 管理面板）',
  id: '0f1e0000-a5a5-4f1e-8f1e-000000000001',
  content: backend,
  info: `F1 领队模拟器后端 v${VERSION}\n- 独立数值引擎：车手能力、零件与赛车性能、研发、比赛逐圈模拟\n- 存档跟随楼层（重 roll / 删楼自动回滚）\n- 每次生成前注入实时数据；解析 AI 的 <F1M_UPDATE> 白名单指令\n- 按钮「F1管理面板」打开悬浮面板，「AI叙述」让 AI 叙述刚发生的事\n源码：${REPO}`,
  button: {
    enabled: true,
    buttons: [
      { name: 'F1管理面板', visible: true },
      { name: 'AI叙述', visible: true },
    ],
  },
  data: {},
  export_with: { data: true, button: true },
};

const now = new Date();
const data = {
  name: CARD_NAME,
  description: readCard('description.md'),
  personality: '',
  scenario: readCard('scenario.md'),
  first_mes: readCard('first_mes.md'),
  mes_example: '',
  creator_notes: readCard('creator_notes.md'),
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  character_book: book,
  tags: ['F1', '赛车', '经营', '模拟', '酒馆助手', '前端'],
  creator: '',
  character_version: VERSION,
  group_only_greetings: [],
  creation_date: Math.floor(now.getTime() / 1000),
  modification_date: Math.floor(now.getTime() / 1000),
  extensions: {
    talkativeness: '0.5',
    fav: false,
    world: BOOK_NAME,
    depth_prompt: { prompt: '', depth: 4, role: 'system' },
    regex_scripts: regexScripts,
    tavern_helper: { scripts: [script], variables: {} },
  },
};

const v1 = {
  name: data.name,
  description: data.description,
  personality: data.personality,
  scenario: data.scenario,
  first_mes: data.first_mes,
  mes_example: data.mes_example,
  creatorcomment: data.creator_notes,
  avatar: 'none',
  talkativeness: '0.5',
  fav: false,
  tags: data.tags,
  create_date: now.toISOString(),
};
const cardV3 = { spec: 'chara_card_v3', spec_version: '3.0', ...v1, data };
const cardV2 = { spec: 'chara_card_v2', spec_version: '2.0', ...v1, data };

fs.writeFileSync(path.join(dist, `${FILE_BASE}.json`), JSON.stringify(cardV3, null, 2));

// PNG：把角色卡写进 tEXt 块（chara = v2，ccv3 = v3）
function pngWithCard(pngBuf, chunks) {
  const sig = pngBuf.subarray(0, 8);
  if (sig.toString('hex') !== '89504e470d0a1a0a') throw new Error('头像不是 PNG');
  const out = [sig];
  let off = 8;
  while (off < pngBuf.length) {
    const len = pngBuf.readUInt32BE(off);
    const type = pngBuf.toString('latin1', off + 4, off + 8);
    const whole = pngBuf.subarray(off, off + 12 + len);
    off += 12 + len;
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const body = whole.subarray(8, 8 + len);
      const kw = body.toString('latin1', 0, body.indexOf(0)).toLowerCase();
      if (kw === 'chara' || kw === 'ccv3') continue;
    }
    if (type === 'IEND') {
      for (const [kw, text] of chunks) {
        const payload = Buffer.concat([Buffer.from(kw, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
        const head = Buffer.alloc(4);
        head.writeUInt32BE(payload.length);
        const typeBuf = Buffer.from('tEXt', 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, payload])) >>> 0);
        out.push(head, typeBuf, payload, crc);
      }
    }
    out.push(whole);
  }
  return Buffer.concat(out);
}

const b64 = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const avatar = fs.readFileSync(path.join(cardDir, 'avatar.png'));
fs.writeFileSync(
  path.join(dist, `${FILE_BASE}.png`),
  pngWithCard(avatar, [
    ['chara', b64(cardV2)],
    ['ccv3', b64(cardV3)],
  ]),
);

const jsonSize = fs.statSync(path.join(dist, `${FILE_BASE}.json`)).size;
const pngSize = fs.statSync(path.join(dist, `${FILE_BASE}.png`)).size;
log(`角色卡：dist/${FILE_BASE}.json（${(jsonSize / 1024).toFixed(1)} KB），dist/${FILE_BASE}.png（${(pngSize / 1024).toFixed(1)} KB）`);
fs.rmSync(path.join(dist, '.panel'), { recursive: true, force: true });
log('完成');
