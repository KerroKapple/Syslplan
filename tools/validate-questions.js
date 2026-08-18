'use strict';
/** questions.json 质量体检：任何一条不通过都必须人工确认 */
const path = require('path');
const q = require(path.resolve(__dirname, '..', 'questions.json')).questions;

const issues = [];
const add = (id, msg) => issues.push(`${id}: ${msg}`);

for (const x of q) {
  const opts = ['A', 'B', 'C', 'D'].map(L => x.options[L]);
  const all = [x.stem, ...opts].join('');

  if (/�/.test(all)) add(x.id, '含乱码字符');
  if (!['A', 'B', 'C', 'D'].includes(x.answer)) add(x.id, `答案非法: ${x.answer}`);
  if (x.stem.length < 8) add(x.id, `题干过短(${x.stem.length}字)`);
  if (x.stem.length > 400) add(x.id, `题干过长(${x.stem.length}字)，可能混入了解析`);
  opts.forEach((o, i) => {
    const L = 'ABCD'[i];
    if (!o || !o.trim()) add(x.id, `选项${L}为空`);
    if (o && o.length > 220) add(x.id, `选项${L}过长(${o.length}字)，可能吞进了下一段`);
  });
  if (new Set(opts.map(o => (o || '').trim())).size !== 4) add(x.id, '存在完全重复的选项');
  if (/信管网|cnitpm|参考答案|解析[：:]/.test(x.stem)) add(x.id, '题干混入了广告或答案文字');
  opts.forEach((o, i) => { if (/信管网|cnitpm|参考答案/.test(o || '')) add(x.id, `选项${'ABCD'[i]}混入广告或答案文字`); });
  if (/^[ABCD][、.．]/.test(x.stem)) add(x.id, '题干疑似以选项开头');
}

// 题号唯一性
const ids = new Set();
for (const x of q) { if (ids.has(x.id)) add(x.id, '题号重复'); ids.add(x.id); }

// 答案分布（严重偏斜说明解析可能串位）
const dist = { A: 0, B: 0, C: 0, D: 0 };
q.forEach(x => { if (dist[x.answer] !== undefined) dist[x.answer]++; });

console.log(`体检 ${q.length} 题`);
console.log('答案分布:', Object.entries(dist).map(([k, v]) => `${k}=${v}(${(v / q.length * 100).toFixed(1)}%)`).join('  '));
const maxShare = Math.max(...Object.values(dist)) / q.length;
if (maxShare > 0.4) console.log('⚠️ 某个选项占比超过 40%，请人工抽查是否答案串位');

console.log('题干平均长度:', Math.round(q.reduce((s, x) => s + x.stem.length, 0) / q.length), '字');
console.log('带解析的题数:', q.filter(x => x.explanation && x.explanation.length > 10).length);

if (issues.length) {
  console.log(`\n❌ 发现 ${issues.length} 处问题:`);
  issues.slice(0, 40).forEach(i => console.log('  ' + i));
  if (issues.length > 40) console.log(`  ... 另有 ${issues.length - 40} 处`);
  process.exitCode = 1;
} else {
  console.log('\n✅ 全部通过：无乱码、无空选项、无重复选项、题干未混入广告或答案');
}
