/**
 * 场景包 E2E 验证（API 级）：对照 test_data/scenario/README.md 手动清单中
 * 可后端验证的条目，输出通过/失败表。seed-scenario.ts 完成后运行。
 *
 * 用法：cd server && npx tsx scripts/e2e-check.ts
 */
import { createRequire } from 'node:module';
import * as path from 'path';

const _require = createRequire(import.meta.url);
_require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const BASE = 'http://localhost:9091';
const API = `${BASE}/api/v1`;

interface Check { name: string; pass: boolean; detail: string; }

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function tutorAsk(message: string): Promise<{ full: string; citations: any[] }> {
  const r = await fetch(`${API}/ai/tutor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let full = '';
  let citations: any[] = [];
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      if (!line.startsWith('data: ')) continue;
      const data = line.substring(6);
      if (data === '[DONE]') continue;
      try {
        const p = JSON.parse(data);
        if (p.content) full += p.content;
        if (p.done && Array.isArray(p.citations)) citations = p.citations;
      } catch {}
    }
  }
  return { full, citations };
}

async function main() {
  const checks: Check[] = [];
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  // 1. 控制中心：纪要 12 / 资料 8
  try {
    const notes = await getJson(`${API}/study-notes`);
    const mats = await getJson(`${API}/materials`);
    push('控制中心统计：纪要 12 / 资料 8', (notes.data?.length || 0) === 12 && (mats.data?.length || 0) === 8, `纪要 ${notes.data?.length}/12，资料 ${mats.data?.length}/8`);
  } catch (e: any) { push('控制中心统计', false, e.message); }

  // 2. 图谱：≥3 个领域圈
  try {
    const g = await getJson(`${API}/knowledge-builder/graph-data`);
    const domains = g.data?.domains || [];
    push('图谱领域圈 ≥3', domains.length >= 3, `${domains.length} 个领域：${domains.map((d: any) => d.name).join('、')}`);
    push('图谱标签节点非空', (g.data?.nodes?.length || 0) > 0, `${g.data?.nodes?.length} 个标签节点`);
  } catch (e: any) { push('图谱', false, e.message); }

  // 3. 历史会话 2 组
  try {
    const cs = await getJson(`${API}/chat-sessions`);
    push('历史会话 2 组', (cs.data?.length || 0) === 2, `${cs.data?.length} 个会话`);
  } catch (e: any) { push('历史会话', false, e.message); }

  // 4. QA 日志：30 天 52 条 + 最后 5 天加密
  try {
    const stats = await getJson(`${API}/problem-solving-logs/stats?days=30`);
    const total = stats.data?.total || 0;
    const daily: Record<string, number> = stats.data?.daily || {};
    const entries = Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0]));
    const last5 = entries.slice(-5).reduce((s, [, c]) => s + (c as number), 0);
    const prevTotal = total - last5;
    const prevDays = Math.max(1, entries.length - 5);
    const denser = prevDays > 0 && last5 / 5 >= prevTotal / prevDays;
    push('QA 日志 52 条（30 天）', total === 52, `total=${total}`);
    push('期中前加密形态（最后 5 天更密）', denser, `last5=${last5} vs 前段日均 ${(prevTotal / prevDays).toFixed(1)}`);
  } catch (e: any) { push('QA 日志', false, e.message); }

  // 5. 解题日志 12 条
  try {
    const pl = await getJson(`${API}/problem-logs`);
    push('解题日志 12 条', (pl.data?.length || 0) === 12, `${pl.data?.length} 条`);
  } catch (e: any) { push('解题日志', false, e.message); }

  // 6. 反思 1 份历史
  try {
    const rf = await getJson(`${API}/reflections`);
    push('历史反思 1 份', (rf.data?.length || 0) >= 1, `${rf.data?.length} 份`);
    if (rf.data?.[0]) {
      const r = rf.data[0];
      const dims = ['learning_behavior', 'challenge_report', 'thinking_pattern', 'suggestion'].filter((k) => r[k]);
      push('反思 4 维度完整', dims.length === 4, `${dims.length}/4 维度非空`);
    }
  } catch (e: any) { push('反思', false, e.message); }

  // 7. 社区：便利贴 4（3 public + 1 friends）
  try {
    const sn = await getJson(`${API}/stickynotes`);
    const pub = (sn.data || []).filter((s: any) => s.visibility === 'public' || s.visibility === null).length;
    const friends = (sn.data || []).filter((s: any) => s.visibility === 'friends').length;
    push('便利贴 3 public + 1 friends', pub >= 3 && friends >= 1, `public ${pub}, friends ${friends}, 共 ${sn.data?.length}`);
  } catch (e: any) { push('便利贴', false, e.message); }

  // 8. 论坛 2 个 + 帖子
  try {
    const fo = await getJson(`${API}/forums`);
    push('论坛 2 个', (fo.data?.length || 0) === 2, `${fo.data?.length} 个论坛`);
  } catch (e: any) { push('论坛', false, e.message); }

  // 9. Tutor 主推题 Q1（留数定理）
  try {
    const { full, citations } = await tutorAsk('留数定理和柯西积分公式是什么关系？');
    const types = [...new Set(citations.map((c: any) => c.type || c.sourceType))];
    const hasRequiredPoints =
      full.includes('柯西积分公式') && (full.includes('留数定理') || full.includes('留数'));
    push('Q1 回答覆盖必答要点', hasRequiredPoints && full.length > 100, `回答 ${full.length} 字，含柯西积分公式=${full.includes('柯西积分公式')}`);
    push('Q1 引用卡 ≥2 张', citations.length >= 2, `${citations.length} 张，类型：${types.join('/') || '无'}`);
  } catch (e: any) { push('Q1 Tutor 问答', false, e.message); }

  console.log('\n================ E2E 验证结果 ================');
  let pass = 0;
  for (const c of checks) {
    console.log(`${c.pass ? '✅' : '❌'} ${c.name} — ${c.detail}`);
    if (c.pass) pass++;
  }
  console.log(`\n通过 ${pass}/${checks.length}`);
}

main().catch((e) => { console.error('E2E 脚本异常:', e.message); process.exit(1); });
