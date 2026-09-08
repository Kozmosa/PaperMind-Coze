// 历史会话问题重跑：用新检索管线重新提问，对比旧引用与新引用
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

(async () => {
  const supabase = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY);
  const { data: sessions } = await supabase.from('chat_sessions').select('id,title').order('created_at', { ascending: true });
  for (const s of sessions || []) {
    const { data: msgs } = await supabase.from('chat_messages').select('role,content,citations').eq('session_id', s.id).order('created_at', { ascending: true });
    const userMsgs = (msgs || []).filter((m) => m.role === 'user');
    console.log('\n════════════════════════════════════════');
    console.log('【会话】' + s.title + '（' + userMsgs.length + ' 问）');
    for (const um of userMsgs) {
      console.log('\n【重跑问题】' + um.content);
      try {
        const { full, cits, ms } = await ask(um.content);
        console.log(`【耗时】${(ms / 1000).toFixed(0)}s 【回答】${full.length} 字`);
        console.log(`【新引用】${cits.length} 条:`);
        for (const c of cits) {
          const page = c.pageNumber ? `第${c.pageNumber}页` : '无页';
          console.log(`  - ${c.type.padEnd(11)} | ${(c.title || '').slice(0, 22).padEnd(24)} | ${page}`);
        }
      } catch (e) {
        console.log('【失败】', e.message);
      }
    }
    // 旧引用对比
    const oldCits = (msgs || []).filter((m) => m.role === 'assistant' && m.citations && m.citations.length);
    const oldCount = oldCits.reduce((n, m) => n + m.citations.length, 0);
    console.log(`【旧引用总数】${oldCount} 条（${oldCits.length} 条回答）`);
  }
  console.log('\n重跑完成');
})();
