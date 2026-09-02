/**
 * 迁移执行脚本：按文件名显式应用 migrations/ 下的 SQL 文件（事务内执行）。
 * 已应用的迁移记录在 public.schema_migrations，重复执行自动跳过。
 *
 * 用法（在 server/ 目录下）：
 *   npx tsx scripts/apply-migrations.ts 002_add_related_draft_ids.sql 003_add_reflections_raw_text.sql
 *
 * 需在 server/.env 配置数据库连接串：
 *   SUPABASE_DB_URL=postgresql://postgres:<密码>@db.<ref>.supabase.co:5432/postgres
 * （Supabase Dashboard → Project Settings → Database → Connection string）
 */
import { Client } from 'pg';
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as path from 'path';

const _require = createRequire(import.meta.url);
const _path = _require('path') as typeof import('path');

_require('dotenv').config({ path: _path.resolve(process.cwd(), '.env') });

const connString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!connString) {
  console.error('缺少 SUPABASE_DB_URL，请在 server/.env 中配置数据库连接串');
  process.exit(1);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('用法: npx tsx scripts/apply-migrations.ts <迁移文件名...>');
  process.exit(1);
}

const client = new Client({ connectionString: connString });

async function main() {
  await client.connect();
  await client.query(
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (
       filename text PRIMARY KEY,
       applied_at timestamptz DEFAULT now()
     )`,
  );

  for (const name of targets) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.schema_migrations WHERE filename = $1',
      [name],
    );
    if (rowCount) {
      console.log(`跳过（已应用）: ${name}`);
      continue;
    }
    const sql = fs.readFileSync(_path.resolve(process.cwd(), 'migrations', name), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`✅ 已应用: ${name}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
}

main()
  .catch((e) => {
    console.error('迁移失败:', e.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
