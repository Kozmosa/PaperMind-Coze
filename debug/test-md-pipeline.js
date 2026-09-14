const fs = require('fs');
const vm = require('vm');
// 加载 marked（UMD 暴露 globalThis.marked）
const markedSrc = fs.readFileSync('C:/Users/MR/AppData/Local/Temp/marked.min.js', 'utf8');
vm.runInThisContext(markedSrc, { filename: 'marked.min.js' });
global.marked = globalThis.marked || globalThis.window?.marked;
if (!global.marked) { console.log('marked 加载失败'); process.exit(1); }

const html = fs.readFileSync(require('path').join(__dirname, 'full-app-test.html'), 'utf8');
const script = html.match(/<script>\s*\n([\s\S]*?)<\/script>/)[1];

// 提取 obsidianPreprocess + simpleMarkdown + simpleMarkdownFallback（至 NOTEHELPER 注释为止）
const start = script.indexOf('function obsidianPreprocess');
const end = script.indexOf('NOTEHELPER FULLSCREEN');
if (start < 0 || end < 0) { console.log('slice fail', start, end); process.exit(1); }
eval(script.slice(start, end));

global.katex = { renderToString: (f, o) => '<span class="katex">MATH[' + f + ']</span>' };

const sample = [
  '# 测试标题',
  '',
  '==高亮文字== 和 ~~删除线~~ 和 [[双链]]',
  '',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '',
  '> [!note] 注意',
  '> 这是 callout 内容',
  '',
  '公式：$x^2 + y^2 = z^2$',
  '',
  '```python',
  'print("hello $")',
  '```',
  '',
  '| 列A | 列B |',
  '|---|---|',
  '| 1 | 2 |',
].join('\n');
const out = simpleMarkdown(sample);
console.log('===== marked 管线输出 =====');
console.log(out);
console.log('---');
console.log(
  'h1:', out.includes('<h1'),
  '| mark:', out.includes('<mark>高亮文字</mark>'),
  '| del:', out.includes('<del>删除线</del>'),
  '| wiki:', out.includes('wiki-link'),
  '| task:', out.includes('type="checkbox"'),
  '| callout:', out.includes('callout-note'),
  '| katex:', out.includes('katex'),
  '| pre:', out.includes('<pre>'),
  '| table:', out.includes('<table>'),
  '| code-safe:', out.includes('print(&quot;hello $&quot;)'),
);
// 真实 ch1-3
const raw = fs.readFileSync(require('path').join(__dirname, '..', 'server', 'uploads', '1788700665483_wpymtr__ch1-3.md'), 'utf8');
const out2 = simpleMarkdown(raw);
console.log('ch1-3: table=' + out2.includes('<table>'), 'h1=' + out2.includes('<h1'), 'ul=' + out2.includes('<ul>'), 'katex=' + out2.includes('katex'), 'strong=' + out2.includes('<strong>'));
