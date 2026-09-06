/**
 * 备份 guest（演示）用户数据到 debug/guest-backup-<时间戳>.json
 * 用于跑 seed-scenario 前保护原有测试数据（seed 会清空该用户）。
 * 恢复：暂无自动恢复脚本，必要时人工写回或改 seed 逻辑。
 */
import { Client } from 'pg';
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const _require = createRequire(import.meta.url);
  _require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

  const GUEST = '11111111-1111-1111-1111-111111111111';
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();

  const tables = [
    'study_notes', 'materials', 'file_contents', 'draft_pool', 'knowledge_nodes',
    'chat_sessions', 'chat_messages', 'problem_solving_logs', 'paper_problem_logs',
    'reflections', 'stickynotes', 'forums', 'forum_posts', 'papernote_style',
  ];

  const backup: Record<string, any[]> = {};
  for (const t of tables) {
    try {
      const r = await c.query(`SELECT * FROM public.${t} WHERE user_id = $1`, [GUEST]);
      backup[t] = r.rows;
      console.log(`${t}: ${r.rows.length} 行`);
    } catch (e: any) {
      console.log(`${t}: 跳过（${e.message.slice(0, 60)}）`);
      backup[t] = [];
    }
  }

  const outPath = path.resolve(process.cwd(), '..', 'debug', `guest-backup-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2));
  console.log(`✅ 备份完成: ${outPath}`);
  await c.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
