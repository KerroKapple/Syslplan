'use strict';
/** 扫描目录下所有 PDF，用真实文本提取器判断"文本型 / 扫描型" */
const fs = require('fs');
const path = require('path');
const { extract } = require('./pdftext.js');

const roots = process.argv.slice(2);
if (!roots.length) { console.error('用法: node survey.js <目录或文件> ...'); process.exit(1); }

const files = [];
const walk = p => {
  const st = fs.statSync(p);
  if (st.isDirectory()) fs.readdirSync(p).forEach(f => walk(path.join(p, f)));
  else if (/\.pdf$/i.test(p)) files.push(p);
};
roots.forEach(walk);

const CJK = /[一-鿿]/g;
const results = [];

for (const f of files.sort()) {
  const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
  let r;
  try { r = extract(f); }
  catch (e) { results.push({ rel, pages: 0, cjk: 0, perPage: 0, verdict: '解析失败', note: e.message }); continue; }
  const all = r.pages.join('\n');
  const cjk = (all.match(CJK) || []).length;
  const bad = (all.match(/�/g) || []).length;
  const perPage = r.pages.length ? Math.round(cjk / r.pages.length) : 0;
  let verdict;
  if (perPage >= 300) verdict = '文本型-好';
  else if (perPage >= 60) verdict = '文本型-弱';
  else verdict = '扫描图片型';
  const badRatio = cjk + bad > 0 ? bad / (cjk + bad) : 0;
  if (badRatio > 0.15 && bad > 50) verdict = '乱码(字体无映射)';
  results.push({ rel, pages: r.pages.length, cjk, perPage, bad, verdict, warn: r.warnings.length });
}

results.sort((a, b) => b.perPage - a.perPage);
console.log('每页汉字数'.padStart(10) + '  页数  乱码   判定           文件');
for (const r of results) {
  console.log(String(r.perPage).padStart(10) + '  ' + String(r.pages).padStart(4) + '  ' +
    String(r.bad || 0).padStart(4) + '   ' + (r.verdict + '            ').slice(0, 16) + ' ' + r.rel);
}
const g = results.filter(r => r.verdict.startsWith('文本型'));
console.log(`\n合计 ${results.length} 个 PDF：文本型 ${g.length} 个，扫描/乱码 ${results.length - g.length} 个`);
