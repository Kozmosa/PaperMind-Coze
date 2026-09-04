/**
 * 迁移执行脚本：按文件名显式应用 migrations/ 下的 SQL 文件（事务内执行）。
 * 已应用的迁移记录在 public.schema_migrations，重复执行自动跳过（幂等）。
 *
 * 用法（在 server/ 目录下）：
 *   npx tsx scripts/apply-migrations.ts                        # 应用 migrations/ 下全部待执行迁移
 *   npx tsx scripts/apply-migrations.ts 002_xxx.sql 004_yyy.sql # 只应用指定文件
 *
 * 凭据二选一（server/.env 或仓库根 .env）：
 *   1) SUPABASE_ACCESS_TOKEN  个人访问令牌（Dashboard → Account → Access Tokens 生成，sbp_ 开头）
 *                             —— 走 Management API POST /v1/projects/{ref}/database/query，
 *                                无需数据库密码，纯 HTTPS，无 IPv6/连接池限制（推荐）
 *   2) SUPABASE_DB_URL        postgresql://postgres:<密码>@...（Dashboard → Settings → Database）
 *                             —— pg 直连（云托管 Supabase 注意：直连地址 db.<ref>.supabase.co
 *                                仅 IPv6，无 IPv6 环境请改用 Connection pooler 的 URI）
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
if (!DB_URL && !ACCESS_TOKEN) {
  console.error(
    '缺少凭据：请在 .env 配置 SUPABASE_ACCESS_TOKEN（推荐，Dashboard → Account → Access Tokens）\n' +
      '或 SUPABASE_DB_URL（Dashboard → Project Settings → Database → Connection string）',
  );
  process.exit(1);
}

// 从 SUPABASE_URL（https://<ref>.supabase.co）解析项目 ref，供 Management API 使用
function projectRef(): string {
  const m = (process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL || '').match(
    /https:\/\/([a-z0-9]+)\.supabase\.co/i,
  );
  if (!m) throw new Error('无法从 SUPABASE_URL 解析项目 ref，请检查 .env');
  return m[1];
}

// ============ 执行后端抽象：pg 直连 或 Management API ============

interface SqlBackend {
  /** 执行一条/一组语句，返回 SELECT 的行（无结果返回空数组） */
  query(sql: string): Promise<any[]>;
  close(): Promise<void>;
}

class PgBackend implements SqlBackend {
  private client = new Client({ connectionString: DB_URL! });
  async query(sql: string) {
    const r = await this.client.query(sql);
    return r.rows || [];
  }
  async close() {
    await this.client.end();
  }
}

/** Management API 后端（experimental endpoint）：Bearer 个人访问令牌 */
class ManagementApiBackend implements SqlBackend {
  private ref = projectRef();
  async query(sql: string) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${this.ref}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Management API ${res.status}: ${text.slice(0, 300)}`);
    }
    const data: any = await res.json().catch(() => null);
    return Array.isArray(data) ? data : (data?.rows ?? data?.data ?? []);
  }
  async close() {}
}

// ============ 主流程 ============

const backend: SqlBackend = DB_URL ? new PgBackend() : new ManagementApiBackend();
console.log(DB_URL ? '🔌 后端：pg 直连' : `🔌 后端：Management API（项目 ${projectRef()}）`);

async function main() {
  await backend.query(
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (
       filename text PRIMARY KEY,
       applied_at timestamptz DEFAULT now()
     )`,
  );
  const appliedRows = await backend.query('SELECT filename FROM public.schema_migrations');
  const applied = new Set(appliedRows.map((r: any) => r.filename));

  const args = process.argv.slice(2);
  const markOnly = args[0] === '--mark';
  const targets = markOnly ? args.slice(1) : args;
  // 未指定文件名时，按文件名顺序应用 migrations/ 下全部 SQL
  const names = targets.length
    ? targets
    : fs
        .readdirSync(path.resolve('migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort();

  if (markOnly) {
    // 只登记不执行：用于基础表已由建库流程创建、迁移文件本身非幂等（如 CREATE POLICY）的场景
    for (const name of names) {
      if (applied.has(name)) {
        console.log(`跳过（已登记）: ${name}`);
        continue;
      }
      await backend.query(
        `INSERT INTO public.schema_migrations (filename) VALUES ('${name.replace(/'/g, "''")}')`,
      );
      console.log(`📝 已登记: ${name}`);
    }
    return;
  }

  if (names.length === 0) {
    console.log('没有待应用的迁移。');
    return;
  }

  let ok = 0;
  for (const name of names) {
    if (applied.has(name)) {
      console.log(`跳过（已应用）: ${name}`);
      continue;
    }
    const sql = fs.readFileSync(path.resolve('migrations', name), 'utf8');
    // 单次提交保证原子性：迁移体 + 记录写入同一个事务
    try {
      await backend.query(
        `BEGIN;\n${sql}\nINSERT INTO public.schema_migrations (filename) VALUES ('${name.replace(/'/g, "''")}');\nCOMMIT;`,
      );
      console.log(`✅ 已应用: ${name}`);
      ok++;
    } catch (e: any) {
      await backend.query('ROLLBACK;').catch(() => {});
      throw new Error(`${name}: ${e.message}`);
    }
  }
  console.log(ok > 0 ? `\n完成：本次应用 ${ok} 个迁移。` : '\n全部迁移均已是最新。');
}

main()
  .catch((e) => {
    console.error('迁移失败:', e.message);
    process.exitCode = 1;
  })
  .finally(() => backend.close());
