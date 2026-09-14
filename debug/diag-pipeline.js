const fs = require('fs');
const vm = require('vm');
const path = require('path');
vm.runInThisContext(fs.readFileSync('C:/Users/MR/AppData/Local/Temp/marked.min.js', 'utf8'), { filename: 'marked.min.js' });
vm.runInThisContext(fs.readFileSync('C:/Users/MR/AppData/Local/Temp/katex.min.js', 'utf8'), { filename: 'katex.min.js' });
global.marked = globalThis.marked;
global.katex = globalThis.katex;
if (!global.marked || !global.katex) { console.log('CDN 库加载失败'); process.exit(1); }

const html = fs.readFileSync(path.join(__dirname, 'full-app-test.html'), 'utf8');
const script = html.match(/<script>\s*\n([\s\S]*?)<\/script>/)[1];
const start = script.indexOf('function unescapeEntities');
const end = script.indexOf('NOTEHELPER FULLSCREEN');
eval(script.slice(start, end));

// 用户报的公式：含 < > 会被文本级转义 → 模拟真实链路（先转义再渲染）
const samples = [
  '$M_o < M_e < \\bar{x}$',
  '$P(\\mu-\\sigma < X < \\mu+\\sigma) \\approx 68.27\\%$',
  '$x̄ = Σx_i/n$',
  '$总体参数 \\mu、\\sigma^2$',
  '\\(E(X) = \\mu\\)',
  '\\[\\int_0^1 x^2 dx = \\frac{1}{3}\\]',
];
for (const s of samples) {
  // simpleMarkdown 内部自行转义，直接喂原始文本（真实链路）
  const out = simpleMarkdown('前文 ' + s + ' 后文');
  const hasErr = out.includes('katex-error');
  const hasFallback = out.includes('math-fallback');
  console.log((hasErr || hasFallback ? 'FAIL' : 'OK  '), JSON.stringify(s.slice(0, 45)));
  if (hasErr || hasFallback) console.log('     ', out.slice(0, 220).replace(/\n/g, ' '));
}
