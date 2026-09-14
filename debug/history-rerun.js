// 历史会话问题重跑：用新检索管线重新提问；加 --write 时重建会话消息写回数据库
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as path from 'path';
const here = path.dirname(fileURLToPath(import.meta.url));
// 从 server 目录解析依赖（debug 目录在 pnpm 工作区外无法直接 import 包）
const serverRequire = createRequire(path.join(here, '..', 'server', 'package.json'));
serverRequire('dotenv').config({ path: path.join(here, '..', 'server', '.env') });
const { createClient } = serverRequire('@supabase/supabase-js');

async function ask(message) {
  const t0 = Date.now();
  const r = await fetch('http://localhost:9091/api/v1/ai/tutor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '', cits = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const d = line.substring(6);
      if (d === '[DONE]') continue;
      try {
        const p = JSON.parse(d);
        if (p.content) full += p.content;
        if (p.done && Array.isArray(p.citations)) cits = p.citations;
      } catch (e) {}
    }
    buf = '';
  }
  return { full, cits, ms: Date.now() - t0 };
}

const WRITE_BACK = process.argv.includes('--write');
const supabase = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY);
const { data: sessions } = await supabase.from('chat_sessions').select('id,title').order('created_at', { ascending: true });
for (const s of sessions || []) {
  const { data: msgs } = await supabase.from('chat_messages').select('id,role,content,citations').eq('session_id', s.id).order('created_at', { ascending: true });
  const userMsgs = (msgs || []).filter((m) => m.role === 'user');
  console.log('\n════════════════════════════════════════');
  console.log('【会话】' + s.title + '（' + userMsgs.length + ' 问）' + (WRITE_BACK ? ' [写回模式]' : ''));
  const newMsgs = [];
  for (const um of userMsgs) {
    console.log('\n【重跑问题】' + um.content);
    try {
      const { full, cits, ms } = await ask(um.content);
      console.log(`【耗时】${(ms / 1000).toFixed(0)}s 【回答】${full.length} 字 【新引用】${cits.length} 条:`);
      for (const c of cits) {
        const page = c.pageNumber ? `第${c.pageNumber}页` : '无页';
        console.log(`  - ${c.type.padEnd(11)} | ${(c.title || '').slice(0, 22).padEnd(24)} | ${page}`);
      }
      newMsgs.push({ role: 'user', content: um.content });
      newMsgs.push({
        role: 'assistant',
        content: full,
        citations: cits.map((c) => ({
          type: c.type, sourceType: c.sourceType, title: c.title || c.fileName || '',
          sourceId: c.sourceId, papercore: c.papercore || '', snippet: c.snippet || '',
          tags: c.tags || [], pageNumber: c.pageNumber || null, fileName: c.fileName || '', draftId: c.draftId || null,
        })),
      });
    } catch (e) {
      console.log('【失败】', e.message);
    }
  }
  if (WRITE_BACK && newMsgs.length > 0) {
    const { error: delErr } = await supabase.from('chat_messages').delete().eq('session_id', s.id);
    if (delErr) { console.log('【删除旧消息失败】', delErr.message); continue; }
    const { error: insErr } = await supabase.from('chat_messages').insert(
      newMsgs.map((m) => ({ session_id: s.id, role: m.role, content: m.content, citations: m.citations || [] })),
    );
    console.log(insErr ? '【写回失败】' + insErr.message : '【已写回】会话消息重建完成');
  }
}
console.log('\n重跑完成');
