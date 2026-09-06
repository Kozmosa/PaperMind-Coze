const fs = require('fs');
const vm = require('vm');
vm.runInThisContext(fs.readFileSync('C:/Users/MR/AppData/Local/Temp/katex.min.js', 'utf8'), { filename: 'katex.min.js' });
const katex = globalThis.katex;
if (!katex) { console.log('katex undefined'); process.exit(1); }

function cjkOnly(f) {
  return f.trim().replace(/^[ \t]*[>#]+[ \t]*/gm, '').replace(/([\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+)/g, '\\text{$1}');
}
function allNonAscii(f) {
  return f.trim().replace(/^[ \t]*[>#]+[ \t]*/gm, '').replace(/([^\t\n\x20-\x7e]+)/g, '\\text{$1}');
}
function test(f) {
  try {
    const h = katex.renderToString(f, { throwOnError: false, strict: 'ignore' });
    return h && h.indexOf('katex-error') === -1 ? 'OK' : 'FAIL';
  } catch (e) { return 'THROW: ' + e.message.slice(0, 40); }
}
const cases = ['x̄ = Σx_i/n', '\\mu + \\sigma^2', 'μ+σ²≈3', 'P(X≤2)', 'S^2=平均方差', 'π≈3.14'];
for (const c of cases) {
  console.log(JSON.stringify(c));
  console.log('  CJK-only    :', test(cjkOnly(c)), '→', JSON.stringify(cjkOnly(c).slice(0, 50)));
  console.log('  all-nonASCII:', test(allNonAscii(c)), '→', JSON.stringify(allNonAscii(c).slice(0, 50)));
}
