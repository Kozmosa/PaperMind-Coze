import { Client } from 'pg';
import { createRequire } from 'node:module';
import * as path from 'path';
async function main() {
  const _require = createRequire(import.meta.url);
  _require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await client.connect();
  await client.query('BEGIN');
  try {
    const res = await client.query(
      `INSERT INTO public.problem_solving_logs (user_id, question, answer, steps, related_knowledge_node_ids, related_draft_ids, citation_snippets)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      ['migration-test-user', '测试问题', '测试回答', '["s1"]', '[]', '[]', '[]']
    );
    console.log('写入成功，id =', res.rows[0].id);
  } finally {
    await client.query('ROLLBACK');
    console.log('已回滚（不留测试数据）');
  }
  await client.end();
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
