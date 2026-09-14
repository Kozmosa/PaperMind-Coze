// 诊断：全库 markdown 材料的公式渲染成功率
// 用真实 KaTeX 0.16.11 跑每个 $...$/$$...$$/\(...\)/\[...\] 片段，统计失败原因
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const katexSrc = fs.readFileSync('C:/Users/MR/AppData/Local/Temp/katex.min.js', 'utf8');
vm.runInThisContext(katexSrc, { filename: 'katex.min.js' });
const katex = globalThis.katex;
if (!katex) { console.log('katex 加载失败'); process.exit(1); }

function sanitizeLatex(f) {
  return f.trim()
    .replace(/^[ \t]*[>#]+[ \t]*/gm, '')
    .replace(/([⺀-鿿豈-﫿＀-￯]+)/g, '\\text{$1}');
}

function renderOk(formula, display) {
  const f = sanitizeLatex(formula);
  if (!f) return { ok: false, reason: 'sanitize 后为空' };
  try {
    const html = katex.renderToString(f, { displayMode: display, throwOnError: false });
    if (!html || html.indexOf('katex-error') !== -1) {
      // 提取错误信息
      const m = html && html.match(/katex-error[^>]*title="([^"]*)"/);
      return { ok: false, reason: m ? m[1] : 'katex-error', formula: f };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message.slice(0, 80), formula: f };
  }
}

async function main() {
  const res = await fetch('http://localhost:9091/api/v1/materials');
  const j = await res.json();
  const mats = j.data || [];
  const results = [];
  for (const m of mats) {
    const isMd = (m.file_type || '').includes('markdown') || /\.md$/i.test(m.name || '') || (m.file_path || '').endsWith('.md');
    if (!isMd && !/\.md$/i.test(m.name || '')) continue;
    const fcRes = await fetch('http://localhost:9091/api/v1/materials/' + m.id + '/file-content').catch(() => null);
    if (!fcRes || !fcRes.ok) { results.push({ name: m.name, error: 'file-content HTTP ' + (fcRes ? fcRes.status : 'fetch fail') }); continue; }
    const fc = await fcRes.json();
    const pages = fc.data?.pages || [];
    const text = pages.map(p => typeof p === 'string' ? p : p.text).join('\n');

    const spans = [];
    const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g;
    let mm;
    while ((mm = re.exec(text)) !== null) {
      spans.push({ display: !!mm[1] || !!mm[3], tex: mm[1] || mm[2] || mm[3] || mm[4] });
    }
    // 括号定界符（App 支持、测试页不支持）
    const parens = (text.match(/\\[\(\[]/g) || []).length;
    const failures = [];
    for (const s of spans) {
      const r = renderOk(s.tex, s.display);
      if (!r.ok) failures.push({ tex: s.tex.slice(0, 60), reason: r.reason });
    }
    results.push({ name: m.name, spans: spans.length, parens, fail: failures.length, samples: failures.slice(0, 2) });
  }
  console.log('=== 公式渲染诊断（真实 KaTeX 0.16.11）===');
  for (const r of results) {
    if (r.error) { console.log(`\n【${r.name}】 ${r.error}`); continue; }
    console.log(`\n【${r.name}】公式 ${r.spans} 个，失败 ${r.fail} 个${r.parens ? `，括号定界符 ${r.parens} 处` : ''}`);
    for (const s of r.samples) console.log(`  ✗ ${s.tex}\n    原因: ${s.reason}`);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
