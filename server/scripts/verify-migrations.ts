/**
 * 迁移校验脚本：确认关键列存在 + 迁移账本状态。
 *
 * 用法（在 server/ 目录下）：npx tsx scripts/verify-migrations.ts
 * 凭据与 apply-migrations.ts 相同：SUPABASE_ACCESS_TOKEN（Management API）或 SUPABASE_DB_URL（pg 直连）
 */
import { Client } from 'pg';
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as path from 'path';

const _require = createRequire(import.meta.url);

// 与 server/src/config/ai.ts 一致：优先 server/.env，回退仓库根 .env
let envPath = path.resolve('.env');
if (!fs.existsSync(envPath)) envPath = path.resolve('..', '.env');
_require('dotenv').config({ path: envPath });

const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const EXPECTED_COLUMNS: [string, string][] = [
  ['problem_solving_logs', 'related_draft_ids'], // migrations/002
  ['reflections', 'raw_text'], // migrations/003
  ['materials', 'process_status'], // migrations/004
  ['study_notes', 'process_status'], // migrations/004
  ['study_notes', 'logical_path'], // add_papermind_fields
  ['materials', 'ai_processed'], // add_papermind_fields
];

async function query(sql: string): Promise<any[]> {
  if (DB_URL) {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    try {
      return (await client.query(sql)).rows || [];
    } finally {
      await client.end();
    }
  }
  const ref = (process.env.SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1];
  if (!ref || !ACCESS_TOKEN) throw new Error('缺少 SUPABASE_ACCESS_TOKEN 或 SUPABASE_DB_URL');
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json().catch(() => null);
  return Array.isArray(data) ? data : (data?.rows ?? []);
}

const rows = await query(
  `SELECT table_name, column_name FROM information_schema.columns WHERE ${EXPECTED_COLUMNS.map(
    ([t, c]) => `(table_name='${t}' AND column_name='${c}')`,
  ).join(' OR ')}`,
);
const present = new Set(rows.map((r: any) => `${r.table_name}.${r.column_name}`));

let missing = 0;
for (const [t, c] of EXPECTED_COLUMNS) {
  const ok = present.has(`${t}.${c}`);
  if (!ok) missing++;
  console.log(`${ok ? '✅' : '❌'} ${t}.${c}`);
}

const ledger = await query(
  'SELECT filename, applied_at FROM public.schema_migrations ORDER BY filename',
);
console.log(`\n迁移账本（${ledger.length} 条）:`);
for (const r of ledger) console.log(`   ${r.filename} @ ${String(r.applied_at).slice(0, 19)}`);

console.log(
  missing === 0 ? '\n全部关键列就绪。' : `\n缺失 ${missing} 个列，请运行 apply-migrations.ts`,
);
process.exitCode = missing === 0 ? 0 : 1;
