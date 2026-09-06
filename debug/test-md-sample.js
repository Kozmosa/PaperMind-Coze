const fs = require('fs');
const html = fs.readFileSync('full-app-test.html', 'utf8');
const m = html.match(/function simpleMarkdown[\s\S]*?\n\}/);
eval(m[0]);
global.katex = {
  renderToString: (f, o) => '<span class="katex">MATH[' + f + ']</span>',
};
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
  '> 第二行内容',
  '',
  '公式：$x^2 + y^2 = z^2$ 以及',
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
console.log(out);
console.log('---');
console.log(
  'mark:', out.includes('<mark>高亮文字</mark>'),
  '| del:', out.includes('<del>删除线</del>'),
  '| wiki:', out.includes('class="wiki-link"'),
  '| task:', out.includes('task-item'), out.includes('☐'), out.includes('☑'),
  '| callout:', out.includes('callout-note'),
  '| katex:', out.includes('katex'),
  '| code:', out.includes('background:#1F2937'),
  '| code-safe:', out.includes('print("hello $")'),
);
