/**
 * 重跑资料分类（issue 跟进：文件夹结构与知识树对齐）
 *
 * 1. 找到演示用户（guest）下 logical_path 形如 /学习资料/* 的资料——
 *    这些是旧 seed 的「用户指定路径」，与 AI 学科树（tags）不一致
 * 2. 清空 logical_path + ai_processed=false + process_status=pending
 * 3. 逐个触发 POST /knowledge-builder/process-content 重新分类，
 *    让 logical_path 由 AI 的 L1/L2/L3 派生，与知识树同构
 *
 * 用法：先启动服务，cd server && npx tsx scripts/reclassify-materials.ts
 */
import { createRequire } from 'node:module';
import * as path from 'path';

const _require = createRequire(import.meta.url);
let envPath = path.resolve('.env');
if (!_require('fs').existsSync(envPath)) envPath = path.resolve('..', '.env');
_require('dotenv').config({ path: envPath });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.COZE_SUPABASE_URL || '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || '';
const API = 'http://localhost:9091/api/v1';
const GUEST = '11111111-1111-1111-1111-111111111111';

async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function main() {
  const supabase = await getSupabase();

  // 1. 找目标资料（旧 seed 用户路径；可选 --prefix 按文件名前缀过滤；--bad-papercore 定位 LLM 兜底摘要）
  const prefixArg = process.argv.find((a) => a.startsWith('--prefix='));
  const prefix = prefixArg ? prefixArg.split('=')[1] : '';
  const badPapercore = process.argv.includes('--bad-papercore');
  let query = supabase
    .from('materials')
    .select('id, name, logical_path, papercore')
    .eq('user_id', GUEST);
  if (badPapercore) {
    // generatePapercore 旧兜底路径的签名：原文开头 150 字（现已在服务端修复）
    query = query.gte('char_length(papercore)', 148).lte('char_length(papercore)', 152);
  } else if (prefix) {
    query = query.like('name', `${prefix}%`);
  } else {
    query = query.like('logical_path', '%学习资料%');
  }
  const { data: targets } = await query;
  console.log(`🎯 找到 ${targets?.length || 0} 份待对齐资料`);

  if (!targets || targets.length === 0) {
    console.log('无需处理。');
    return;
  }

  // 2. 清空用户路径 + 标记待处理
  for (const t of targets) {
    const { error } = await supabase
      .from('materials')
      .update({ logical_path: null, ai_processed: false, process_status: 'pending' })
      .eq('id', t.id);
    if (error) console.error(`  ❌ 重置 ${t.name}: ${error.message}`);
  }
  console.log('✅ 已重置路径与处理状态\n');

  // 3. 逐个触发重新分类（同步等待，分类在后台状态机中完成）
  let ok = 0;
  for (const t of targets) {
    try {
      const r = await fetch(`${API}/knowledge-builder/process-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'material', id: t.id }),
      });
      const j: any = await r.json().catch(() => ({}));
      const status = j?.data?.status || (r.ok ? 'ok' : 'fail');
      console.log(`   [${++ok}/${targets.length}] ${t.name.slice(0, 30)} → ${status}`);
    } catch (e: any) {
      console.log(`   [${++ok}/${targets.length}] ${t.name.slice(0, 30)} → 请求失败: ${e.message}`);
    }
  }

  console.log('\n⏳ 分类在服务端后台进行（process_status 跟踪），完成后控制中心红点提示。');
  console.log('   可运行 npx tsx scripts/e2e-check.ts 或刷新页面验证 tags 与 logical_path 对齐。');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
