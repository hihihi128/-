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
  { id: 12, slug: 'redbull', name: '红牛车队（2026）', keys: ['红牛车队', 'Red Bull Racing', '梅基斯', 'RB22'] },
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
  { id: 9, slug: 'leclerc', name: '夏尔·勒克莱尔', keys: ['夏尔·勒克莱尔', '勒克莱尔', 'Charles Leclerc', 'Leclerc'] },
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
  { id: 31, slug: 'stroll', name: '兰斯·斯特罗尔', keys: ['兰斯·斯特罗尔', '兰斯', 'Lance Stroll', 'Stroll'] },
  { id: 32, slug: 'ocon', name: '埃斯特班·奥孔', keys: ['埃斯特班·奥孔', '奥孔', 'Esteban Ocon', 'Ocon'] },
  { id: 33, slug: 'bearman', name: '奥利弗·贝尔曼', keys: ['奥利弗·贝尔曼', '贝尔曼', 'Oliver Bearman', 'Bearman'] },
  { id: 34, slug: 'hulkenberg', name: '尼科·霍肯伯格', keys: ['尼科·霍肯伯格', '霍肯伯格', 'Nico Hulkenberg', 'Nico Hülkenberg', 'Hulkenberg', 'Hülkenberg'] },
  { id: 35, slug: 'bortoleto', name: '加布里埃尔·博托莱托', keys: ['加布里埃尔·博托莱托', '博托莱托', 'Gabriel Bortoleto', 'Bortoleto'] },
  { id: 36, slug: 'gasly', name: '皮埃尔·加斯利', keys: ['皮埃尔·加斯利', '加斯利', 'Pierre Gasly', 'Gasly'] },
  { id: 37, slug: 'colapinto', name: '弗朗哥·科拉平托', keys: ['弗朗哥·科拉平托', '科拉平托', '克拉平托', 'Franco Colapinto', 'Colapinto'] },
  { id: 38, slug: 'bottas', name: '瓦尔特利·博塔斯', keys: ['瓦尔特利·博塔斯', '博塔斯', 'Valtteri Bottas', 'Bottas'] },
  { id: 39, slug: 'perez', name: '塞尔吉奥·佩雷斯', keys: ['塞尔吉奥·佩雷斯', '佩雷斯', 'Sergio Perez', 'Sergio Pérez', 'Perez', 'Pérez'] },
];
const leadershipLore = [
  { id: 40, team: 'mercedes', role: 'principal', slug: 'mercedes-toto-wolff', name: '托托·沃尔夫', keys: ['托托·沃尔夫', '托托', 'Toto Wolff'] },
  { id: 41, team: 'mercedes', role: 'technical', slug: 'mercedes-james-allison', name: '詹姆斯·艾利森', keys: ['詹姆斯·艾利森', '艾利森', 'James Allison'] },
  { id: 42, team: 'mclaren', role: 'principal', slug: 'mclaren-andrea-stella', name: '安德里亚·斯特拉', keys: ['安德里亚·斯特拉', '斯特拉', 'Andrea Stella'] },
  { id: 43, team: 'mclaren', role: 'executive', slug: 'mclaren-zak-brown', name: '扎克·布朗', keys: ['扎克·布朗', 'Zak Brown'] },
  { id: 44, team: 'red_bull', role: 'principal', slug: 'red-bull-laurent-mekies', name: '洛朗·梅基斯', keys: ['洛朗·梅基斯', '梅基斯', 'Laurent Mekies'] },
  { id: 45, team: 'red_bull', role: 'technical', slug: 'red-bull-pierre-wache', name: '皮埃尔·瓦谢', keys: ['皮埃尔·瓦谢', '瓦谢', 'Pierre Waché', 'Pierre Wache'] },
  { id: 46, team: 'ferrari', role: 'owner', slug: 'ferrari-john-elkann', name: '约翰·埃尔坎', keys: ['约翰·埃尔坎', '埃尔坎', 'John Elkann'] },
  { id: 47, team: 'ferrari', role: 'deputy', slug: 'ferrari-jerome-dambrosio', name: '热罗姆·达姆布罗西奥', keys: ['热罗姆·达姆布罗西奥', '达姆布罗西奥', '丹布罗西奥', "Jérôme d'Ambrosio", "Jerome d'Ambrosio"] },
  { id: 48, team: 'williams', role: 'principal', slug: 'williams-james-vowles', name: '詹姆斯·沃尔斯', keys: ['詹姆斯·沃尔斯', '沃尔斯', 'James Vowles'] },
  { id: 49, team: 'williams', role: 'technical', slug: 'williams-pat-fry', name: '帕特·弗莱', keys: ['帕特·弗莱', 'Pat Fry'] },
  { id: 50, team: 'racing_bulls', role: 'principal', slug: 'racing-bulls-alan-permane', name: '艾伦·佩尔曼', keys: ['艾伦·佩尔曼', '佩尔曼', 'Alan Permane'] },
  { id: 51, team: 'racing_bulls', role: 'technical', slug: 'racing-bulls-tim-goss', name: '蒂姆·戈斯', keys: ['蒂姆·戈斯', '戈斯', 'Tim Goss'] },
  { id: 52, team: 'aston_martin', role: 'principal', slug: 'aston-martin-adrian-newey', name: '阿德里安·纽维', keys: ['阿德里安·纽维', '纽维', 'Adrian Newey'] },
  { id: 53, team: 'aston_martin', role: 'owner', slug: 'aston-martin-lawrence-stroll', name: '劳伦斯·斯特罗尔', keys: ['劳伦斯·斯特罗尔', 'Lawrence Stroll'] },
  { id: 54, team: 'haas', role: 'principal', slug: 'haas-ayao-komatsu', name: '小松礼雄', keys: ['小松礼雄', '小松', 'Ayao Komatsu'] },
  { id: 55, team: 'haas', role: 'owner', slug: 'haas-gene-haas', name: '吉恩·哈斯', keys: ['吉恩·哈斯', 'Gene Haas'] },
  { id: 56, team: 'audi', role: 'principal', slug: 'audi-mattia-binotto', name: '马蒂亚·比诺托', keys: ['马蒂亚·比诺托', '比诺托', 'Mattia Binotto'] },
  { id: 57, team: 'audi', role: 'technical', slug: 'audi-james-key', name: '詹姆斯·基', keys: ['詹姆斯·基', 'James Key'] },
  { id: 58, team: 'alpine', role: 'principal', slug: 'alpine-flavio-briatore', name: '弗拉维奥·布里亚托利', keys: ['弗拉维奥·布里亚托利', '布里亚托利', 'Flavio Briatore'] },
  { id: 59, team: 'alpine', role: 'technical', slug: 'alpine-david-sanchez', name: '大卫·桑切斯', keys: ['大卫·桑切斯', 'David Sanchez'] },
  { id: 60, team: 'cadillac', role: 'co_principal', slug: 'cadillac-graeme-lowdon', name: '格雷姆·洛登', keys: ['格雷姆·洛登', '洛登', 'Graeme Lowdon'] },
  { id: 61, team: 'cadillac', role: 'technical', slug: 'cadillac-nick-chester', name: '尼克·切斯特', keys: ['尼克·切斯特', '切斯特', 'Nick Chester'] },
];
const strategyLore = [
  { id: 62, team: 'mercedes', slug: 'mercedes', name: '梅赛德斯策略组', strategist: '罗茜·韦特', keys: ['梅赛德斯策略组', '梅赛德斯策略团队', '罗茜·韦特'] },
  { id: 63, team: 'mclaren', slug: 'mclaren', name: '迈凯伦策略组', strategist: '兰迪普·辛格', keys: ['迈凯伦策略组', '迈凯伦策略团队', '兰迪普·辛格'] },
  { id: 64, team: 'red_bull', slug: 'red-bull', name: '红牛策略组', strategist: '汉娜·施密茨', keys: ['汉娜·施密茨', '施密茨'] },
  { id: 65, team: 'ferrari', slug: 'ferrari', name: '法拉利策略组', strategist: '拉文·贾恩', keys: ['法拉利策略组', '法拉利策略团队', '拉文·贾恩'] },
  { id: 66, team: 'williams', slug: 'williams', name: '威廉姆斯策略组', strategist: '夏尔-安托万·弗洛朗坦', keys: ['威廉姆斯策略组', '威廉姆斯策略团队', '夏尔-安托万·弗洛朗坦'] },
  { id: 67, team: 'racing_bulls', slug: 'racing-bulls', name: '小红牛策略组', strategist: '马蒂厄·迪布瓦-卢卡', keys: ['小红牛策略组', '小红牛策略团队', '马蒂厄·迪布瓦-卢卡'] },
  { id: 68, team: 'aston_martin', slug: 'aston-martin', name: '阿斯顿·马丁策略组', strategist: '彼得·霍尔', keys: ['阿斯顿·马丁策略组', '阿斯顿·马丁策略团队', '彼得·霍尔'] },
  { id: 69, team: 'haas', slug: 'haas', name: '哈斯策略组', strategist: '卡琳·克里德利希', keys: ['哈斯策略组', '哈斯策略团队', '卡琳·克里德利希'] },
  { id: 70, team: 'audi', slug: 'audi', name: '奥迪策略组', strategist: '里特维克·达南贾亚·雷迪', keys: ['奥迪策略组', '奥迪策略团队', '里特维克·达南贾亚·雷迪'] },
  { id: 71, team: 'alpine', slug: 'alpine', name: '阿尔派策略组', strategist: '奥里奥尔·伊塞恩', keys: ['阿尔派策略组', '阿尔派策略团队', '奥里奥尔·伊塞恩'] },
  { id: 72, team: 'cadillac', slug: 'cadillac', name: '凯迪拉克策略组', strategist: '亚历克斯·古迪纳夫', keys: ['凯迪拉克策略组', '凯迪拉克策略团队', '亚历克斯·古迪纳夫'] },
];
const staffLore = [
  { id: 73, team: 'mercedes', slug: 'mercedes', name: '梅赛德斯技术与赛道核心组', keys: ['梅赛德斯核心组', '马库斯·达德利', '彼得·博宁顿', '博宁顿', '弗雷德里克·维斯蒂'] },
  { id: 74, team: 'mclaren', slug: 'mclaren', name: '迈凯伦技术与赛道核心组', keys: ['迈凯伦核心组', '罗布·马歇尔', '彼得·普罗德罗穆', '威尔·约瑟夫', '汤姆·斯托拉德', '莱昂纳多·福纳罗利', '帕托·奥沃德'] },
  { id: 75, team: 'red_bull', slug: 'red-bull', name: '红牛技术与赛道核心组', keys: ['詹皮耶罗·兰比亚塞', '兰比亚塞', '理查德·伍德', '角田裕毅'] },
  { id: 76, team: 'ferrari', slug: 'ferrari', name: '法拉利技术与赛道核心组', keys: ['法拉利核心组', '洛伊克·塞拉', '迭戈·通迪', '恩里科·瓜尔蒂耶里', '马泰奥·托尼纳利', '卡洛·桑蒂', '布莱恩·博齐', '安东尼奥·乔维纳兹'] },
  { id: 77, team: 'williams', slug: 'williams', name: '威廉姆斯技术与赛道核心组', keys: ['威廉姆斯核心组', '詹姆斯·厄文', '加埃唐·热戈', '卢克·布朗宁'] },
  { id: 78, team: 'racing_bulls', slug: 'racing-bulls', name: '小红牛技术与赛道核心组', keys: ['小红牛核心组', '亚历山大·伊利奥普洛斯', '皮埃尔·哈梅林', '岩佐步梦'] },
  { id: 79, team: 'aston_martin', slug: 'aston-martin', name: '阿斯顿·马丁技术与赛道核心组', keys: ['阿斯顿·马丁核心组', '恩里科·卡尔迪莱', '克里斯·克罗宁', '加里·甘农', '杰克·克劳福德'] },
  { id: 80, team: 'haas', slug: 'haas', name: '哈斯技术与赛道核心组', keys: ['哈斯核心组', '安德烈亚·德佐尔多', '劳拉·穆勒', '罗南·奥黑尔', '杰克·杜汉', '平川亮'] },
  { id: 81, team: 'audi', slug: 'audi', name: '奥迪技术与赛道核心组', keys: ['奥迪核心组', '史蒂文·佩特里克', '何塞·曼努埃尔·洛佩斯', '泰奥·普尔谢尔'] },
  { id: 82, team: 'alpine', slug: 'alpine', name: '阿尔派技术与赛道核心组', keys: ['阿尔派核心组', '乔什·佩克特', '斯图尔特·巴洛', '保罗·阿隆'] },
  { id: 83, team: 'cadillac', slug: 'cadillac', name: '凯迪拉克技术与赛道核心组', keys: ['凯迪拉克核心组', '约翰·霍华德', '卡洛·帕塞蒂', '周冠宇'] },
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
    ...leadershipLore.map((lore, index) => entry(lore.id, `[F1M管理层] [${lore.team}:${lore.role}] ${lore.name}`, readCard(`${wb}/lore-leadership-${lore.slug}.md`), { keys: lore.keys, order: 260 + index })),
    ...strategyLore.map((lore, index) => entry(lore.id, `[F1M策略组] [${lore.team}] ${lore.name}`, readCard(`${wb}/lore-strategy-${lore.slug}.md`), { keys: lore.keys, order: 300 + index })),
    ...staffLore.map((lore, index) => entry(lore.id, `[F1M核心组] [${lore.team}] ${lore.name}`, readCard(`${wb}/lore-staff-${lore.slug}.md`), { keys: lore.keys, order: 320 + index })),
    entry(84, '[F1M资料] IndyCar 与 WEC 自由市场候选人', readCard(`${wb}/lore-market-candidates.md`), { keys: ['亚历克斯·帕洛', '约瑟夫·纽加登', '科尔顿·赫塔', '安东尼奥·福科', '厄尔·班伯', '迈克尔·坎农', '莉娜·加德', '凯尔·莫耶', '乌尔斯·库拉特勒'], order: 340 }),
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

function stableCardTimestamp() {
  const existingCard = path.join(dist, `${FILE_BASE}.json`);
  try {
    const existing = JSON.parse(fs.readFileSync(existingCard, 'utf8'));
    const timestamp = existing?.data?.creation_date;
    if (Number.isInteger(timestamp) && timestamp >= 0) return timestamp;
  } catch {
    // A source-only build uses a fixed epoch so identical inputs stay reproducible.
  }
  return Math.floor(Date.UTC(2026, 0, 1) / 1000);
}
const cardTimestamp = stableCardTimestamp();
const cardDate = new Date(cardTimestamp * 1000);
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
  creation_date: cardTimestamp,
  modification_date: cardTimestamp,
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
  create_date: cardDate.toISOString(),
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
