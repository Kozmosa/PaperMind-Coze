const fs = require('fs');
const vm = require('vm');
vm.runInThisContext(fs.readFileSync('C:/Users/MR/AppData/Local/Temp/katex.min.js', 'utf8'), { filename: 'katex.min.js' });
const katex = globalThis.katex;

function unescapeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}
function tryRender(label, formula) {
  try {
    const h = katex.renderToString(formula, { throwOnError: false, strict: 'ignore' });
    const ok = h && h.indexOf('katex-error') === -1;
    console.log(ok ? 'OK  ' : 'FAIL', label, JSON.stringify(formula));
    if (!ok) { const m = h.match(/katex-error[^>]*title="([^"]*)"/); console.log('     原因:', m ? m[1] : h.slice(0, 80)); }
  } catch (e) { console.log('THROW', label, JSON.stringify(formula), e.message.slice(0, 60)); }
}

const cases = [
  ['原始 <', 'M_o < M_e < \\bar{x}'],
  ['转义后未还原', 'M_o &lt; M_e &lt; \\bar{x}'],
  ['还原后', unescapeEntities('M_o &lt; M_e &lt; \\bar{x}')],
  ['原始 %', 'P(\\mu-\\sigma < X < \\mu+\\sigma) \\approx 68.27%'],
  ['% 转义', 'P(\\mu-\\sigma < X < \\mu+\\sigma) \\approx 68.27\\%'],
];
for (const [l, f] of cases) tryRender(l, f);
