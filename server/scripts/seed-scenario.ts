/**
 * PaperMind 场景包数据导入脚本（demo 演示 + 手动 E2E）
 *
 * 场景人设：数学系大二学生「小禾」，期中复习周。
 * 覆盖：学习纪要 / 学习资料（真实 /upload 链路）/ 知识图谱 / 控制中心红点 /
 *      社区便利贴与论坛 / 历史会话（含引用卡）/ 解题与 QA 日志（反思数据源）/ 历史反思报告 / 笔记偏好
 *
 * 与 seed-mvp1 的区别：
 *  1. 资料走 POST /upload（与 App 手动上传同一代码路径，file_contents / 草稿池 / 引用页码齐全）
 *  2. 补齐社区、反思数据源、历史会话、笔记偏好等 8 张表的场景数据
 *  3. 全部数据回填 created_at（近 30 天分布），控制中心时间线与反思折线图有真实形态
 *  4. Supabase 凭据从环境变量读取（不硬编码 service key）
 *
 * 用法：先启动服务（pnpm dev），再在仓库根目录执行
 *   npx tsx server/scripts/seed-scenario.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 与 server/src/config/ai.ts 相同的 .env 加载逻辑（server/.env 或仓库根 .env）
try {
  let envPath = path.resolve('.env');
  if (!fs.existsSync(envPath)) envPath = path.resolve('..', '.env');
  _require('dotenv').config({ path: envPath });
} catch {
  /* 依赖外部注入的环境变量 */
}

const BASE_URL = 'http://localhost:9091';
const API_PREFIX = '/api/v1';
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ 缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（请在根目录 .env 配置）');
  process.exit(1);
}

// ========== HTTP 工具 ==========

