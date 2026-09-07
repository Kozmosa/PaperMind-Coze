const fs = require('fs');
const path = require('path');
// 提取 live viewNoteFullscreen 的渲染逻辑并模拟
const html = fs.readFileSync(path.join(__dirname, 'full-app-test.html'), 'utf8');
const script = html.match(/<script>\s*\n([\s\S]*?)<\/script>/)[1];
// 提取 simpleMarkdown（含 unescapeEntities、obsidianPreprocess）
const start = script.indexOf('function unescapeEntities');
const end = script.indexOf('NOTEHELPER FULLSCREEN');
eval(script.slice(start, end));

(async () => {
  const res = await fetch('http://localhost:9091/api/v1/study-notes/c96495cf-af16-4a68-b4a0-3c4f1913ca0f');
  const json = await res.json();
  const note = json.data || json;
  const blocks = note.blocks || [];
  const papercore = note.papercore || '';
  const tags = note.tags || [];
  console.log('blocks:', JSON.stringify(blocks).slice(0, 120));
  console.log('papercore len:', papercore.length, '| tags:', JSON.stringify(tags));
  let h = '';
  try {
    if (blocks && blocks.length > 0) {
      blocks.forEach((b) => {
        if (b.type === 'text') h += simpleMarkdown(b.content || '');
      });
    }
    if (papercore) h += '<AI摘要>' + simpleMarkdown(papercore) + '</AI摘要>';
    if (tags.length > 0) h += tags.join(',');
    console.log('渲染成功，HTML 长度:', h.length);
    console.log('含 AI 摘要:', h.includes('AI 摘要'), '| 含 系统梳理:', h.includes('系统梳理'));
  } catch (e) {
    console.log('渲染抛错:', e.message);
  }
})();
