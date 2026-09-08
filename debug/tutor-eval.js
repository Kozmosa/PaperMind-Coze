// tutor 对话效果测试：多场景提问 → 分析回答质量/引用相关性/页码定位/耗时
const QUERIES = [
  { q: '柯西积分公式是什么？怎么用它计算积分', scene: '概念问答（文本讲义）' },
  { q: '留数定理怎么用来计算实积分', scene: '纪要+扫描件混合' },
  { q: '动态规划求解多阶段决策问题的核心思想', scene: '扫描件（视觉OCR）' },
  { q: '机器学习损失函数和极大似然估计有什么关系', scene: 'MD 资料' },
  { q: '傅里叶级数收敛定理的条件是什么', scene: 'MD 资料+笔记' },
];

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

for (const { q, scene } of QUERIES) {
  console.log('\n════════════════════════════════════════');
  console.log('【场景】' + scene + '\n【问题】' + q);
  try {
    const { full, cits, ms } = await ask(q);
    console.log(`【耗时】${(ms / 1000).toFixed(0)}s 【回答】${full.length} 字（首 120 字预览）: ${full.replace(/\s+/g, ' ').slice(0, 120)}`);
    const types = {};
    for (const c of cits) types[c.type] = (types[c.type] || 0) + 1;
    console.log(`【引用】${cits.length} 条 ${JSON.stringify(types)}`);
    for (const c of cits) {
      const page = c.pageNumber ? `第${c.pageNumber}页` : '无页';
      console.log(`  - ${c.type.padEnd(11)} | ${(c.title || '').slice(0, 22).padEnd(24)} | ${page} | ${(c.snippet || '').replace(/\s+/g, ' ').slice(0, 40)}`);
    }
    // 质量信号
    const materialHit = cits.filter((c) => c.type === 'material').length;
    const pageHit = cits.filter((c) => c.type === 'material' && c.pageNumber).length;
    console.log(`【信号】资料引用 ${materialHit} 条，带页码 ${pageHit} 条（定位率 ${materialHit ? Math.round((pageHit / materialHit) * 100) : 0}%）`);
  } catch (e) {
    console.log('【失败】', e.message);
  }
}
console.log('\n测试完成');