function request(
  method: string,
  urlPath: string,
  options: { body?: Buffer | string; contentType?: string; timeoutMs?: number } = {},
): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_PREFIX}${urlPath}`, BASE_URL);
    const headers: http.OutgoingHttpHeaders = {};
    if (options.contentType) headers['Content-Type'] = options.contentType;
    if (options.body) headers['Content-Length'] = Buffer.byteLength(options.body).toString();

    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, json: JSON.parse(data), raw: data });
          } catch {
            resolve({ status: res.statusCode || 0, json: null, raw: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 60000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function apiFetch(method: string, urlPath: string, body?: any, timeoutMs = 120000) {
  return request(method, urlPath, {
    body: body ? JSON.stringify(body) : undefined,
    contentType: 'application/json',
    timeoutMs,
  });
}

/**
 * multipart 上传（对应 App 的 POST /upload）。
 * 文件名按「UTF-8 字节写为 latin1」编码进 Content-Disposition，
 * 服务端 decodeOriginalName 会做同样的修复，中文文件名可正常还原。
 */
function apiUpload(
  filePath: string,
  fields: Record<string, string>,
  timeoutMs = 300000,
): Promise<{ status: number; json: any; raw: string }> {
  const boundary = '----PaperMindSeed' + Date.now().toString(36);
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  const mime = ext === '.md' ? 'text/markdown' : 'text/plain';
  // 文件名位于 multipart body（非 HTTP 头），直接放 UTF-8 字节即可，busboy 会正确解码
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
  );
  parts.push(fs.readFileSync(filePath));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return request('POST', '/upload', {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
    timeoutMs,
  }).then((r) => ({ status: r.status, json: r.json, raw: r.raw }));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(fullPath, extensions));
    else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext)))
      results.push(fullPath);
  }
  return results;
}

function readMarkdownContent(filePath: string): string {
  let raw = fs.readFileSync(filePath, 'utf-8');
  raw = raw.replace(/^\uFEFF/, '');
  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('---', 3);
    if (endIdx !== -1) raw = raw.slice(endIdx + 3).trimStart();
  }
  return raw.trim();
}

/** n 天前的某个确定性时刻（避免每次 seed 时间抖动） */
function daysAgo(n: number, hour = 10, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// ========== 场景数据定义 ==========

/** 每份资料的演示时间线（按文件名关键词匹配）：n 天前上传、是否已查看 */
const MATERIAL_TIMELINE: { match: string; daysAgo: number }[] = [
  { match: '解析函数', daysAgo: 17 },
  { match: '共形映射', daysAgo: 14 },
  { match: '参数估计', daysAgo: 12 },
  { match: '数值积分', daysAgo: 10 },
  { match: '傅里叶', daysAgo: 7 },
  { match: '数学基础导读', daysAgo: 5 },
  { match: '南瓜书', daysAgo: 3 },
  { match: '注意力', daysAgo: 1 },
];

/** 手动录入的纸质解题日志（反思数据源 #1，paper_problem_logs） */
const PAPER_PROBLEM_LOGS: { problem: string; process: string; solution: string }[] = [
  {
    problem: '计算 ∮_{|z|=2} e^z/(z²-1) dz 时结果差一个负号',
    process:
      '分别求 z=1 和 z=-1 处的留数，代入留数定理。检查发现我在 z=-1 处把 (1+z) 的极限写成了 -1 而不是……重算了一遍极限过程。',
    solution:
      '一阶极点留数 Res = lim(z-z0)f(z)，z=-1 处应为 e^{-1}/(-2)。符号错误的根源是极限代入时跳步，以后把分子分母都写完整再约。',
  },
  {
    problem: '多连通区域边界方向总搞反',
    process: '做题时把内边界也取了逆时针，导致内外边界积分相加而不是相减。',
    solution: '记住"沿边界走，区域在左手"：外边界逆时针、内边界顺时针。口诀"外逆内顺"。',
  },
  {
    problem: 't 分布查表时自由度误用 n 而不是 n-1',
    process: '做置信区间习题时用了 σ 未知的小样本公式，自由度直接写了样本量 9。',
    solution:
      '用 S 替换 σ 时自由度损失 1，df = n-1 = 8。和样本方差分母是 n-1 是同一件事：自由度被均值消耗了一个。',
  },
  {
    problem: 'MLE 求 σ² 时求导漏了 1/2 因子',
    process: '对对数似然的 lnσ² 项求导，直接写了 1/σ²。',
    solution:
      'd(lnσ²)/dσ² = 1/σ²，但对 σ² 求导要经过链式法则或先换元 t=σ²。最后 MLE 是除 n（不是 n-1），是有偏估计。',
  },
  {
    problem: '复化 Simpson 把区间分成奇数份',
    process: 'n=9 直接套公式，结果和答案对不上。',
    solution: 'Simpson 每组用两个子区间，n 必须是偶数。奇数时要么补一个梯形段，要么改用 n=8/10。',
  },
  {
    problem: '判断迭代法收敛时忘了算谱半径',
    process: '只看了对角占优就下结论，但那题的系数矩阵不严格对角占优。',
    solution: '对角占优是充分条件不是必要条件；不满足时必须算迭代矩阵谱半径 ρ(G)<1 才能断定收敛。',
  },
  {
    problem: '95% 置信区间把 z_{0.025} 用成了 z_{0.05}',
    process: '双侧区间要上下各留 α/2，我查了单侧的分位数 1.645。',
    solution:
      '双侧 95% → z_{0.025}=1.96；只有单侧置信限才用 z_{0.05}=1.645。做题先画分布草图再查表。',
  },
  {
    problem: '傅里叶级数奇延拓后系数计算出错',
    process: '对 [0,π] 上的函数做奇延拓，算 b_n 时被积区间还是写了 [0,π] 的一半系数。',
    solution:
      '奇延拓后 b_n = (2/π)∫₀^π f(x)sin(nx)dx，系数公式里的 2/π 来自对称区间的折叠，不能丢。',
  },
  {
    problem: '高斯求积区间变换时漏了 Jacobian',
    process: '把 [0,2] 的积分直接代了 [-1,1] 的节点 ±1/√3，忘记乘 (b-a)/2。',
    solution: 'x = (b-a)/2·t + (a+b)/2，dx = (b-a)/2·dt。换元后系数和节点都要乘长度因子。',
  },
  {
    problem: '逻辑斯谛回归梯度推导链式法则漏乘了 x',
    process: "对交叉熵损失求 w 的梯度，σ'(z)σ(1-σ) 展开后忘了外面还有 σ'(wᵀx) 对 w 求导的 x。",
    solution:
      '∇L = Σᵢ(σ(wᵀxᵢ)-yᵢ)xᵢ。记住结论：交叉熵+sigmoid 的梯度形式和线性回归平方损失一样干净，这就是它被广泛使用的原因。',
  },
  {
    problem: 'C-R 方程的极坐标形式记混',
    process: '把 u_r = (1/r)v_θ 写成了 u_θ = (1/r)v_r。',
    solution:
      '极坐标 C-R：u_r = v_θ/r，v_r = -u_θ/r。判断 z^n 这类函数时用极坐标比直角坐标省很多计算。',
  },
  {
    problem: '龙贝格外推系数用成了 3',
    process: '复化梯形外推时用了 (4T₂ₙ-Tₙ)/3 的思路去化简 Simpson 行。',
    solution:
      '梯形行外推系数 4/3，Simpson 行是 15（(16S₂ₙ-Sₙ)/15）。误差阶每行翻倍：O(h²)→O(h⁴)→O(h⁶)。',
  },
];

/** 导师问答日志（反思数据源 #2，problem_solving_logs，chat 页「我明白了」写入的就是这张表） */
const QA_POOL: { q: string; a: string }[] = [
  {
    q: '留数定理和柯西积分公式是什么关系？',
    a: '柯西积分公式是留数定理在单极点、留数恰为函数值时的特例。',
  },
  { q: '一阶极点的留数有快速算法吗？', a: '有：Res(f,z₀)=lim(z-z₀)f(z)，不用展开洛朗级数。' },
  { q: 'k 阶极点的留数公式是什么？', a: 'Res = 1/(k-1)! · lim dᵏ⁻¹/dzᵏ⁻¹[(z-z₀)ᵏf(z)]。' },
  {
    q: '为什么小样本要用 t 分布替代 z 分布？',
    a: 'σ 未知用 S 估计引入额外不确定性，t 分布尾部更厚；n→∞ 时两者重合。',
  },
  { q: '置信区间的 95% 到底指什么？', a: '随机区间盖住真值的概率，不是参数落在固定区间的概率。' },
  {
    q: 'MLE 和矩估计应该优先用哪个？',
    a: '分布形式已知用 MLE（渐近有效），只知道矩条件时用矩估计。',
  },
  { q: '为什么样本方差分母是 n-1？', a: '均值消耗了一个自由度，除 n-1 才是 σ² 的无偏估计。' },
  {
    q: 'Simpson 公式为什么代数精度是 3 次？',
    a: '偶数节点数的牛顿-柯特斯公式白赚一阶，n=2 时对 x³ 精确。',
  },
  {
    q: '梯形和 Simpson 的误差阶分别是多少？',
    a: '复化梯形 O(h²)、复化 Simpson O(h⁴)；步长减半误差分别 ÷4、÷16。',
  },
  {
    q: '高斯求积的节点怎么确定的？',
    a: '取区间上正交多项式（勒让德）的零点，n+1 个节点可达 2n+1 次代数精度。',
  },
  {
    q: '龙贝格算法的核心思想是什么？',
    a: 'Richardson 外推：用两个步长的误差估计消去低阶误差项，逐行提高精度阶。',
  },
  {
    q: 'C-R 方程的几何意义是什么？',
    a: '解析函数导数与方向无关的坐标表示：伸缩率与旋转角在各方向一致。',
  },
  { q: '共形映射什么时候失效？', a: "f'(z₀)=0 的临界点，例如 z² 在原点把夹角加倍。" },
  { q: '分式线性变换有哪些不变量？', a: '保圆性、保对称性、保交比；三对对应点唯一确定一个变换。' },
  {
    q: '狄利克雷问题为什么能用共形映射解？',
    a: '调和函数经共形映射仍是调和函数，可把区域化归为单位圆盘用泊松公式。',
  },
  { q: '傅里叶级数在间断点收敛到什么？', a: '左右极限的平均值；附近还有约 9% 的吉布斯过冲。' },
  { q: 'Parseval 等式的物理含义？', a: '能量守恒：时域能量=各频率分量能量之和。' },
  { q: 'FFT 为什么快？', a: '利用单位根对称性分治，O(N²) 降到 O(N log N)。' },
  { q: '卷积定理说的是什么？', a: '时域卷积=频域乘积，滤波器设计的理论基础。' },
  { q: '交叉熵损失怎么来的？', a: '伯努利似然取负对数，是 MLE 的算法化写法。' },
  { q: '平方损失对应什么假设？', a: '高斯噪声下的极大似然；损失函数=负对数似然。' },
  { q: '梯度下降步长怎么选？', a: '凸且 L-光滑时 η<2/L 保证收敛，最优 1/L。' },
  { q: '过拟合的数学刻画是什么？', a: '偏差-方差分解中方差项主导；正则化=以小偏差换大方差下降。' },
  { q: '岭回归为什么能改善病态？', a: 'XᵀX+λI 直接改善条件数，等价于给参数加高斯先验。' },
  { q: 'sigmoid 的导数形式？', a: "σ'(t)=σ(t)(1-σ(t))，这让交叉熵的梯度非常干净。" },
  {
    q: '牛顿法和梯度下降怎么取舍？',
    a: '牛顿法收敛快但每步解线性组 O(d³) 且非凸无保证；大规模场景用 SGD 族。',
  },
  { q: '注意力机制的直观理解？', a: '查询-键-值：用相关性给值加权平均，是"软性"的信息检索。' },
  { q: '映射 z→(z-i)/(z+i) 把上半平面变到哪？', a: '单位圆盘，i 映到 0；是复分析里的标准变换。' },
  { q: '什么是混叠现象？', a: '采样率不足时高频伪装成低频；奈奎斯特定理要求采样率>2倍最高频率。' },
  { q: '置信区间和假设检验的关系？', a: '对偶：θ₀ 落在 1-α 置信区间内 ⟺ 水平 α 的检验接受 H₀。' },
];

/** 近 30 天每日导师问答次数（problem_solving_logs 折线图形态：期中前冲刺） */
const DAILY_QA_COUNTS = [
  1, 0, 2, 1, 0, 1, 2, 0, 1, 3, 1, 0, 2, 2, 1, 0, 1, 2, 3, 1, 0, 2, 4, 3, 2, 3, 4, 3, 5, 2,
];

/** 社区便利贴 */
const STICKYNOTES: {
  papercore: string;
  original_material: string;
  visibility: string;
  author_name: string;
  daysAgo: number;
}[] = [
  {
    papercore:
      '留数定理省流版：闭合曲线积分 = 2πi × 内部奇点留数之和；一阶极点直接 Res=lim(z-z₀)f(z)，不用展开洛朗级数。柯西积分公式是它的特例。',
    original_material: '复变函数留数定理笔记',
    visibility: 'public',
    author_name: '陈同学',
    daysAgo: 6,
  },
  {
    papercore:
      '数理统计考点省流：σ未知换 t 分布且自由度 n-1；双侧 95% 用 z=1.96（别用成单侧 1.645）；置信区间的正确读法是"随机区间盖住真值"。',
    original_material: '假设检验笔记',
    visibility: 'public',
    author_name: '李同学',
    daysAgo: 4,
  },
  {
    papercore:
      '数值积分速记卡：复化梯形 O(h²)、复化 Simpson O(h⁴)（步长减半误差÷16）；两点高斯-勒让德节点 ±1/√3，3 次精度白嫖。',
    original_material: '数值积分方法课件',
    visibility: 'public',
    author_name: '王同学',
    daysAgo: 2,
  },
  {
    papercore:
      '自用背诵卡：傅里叶级数间断点收敛到左右极限平均（吉布斯过冲~9%）；Parseval=能量守恒；FFT 用分治把 O(N²) 降到 O(N log N)。',
    original_material: '傅里叶级数与变换入门',
    visibility: 'friends',
    author_name: '小禾',
    daysAgo: 1,
  },
];

/** 论坛与帖子 */
const FORUMS_WITH_POSTS: {
  name: string;
  type: string;
  description: string;
  daysAgo: number;
  posts: { title: string; content: string; author_name: string; daysAgo: number }[];
}[] = [
  {
    name: '复变函数期中互助组',
    type: 'class',
    description: '数学系二班 · 复变函数期中复习讨论',
    daysAgo: 9,
    posts: [
      {
        title: '∮_{|z|=2} dz/(z²-1) 大家算出来是多少？',
        content:
          '我拆成 z=1 和 z=-1 两个一阶极点，留数都是 1/2，最后答案是 2πi。有没有人算出不一样的？附：一阶极点用 lim(z-z₀)f(z) 最快。',
        author_name: '陈同学',
        daysAgo: 3,
      },
      {
        title: '分享：用"外逆内顺"记住多连通区域的边界方向',
        content:
          '复连通区域上留数定理要沿所有边界积分，方向口诀是"沿边界走区域在左手"：外边界逆时针、内边界顺时针。亲测不再翻车。',
        author_name: '小禾',
        daysAgo: 2,
      },
    ],
  },
  {
    name: '数理学习角',
    type: 'school',
    description: '跨年级数学/统计/数值课程交流',
    daysAgo: 20,
    posts: [
      {
        title: 'MLE 求 σ² 到底除 n 还是 n-1？',
        content:
          '推导出来是除 n（有偏），样本方差 S² 除 n-1（无偏）。两者相差因子 (n-1)/n。大样本无所谓，小样本面试会考，别混。',
        author_name: '李同学',
        daysAgo: 5,
      },
      {
        title: '期中后想自学一点机器学习，从哪里入手？',
        content:
          '数学系背景建议从"统计视角"进：先把极大似然和梯度下降吃透（正好是数理统计+数值分析的内容），然后看逻辑斯谛回归的完整推导，再碰神经网络。',
        author_name: '王同学',
        daysAgo: 1,
      },
    ],
  },
];

/** 历史反思报告（7 天前生成的期中自评） */
const HISTORICAL_REFLECTION = {
  period: '7',
  learning_behavior:
    '本周学习以复变函数留数理论与数理统计区间估计为主：上传讲义 3 份（《解析函数与柯西积分定理讲义》《共形映射及其应用讲义》《参数估计与置信区间讲义》），完成导师问答 14 次，集中在留数计算与置信区间两类问题。学习时段多在晚间，周末强度明显高于工作日。',
  challenge_report:
    '本周攻克了三类顽固错误：①留数计算中的符号错误（根源是极限代入跳步，已改掉）；②t/z 分布混淆（现在能复述"σ未知→t、自由度n-1"的完整理由）；③复化 Simpson 区间取奇数份的问题。仍在反复出错的是多连通区域的边界方向，已建立"外逆内顺"口诀但还需要练习巩固。',
  thinking_pattern:
    '整体呈现"先公式、后直觉"的模式：习惯先背结论再做题，遇到变式时推导链断裂。优势是计算执行快、错题能坚持归因；短板是几何直觉弱（共形映射、保角性理解吃力），以及对定理的适用条件敏感度不足（如留数定理要求边界上解析）。',
  suggestion:
    '①每道错题当天录入解题日志（problem log），保持归因习惯；②对共形映射一章补"画图三步法"：先画原区域、再画像区域、标出关键点对应；③用 NoteHelper 把讲义与自己的笔记做对比生成差异笔记，查漏补缺；④保持每日 2 题以上的导师问答频率直到期中。',
};

// ========== 主流程 ==========

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function clearExistingData(supabase: any, light: boolean) {
  console.log(
    `🧹 清理${light ? '场景轻数据（--light 模式，保留纪要/资料/图谱）' : '演示用户的历史数据'}...`,
  );
  const userScoped = light
    ? [
        'paper_problem_logs',
        'problem_solving_logs',
        'reflections',
        'chat_sessions',
        'papernote_style',
      ]
    : [
        'study_notes',
        'materials',
        'paper_problem_logs',
        'problem_solving_logs',
        'reflections',
        'chat_sessions',
        'papernote_style',
        'draft_pool',
      ];
  for (const table of userScoped) {
    const r = await supabase.from(table).delete().eq('user_id', TEST_USER_ID);
    console.log(`   ${r.error ? '❌' : '✅'} ${table}${r.error ? `: ${r.error.message}` : ''}`);
  }
  if (!light) {
    // knowledge_nodes 自引用无级联：先删子节点再删根节点
    await supabase.from('knowledge_nodes').delete().not('parent_id', 'is', null);
    const rk = await supabase.from('knowledge_nodes').delete().is('parent_id', null);
    console.log(
      `   ${rk.error ? '❌' : '✅'} knowledge_nodes${rk.error ? `: ${rk.error.message}` : ''}`,
    );
  }
  // 社区表无 user 概念（演示库），全清
  const rs = await supabase.from('stickynotes').delete().neq('id', -1);
  console.log(`   ${rs.error ? '❌' : '✅'} stickynotes${rs.error ? `: ${rs.error.message}` : ''}`);
  const rf = await supabase.from('forums').delete().neq('id', -1);
  console.log(
    `   ${rf.error ? '❌' : '✅'} forums(含帖子级联)${rf.error ? `: ${rf.error.message}` : ''}\n`,
  );
}

function noteLogicalPath(filePath: string, title: string): string {
  const rel = path.relative(path.join(ROOT_DIR, 'test_data', '学习纪要'), filePath).split(path.sep);
  // 学习纪要/<批次>/数学笔记/<学科>/.../<file.md> → /<学科>/<文件名>/（习题课等子目录并入学科）
  const subject = rel.length >= 2 ? rel[rel.length - 2] : '数学笔记';
  return `/${subject}/${title}/`;
}

/** 全量导入：纪要 + 资料（/upload 真实链路）+ AI 分类 + 时间线回填 */
async function importNotesAndMaterials(
  noteRecords: { id: string; title: string; daysAgo: number }[],
  materialRecords: {
    id: string;
    name: string;
    draftId: number | null;
    daysAgo: number;
    ok: boolean;
  }[],
) {
  const supabase = await getSupabase();

  // ====== 导入学习纪要 ======
  console.log('📝 导入学习纪要（test_data/学习纪要）...');
  const notesDir = path.join(ROOT_DIR, 'test_data', '学习纪要');
  const mdFiles = findFiles(notesDir, ['.md', '.txt']);

  for (let i = 0; i < mdFiles.length; i++) {
    const filePath = mdFiles[i];
    const title = path.basename(filePath).replace(/\.(md|txt)$/i, '');
    const content = readMarkdownContent(filePath);
    if (!content) continue;
    const res = await apiFetch('POST', '/study-notes', {
      title,
      content,
      blocks: [{ type: 'text' as const, content }],
      logical_path: noteLogicalPath(filePath, title),
    });
    if (res.json?.data?.id) {
      const offset = Math.round(26 - (i * 22) / Math.max(1, mdFiles.length - 1)); // 26 天前 → 4 天前
      noteRecords.push({ id: res.json.data.id, title, daysAgo: offset });
      console.log(`   [${i + 1}/${mdFiles.length}] ✅ ${title} (${offset} 天前)`);
    } else {
      console.log(
        `   [${i + 1}/${mdFiles.length}] ❌ ${title}: ${res.json?.error || res.raw.slice(0, 80)}`,
      );
    }
  }

  // ====== 上传学习资料（真实 /upload 链路，含 AI 分类） ======
  console.log(
    '\n📎 上传学习资料（POST /upload，走与 App 相同的链路，每份含 3 次 LLM 调用，请耐心等待）...',
  );
  const materialsDir = path.join(ROOT_DIR, 'test_data', '学习资料');
  const materialFiles = findFiles(materialsDir, ['.md', '.txt', '.pdf', '.pptx', '.docx']);

  for (let i = 0; i < materialFiles.length; i++) {
    const filePath = materialFiles[i];
    const baseName = path.basename(filePath, path.extname(filePath));
    const rel = path.relative(materialsDir, filePath).split(path.sep);
    const folder = rel.length >= 2 ? rel[rel.length - 2] : '学习资料';
    const timeline = MATERIAL_TIMELINE.find((t) => baseName.includes(t.match));

    const up = await apiUpload(filePath, {
      title: baseName,
      logical_path: JSON.stringify([`/学习资料/${folder}/`]),
    });
    if (up.json?.materialId) {
      const clsError = up.json.classification?.error;
      materialRecords.push({
        id: up.json.materialId,
        name: baseName,
        draftId: up.json.draftId ?? null,
        daysAgo: timeline?.daysAgo ?? 2 + ((materialFiles.length - i) % 5),
        ok: !clsError,
      });
      console.log(
        `   [${i + 1}/${materialFiles.length}] ${clsError ? '⚠️' : '✅'} ${baseName}` +
          ` → material ${String(up.json.materialId).slice(0, 8)}..., draft ${up.json.draftId}` +
          (clsError ? `（分类失败: ${String(clsError).slice(0, 60)}）` : ''),
      );
    } else {
      materialRecords.push({ id: '', name: baseName, draftId: null, daysAgo: 1, ok: false });
      console.log(`   [${i + 1}/${materialFiles.length}] ❌ ${baseName}: ${up.raw.slice(0, 100)}`);
    }
  }

  // ====== 触发学习纪要 AI 处理 ======
  console.log('\n🤖 触发学习纪要 AI 分类...');
  for (const note of noteRecords) {
    const res = await apiFetch(
      'POST',
      '/knowledge-builder/process-content',
      { type: 'study_note', id: note.id },
      240000,
    );
    const ok = res.json?.data?.ai_processed ?? res.json?.data?.status;
    console.log(`   ${ok ? '✅' : '⚠️'} ${note.title.slice(0, 28)}`);
  }

  // ====== 回填时间线 + 消红点 ======
  console.log('\n🗓️  回填时间线（控制中心最近记录 / 反思统计窗口）...');
  for (const note of noteRecords) {
    await supabase
      .from('study_notes')
      .update({
        created_at: daysAgo(note.daysAgo, 9 + (note.title.length % 8)),
        updated_at: daysAgo(note.daysAgo, 9 + (note.title.length % 8), 30),
        // 9 天前的已查看（消红点），近 8 天的保留红点供演示"标记已读"流程
        viewed_after_process: note.daysAgo >= 9,
      })
      .eq('id', note.id);
  }
  for (const mat of materialRecords) {
    if (!mat.id) continue;
    await supabase
      .from('materials')
      .update({
        created_at: daysAgo(mat.daysAgo, 15),
        updated_at: daysAgo(mat.daysAgo, 15, 30),
        viewed_after_process: mat.daysAgo >= 8,
      })
      .eq('id', mat.id);
  }
  console.log(
    `   ✅ 纪要 ${noteRecords.length} 条 / 资料 ${materialRecords.length} 条时间线已回填（8 天前的自动标记已读）`,
  );

  // ====== 等待全部 AI 处理完成 ======
  console.log('\n⏳ 等待 AI 处理完成...');
  let pending = noteRecords.length + materialRecords.filter((m) => m.id).length;
  for (let round = 0; round < 10 && pending > 0; round++) {
    await sleep(8000);
    const [nr, mr] = await Promise.all([
      apiFetch('GET', '/study-notes'),
      apiFetch('GET', '/materials'),
    ]);
    const done = new Set(
      [...(nr.json?.data || []), ...(mr.json?.data || [])]
        .filter((r: any) => r.ai_processed)
        .map((r: any) => r.id),
    );
    pending =
      noteRecords.filter((n) => !done.has(n.id)).length +
      materialRecords.filter((m) => m.id && !done.has(m.id)).length;
    console.log(`   轮次 ${round + 1}/10：待处理 ${pending}`);
  }
  if (pending > 0)
    console.log(`   ⚠️ 仍有 ${pending} 条未完成（可稍后 POST /knowledge-builder/trigger 重试）`);
}

async function main() {
  // --light：只重灌社区/反思/会话等轻数据（保留纪要/资料/图谱，不触发 LLM），用于快速迭代场景数据
  const LIGHT = process.argv.includes('--light');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║   PaperMind 场景包导入（期中复习周 · 小禾）${LIGHT ? ' --light' : '        '}║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
  const supabase = await getSupabase();

  // ====== 健康检查 ======
  const health = await apiFetch('GET', '/study-notes');
  if (health.status !== 200) {
    console.log(`❌ 后端异常(${health.status})：请先 pnpm dev 启动服务`);
    process.exit(1);
  }
  console.log('📡 后端服务正常\n');

  await clearExistingData(supabase, LIGHT);

  const noteRecords: { id: string; title: string; daysAgo: number }[] = [];
  const materialRecords: {
    id: string;
    name: string;
    draftId: number | null;
    daysAgo: number;
    ok: boolean;
  }[] = [];

  if (!LIGHT) {
    await importNotesAndMaterials(noteRecords, materialRecords);
  } else {
    console.log('⚡ --light 模式：跳过纪要/资料导入与 AI 分类\n');
  }

  // ====== 场景数据：偏好 / 解题日志 / QA 日志 ======
  console.log('\n🧑‍🎓 写入用户画像与反思数据源...');
  await supabase.from('papernote_style').upsert({
    user_id: TEST_USER_ID,
    general_preference:
      '结构优先：先一句话结论，再完整公式推导，配一个具体例子；多用表格对比易混概念；关键定理显式标注使用条件。',
    subject_preferences: { 数学: '保留完整推导步骤，标注定理的适用条件与反例' },
  });
  console.log('   ✅ papernote_style（笔记风格偏好）');

  let plCount = 0;
  for (let i = 0; i < PAPER_PROBLEM_LOGS.length; i++) {
    const log = PAPER_PROBLEM_LOGS[i];
    const offset = [27, 24, 21, 19, 16, 14, 11, 9, 6, 4, 2, 1][i] ?? 1;
    const r = await supabase.from('paper_problem_logs').insert({
      user_id: TEST_USER_ID,
      ...log,
      created_at: daysAgo(offset, 20, 15),
    });
    if (!r.error) plCount++;
  }
  console.log(`   ✅ paper_problem_logs × ${plCount}（近 30 天手动解题日志）`);

  let qaCount = 0;
  let poolIdx = 0;
  const perDayHour = [10, 15, 21];
  const N_DAYS = DAILY_QA_COUNTS.length;
  for (let d = N_DAYS - 1; d >= 0; d--) {
    // 数组按下标 0=最旧一天，d=0=今天；倒序索引保证"期前冲刺"形态落在最近几天
    const count = DAILY_QA_COUNTS[N_DAYS - 1 - d];
    for (let k = 0; k < count; k++) {
      const qa = QA_POOL[poolIdx % QA_POOL.length];
      poolIdx++;
      // 当天的记录用"几分钟前"，避免 seed 在上午跑时把当天日志写到未来而被统计窗口排除
      const createdAt =
        d === 0
          ? new Date(Date.now() - (k + 1) * 25 * 60000).toISOString()
          : daysAgo(d, perDayHour[k % 3], (k * 17) % 60);
      const payload = {
        user_id: TEST_USER_ID,
        question: qa.q,
        answer: qa.a,
        steps: '',
        related_knowledge_node_ids: [],
        citation_snippets: [],
        created_at: createdAt,
      };
      let r = await supabase
        .from('problem_solving_logs')
        .insert({ ...payload, related_draft_ids: [] });
      // related_draft_ids 列由 migrations/002 添加，未执行迁移的库降级重试
      if (r.error && /related_draft_ids/.test(r.error.message || '')) {
        r = await supabase.from('problem_solving_logs').insert(payload);
      }
      if (!r.error) qaCount++;
    }
  }
  console.log(`   ✅ problem_solving_logs × ${qaCount}（30 天导师问答，供反思折线图）`);

  const rr = await supabase.from('reflections').insert({
    user_id: TEST_USER_ID,
    ...HISTORICAL_REFLECTION,
    created_at: daysAgo(7, 22, 5),
  });
  console.log(
    `   ${rr.error ? '❌' : '✅'} reflections × 1（7 天前的期中自评报告）${rr.error ? ': ' + rr.error.message : ''}`,
  );

  // ====== 场景数据：社区 ======
  console.log('\n🏘️  写入社区数据...');
  for (const s of STICKYNOTES) {
    await supabase.from('stickynotes').insert({
      papercore: s.papercore,
      original_material: s.original_material,
      visibility: s.visibility,
      author_name: s.author_name,
      created_at: daysAgo(s.daysAgo, 12),
      updated_at: daysAgo(s.daysAgo, 12),
    });
  }
  console.log(
    `   ✅ stickynotes × ${STICKYNOTES.length}（public ${STICKYNOTES.filter((s) => s.visibility === 'public').length} / friends ${STICKYNOTES.filter((s) => s.visibility === 'friends').length}）`,
  );

  let postCount = 0;
  for (const f of FORUMS_WITH_POSTS) {
    const { data: forum } = await supabase
      .from('forums')
      .insert({
        name: f.name,
        type: f.type,
        description: f.description,
        created_at: daysAgo(f.daysAgo, 10),
      })
      .select()
      .single();
    if (!forum) continue;
    for (const p of f.posts) {
      const r = await supabase.from('forum_posts').insert({
        forum_id: forum.id,
        user_id: TEST_USER_ID,
        title: p.title,
        content: p.content,
        author_name: p.author_name,
        created_at: daysAgo(p.daysAgo, 14 + (postCount % 5)),
      });
      if (!r.error) postCount++;
    }
  }
  console.log(`   ✅ forums × ${FORUMS_WITH_POSTS.length}，forum_posts × ${postCount}`);

  // ====== 场景数据：历史会话（含引用卡） ======
  console.log('\n💬 写入历史会话...');
  // 兼容两类行：纪要用 title，资料用 name
  const byTitle = (kw: string, rows: any[]) =>
    rows.find((r: any) => (r.title || r.name || '').includes(kw));
  const [notesRes, matsRes] = await Promise.all([
    apiFetch('GET', '/study-notes'),
    apiFetch('GET', '/materials'),
  ]);
  const notes = notesRes.json?.data || [];
  const mats = matsRes.json?.data || [];
  const nodesRes = await apiFetch('GET', '/knowledge-nodes');
  const nodes = (nodesRes.json?.data || []).filter((n: any) => n.user_id === TEST_USER_ID);
  const findNode = (kw: string) =>
    nodes.find((n: any) => (n.papercore || '').includes(kw) || (n.short_name || '').includes(kw)) ||
    null;

  const noteResidue = byTitle('留数定理', notes);
  const noteResidue2 = byTitle('留数及其应用笔记2', notes);
  const matCauchy = byTitle('解析函数', mats);
  const matEstimate = byTitle('参数估计', mats);
  const nodeResidue = findNode('留数') || findNode('复变') || findNode('复分析') || null;
  // draftId 优先取本轮上传返回值；--light 模式下从草稿池接口按文件名/文件地址反查
  let matCauchyDraft = materialRecords.find((m) => m.name.includes('解析函数'))?.draftId ?? null;
  const dp = await apiFetch('GET', '/draft-pool');
  const drafts: any[] = dp.json?.data || [];
  if (!matCauchyDraft) {
    const draft = drafts.find(
      (d: any) =>
        (d.file_name || '').includes('解析函数') ||
        mats.some((m: any) => m.file_path === d.file_url && (m.name || '').includes('解析函数')),
    );
    matCauchyDraft = draft?.id ?? null;
  }
  // 修复历史乱码文件名：按 file_url 关联资料名，保证草稿池页/引用卡显示正常
  for (const d of drafts) {
    const mat = mats.find((m: any) => m.file_path && m.file_path === d.file_url);
    if (mat) {
      const fixedName = `${mat.name}${path.extname(d.file_name || '.md') || '.md'}`;
      if (d.file_name !== fixedName) {
        await supabase.from('draft_pool').update({ file_name: fixedName }).eq('id', d.id);
      }
    }
  }

  const sessions: {
    title: string;
    daysAgo: number;
    messages: { role: 'user' | 'assistant'; content: string; citations: any[] }[];
  }[] = [
    {
      title: '留数定理复习',
      daysAgo: 3,
      messages: [
        {
          role: 'user',
          content: '留数定理和柯西积分公式到底是什么关系？总觉得是两个不相干的定理。',
          citations: [],
        },
        {
          role: 'assistant',
          content:
            '它们是**一般与特例**的关系，不是两个独立工具。\n\n**柯西积分公式**说：解析函数在区域内部一点的值由边界值完全决定，\n\n$$f(z_0) = \\frac{1}{2\\pi i}\\oint_C \\frac{f(z)}{z-z_0}\\,dz$$\n\n从留数的视角看：被积函数 $\\frac{f(z)}{z-z_0}$ 在 $z_0$ 处有一个一阶极点，其留数恰好是 $f(z_0)$——所以柯西积分公式就是留数定理在"单极点、留数等于函数值"时的特例。\n\n**留数定理**把这种计算推广到任意有限个孤立奇点：\n\n$$\\oint_{\\partial D} f(z)\\,dz = 2\\pi i\\sum_k \\operatorname{Res}(f, z_k)$$\n\n柯西积分定理（积分为 0）则对应"内部没有奇点、留数和为 0"的情形。三个定理是一条逻辑链：柯西积分定理 ⊂ 柯西积分公式 ⊂ 留数定理。',
          citations: [
            ...(noteResidue
              ? [
                  {
                    type: 'study_note',
                    sourceId: noteResidue.id,
                    sourceType: 'study_note',
                    title: noteResidue.title,
                    papercore: (noteResidue.papercore || '').slice(0, 200),
                    tags: noteResidue.tags || [],
                  },
                ]
              : []),
            ...(matCauchy
              ? [
                  {
                    type: 'material',
                    sourceId: matCauchy.id,
                    sourceType: 'material',
                    title: matCauchy.name,
                    papercore: (matCauchy.papercore || '').slice(0, 200),
                    tags: matCauchy.tags || [],
                  },
                ]
              : []),
            ...(nodeResidue
              ? [
                  {
                    type: 'knowledge_node',
                    sourceId: nodeResidue.id,
                    sourceType: 'knowledge_node',
                    title: nodeResidue.short_name || `知识节点 ${nodeResidue.id}`,
                    papercore: (nodeResidue.papercore || '').slice(0, 200),
                    tags: nodeResidue.tags || [],
                  },
                ]
              : []),
          ],
        },
        {
          role: 'user',
          content: '明白了。那一阶极点的留数有没有不用洛朗展开的快速算法？',
          citations: [],
        },
        {
          role: 'assistant',
          content:
            "有，而且应该成为你的默认方法：\n\n**一阶极点**：$\\operatorname{Res}(f, z_0) = \\lim_{z\\to z_0}(z-z_0)f(z)$。\n\n若 $f = P/Q$（$Q$ 有单零点 $z_0$、$P(z_0)\\ne 0$），还有更快的公式：\n\n$$\\operatorname{Res}\\left(\\frac{P}{Q}, z_0\\right) = \\frac{P(z_0)}{Q'(z_0)}$$\n\n例如 $\\frac{e^{iz}}{1+z^2}$ 在 $z=i$ 处：留数 $= \\frac{e^{i\\cdot i}}{2i} = \\frac{e^{-1}}{2i} = -\\frac{i}{2e}$，两行搞定。\n\n**k 阶极点**才需要求导公式 $\\frac{1}{(k-1)!}\\lim \\frac{d^{k-1}}{dz^{k-1}}[(z-z_0)^k f(z)]$。做题策略：先判断极点阶数，一阶用极限、高阶用导数公式、本性奇点才回到洛朗展开。",
          citations: [
            ...(noteResidue2
              ? [
                  {
                    type: 'study_note',
                    sourceId: noteResidue2.id,
                    sourceType: 'study_note',
                    title: noteResidue2.title,
                    papercore: (noteResidue2.papercore || '').slice(0, 200),
                    tags: noteResidue2.tags || [],
                  },
                ]
              : []),
            ...(matCauchyDraft
              ? [
                  {
                    type: 'file_content',
                    sourceId: matCauchyDraft,
                    sourceType: 'file_content',
                    title: '解析函数与柯西积分定理讲义.md',
                    fileName: '解析函数与柯西积分定理讲义.md',
                    pageNumber: 1,
                    snippet:
                      '柯西积分定理（单连通区域）：设 f 在单连通区域 D 内解析，C 为 D 内任一条分段光滑的简单闭曲线，则 ∮f(z)dz=0…',
                    draftId: matCauchyDraft,
                  },
                ]
              : []),
          ],
        },
      ],
    },
    {
      title: '期中复习优先级',
      daysAgo: 1,
      messages: [
        {
          role: 'user',
          content: '期中只剩一周了，帮我按优先级排一下复变和统计的复习重点。',
          citations: [],
        },
        {
          role: 'assistant',
          content:
            '结合你近两周的错题记录（留数符号错误 2 次、t/z 混淆 2 次、边界方向 1 次），建议：\n\n**第一优先级 · 留数计算（复变）**\n- 一阶极点极限法 + P/Q\' 公式必须条件反射级熟练\n- 多连通区域"外逆内顺"口诀\n\n**第二优先级 · 区间估计（统计）**\n- σ 已知用 z、未知用 t（自由度 n-1）\n- 双侧分位数别查成单侧（1.96 vs 1.645）\n- 置信区间的"随机区间"解读（概念题高发）\n\n**第三优先级 · 两个公式族**\n- 复变：柯西积分公式 → 高阶导数公式的形\n- 统计：MLE 通用流程（写似然 → 取对数 → 求导 = 0）\n\n每天保持 2-3 个导师问答 + 1 道完整计算，错题当天录入解题日志。',
          citations: [
            ...(matEstimate
              ? [
                  {
                    type: 'material',
                    sourceId: matEstimate.id,
                    sourceType: 'material',
                    title: matEstimate.name,
                    papercore: (matEstimate.papercore || '').slice(0, 200),
                    tags: matEstimate.tags || [],
                  },
                ]
              : []),
            ...(byTitle('假设检验', notes)
              ? [
                  {
                    type: 'study_note',
                    sourceId: byTitle('假设检验', notes).id,
                    sourceType: 'study_note',
                    title: byTitle('假设检验', notes).title,
                    papercore: (byTitle('假设检验', notes).papercore || '').slice(0, 200),
                    tags: byTitle('假设检验', notes).tags || [],
                  },
                ]
              : []),
          ],
        },
      ],
    },
  ];

  for (const s of sessions) {
    const { data: session } = await supabase
      .from('chat_sessions')
      .insert({
        user_id: TEST_USER_ID,
        title: s.title,
        created_at: daysAgo(s.daysAgo, 16),
        updated_at: daysAgo(s.daysAgo, 16, 20),
      })
      .select()
      .single();
    if (!session) continue;
    for (let i = 0; i < s.messages.length; i++) {
      const m = s.messages[i];
      await supabase.from('chat_messages').insert({
        session_id: session.id,
        user_id: TEST_USER_ID,
        role: m.role,
        content: m.content,
        citations: m.citations,
        created_at: daysAgo(s.daysAgo, 16, i * 2),
      });
    }
  }
  console.log(`   ✅ chat_sessions × ${sessions.length}（含 6 条消息、4 类引用卡）`);

  // ====== 重建向量索引 ======
  console.log('\n🔎 重建统一向量索引...');
  const refresh = await apiFetch('POST', '/ai/refresh-index', {}, 180000);
  console.log(
    `   ${refresh.json?.data ? '✅' : '⚠️'} ${JSON.stringify(refresh.json?.data ?? refresh.json)}`,
  );

  // ====== 汇总报告 ======
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   📋 场景包导入报告                              ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const [finalNotes, finalMats, graph] = await Promise.all([
    apiFetch('GET', '/study-notes'),
    apiFetch('GET', '/materials'),
    apiFetch('GET', '/knowledge-builder/graph-data'),
  ]);
  const fn = finalNotes.json?.data || [];
  const fm = finalMats.json?.data || [];
  const g = graph.json?.data;

  const stats: [string, string | number][] = [
    ['学习纪要', `${fn.length}（AI 已分类 ${fn.filter((r: any) => r.ai_processed).length}）`],
    ['学习资料', `${fm.length}（AI 已分类 ${fm.filter((r: any) => r.ai_processed).length}）`],
    [
      '图谱节点/边',
      `${g?.nodes?.length ?? 0} / ${g?.edges?.length ?? 0}（领域 ${g?.domains?.length ?? 0}）`,
    ],
    [
      '待查看红点',
      fn.concat(fm).filter((r: any) => r.ai_processed && !r.viewed_after_process).length,
    ],
    ['解题日志(QA)', qaCount],
    ['纸质解题日志', plCount],
    ['反思报告', 1],
    ['便利贴', STICKYNOTES.length],
    ['论坛/帖子', `${FORUMS_WITH_POSTS.length} / ${postCount}`],
    ['历史会话', sessions.length],
  ];
  for (const [k, v] of stats) console.log(`   ${k.padEnd(10)}：${v}`);

  console.log(
    `\n🎉 场景就绪。演示入口：App(localhost:5001) 或调试页(localhost:9091/debug/full-app-test.html)；` +
      `手测清单见 test_data/scenario/README.md。\n`,
  );
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
