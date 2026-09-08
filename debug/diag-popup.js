// 模拟历史引用卡弹窗渲染，检查输出 HTML
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRequire = createRequire(path.join(here, '..', 'server', 'package.json'));
serverRequire('dotenv').config({ path: path.join(here, '..', 'server', '.env') });
const { createClient } = serverRequire('@supabase/supabase-js');

// 提取页面的渲染函数（simpleMarkdown/esc/citationModalShell 依赖较多，抽取核心）
import * as vm from 'vm';
const html = fs.readFileSync(path.join(here, 'full-app-test.html'), 'utf8');
const script = html.match(/<script>\s*\n([\s\S]*?)<\/script>/)[1];
const start = script.indexOf('function unescapeEntities');
const end = script.indexOf('NOTEHELPER FULLSCREEN');
vm.runInThisContext(script.slice(start, end));

const supabase = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY);
const { data: all } = await supabase.from('chat_messages').select('id,role,citations,content').order('created_at', { ascending: true }).limit(200);
const target = (all || []).find((m) => m.role === 'assistant' && m.citations && m.citations.length && /期中/.test(m.content.slice(0, 80)));
const cit = target.citations.find((c) => c.type === 'material' && c.title === 'ch1-3');
console.log('存储引用:', JSON.stringify(cit).slice(0, 300));

// 模拟客户端弹窗路径：material 无页码 → file-content 取 fileType → 渲染 snippet
const fcRes = await fetch('http://localhost:9091/api/v1/materials/' + cit.sourceId + '/file-content');
const fc = await fcRes.json();
const d = fc.data || {};
const fileType = (d.fileType || '').toUpperCase();
console.log('fileType:', fileType, '| pages:', (d.pages || []).length);
console.log('snippet 前 200 字:', cit.snippet.slice(0, 200));

const mdSnippet = simpleMarkdown(cit.snippet);
console.log('\n=== simpleMarkdown(snippet) 输出（前 800 字）===');
console.log(mdSnippet.slice(0, 800));
console.log('\n=== 结尾 300 字 ===');
console.log(mdSnippet.slice(-300));
