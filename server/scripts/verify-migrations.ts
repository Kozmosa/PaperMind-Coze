import { Client } from 'pg';
import { createRequire } from 'node:module';
import * as path from 'path';

const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });

await client.connect();
const { rows } = await client.query(
  "SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('problem_solving_logs','reflections') AND column_name IN ('related_draft_ids','raw_text') ORDER BY table_name",
);
console.log('列验证:', JSON.stringify(rows));

const cnt = await client.query('SELECT count(*) AS n FROM public.schema_migrations');
console.log('迁移记录数:', cnt.rows[0].n);

await client.end();
