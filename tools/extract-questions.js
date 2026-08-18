'use strict';
/**
 * 从 01-真题/ 与 04-模拟题/ 中提取选择题 → questions.json
 *
 * 设计原则：宁可少解析，也不要错题错答案。
 * 一道题必须同时满足以下全部条件才会被收录：
 *   1. 题号连续（严格递增，杜绝把解析里的"(2)"误判成题号）
 *   2. A/B/C/D 四个选项齐全且都非空
 *   3. 能明确提取到 A-D 之一的答案
 *   4. 题干长度 >= 8 字，无乱码
 * 任何一条不满足 → 丢弃并记入 reject 清单，供人工处理。
 *
 * 支持四种版面（profile）：
 *   zhenti  信管网真题：  N、题干 / A、选项 / 信管网参考答案：X
 *   mock    全真模拟卷：  N/[单选题](1分) / A 选项 / 正确答案: X
 *   chapter 章节模拟题：  题目区在前，文末"参考答案"区里 N、【答案】X
 *   inline  复习题目书：  N、题干 / 选项 / 【答案】X 紧跟其后
 */
const fs = require('fs');
const path = require('path');
const { extract } = require('./pdftext.js');

const ROOT = path.resolve(__dirname, '..');
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

// ---------------- 数据源清单 ----------------
function buildSources() {
  const S = [];

  // 1) 历年真题（综合知识/上午卷）
  [
    ['2017年下半年', '01-真题/2017年下半年/2017年下半年系统规划与管理师真题（上午试题和答案解析）.pdf'],
    ['2018年上半年', '01-真题/2018年上半年/2018年上半年系统规划与管理师真题（上午试题和答案解析）.pdf'],
    ['2019年上半年', '01-真题/2019年上半年/2019年上半年系统规划与管理师真题（上午试题和答案解析）.pdf'],
    ['2020年下半年', '01-真题/2020年下半年/2020下半年真题及答案解析（上午）.pdf'],
  ].forEach(([label, file]) => S.push({ label, file, type: '真题', profile: 'zhenti', max: 75 }));

  // 2) 全真模拟卷（综合知识）
  const mockDir = path.join(ROOT, '04-模拟题/全真模拟题');
  if (fs.existsSync(mockDir)) {
    fs.readdirSync(mockDir).filter(f => /综合知识.*\.pdf$/.test(f)).sort().forEach(f => {
      const juan = /卷一/.test(f) ? '卷一' : /卷二/.test(f) ? '卷二' : f;
      S.push({ label: `2021年5月模拟${juan}`, file: `04-模拟题/全真模拟题/${f}`, type: '模拟卷', profile: 'mock', max: 80 });
    });
  }

  // 3) 章节模拟题
  const chDir = path.join(ROOT, '04-模拟题/章节模拟题');
  if (fs.existsSync(chDir)) {
    fs.readdirSync(chDir).filter(f => /\.pdf$/i.test(f)).forEach(f => {
      const m = f.match(/第(十[一二]|[一二三四五六七八九十])章/);
      const ch = m ? CN_NUM[m[1]] : null;
      S.push({
        label: (m ? `第${m[1]}章` : f.replace(/\.pdf$/i, '')) + ' 练习',
        file: `04-模拟题/章节模拟题/${f}`, type: '章节练习', chapter: ch, profile: 'chapter', max: 120,
      });
    });
    S.sort((a, b) => (a.chapter || 0) - (b.chapter || 0));
  }

  // 4) 重点复习题目书
  if (fs.existsSync(path.join(ROOT, '04-模拟题/重点复习题目书.pdf')))
    S.push({ label: '重点复习题目书', file: '04-模拟题/重点复习题目书.pdf', type: '复习题', profile: 'inline', max: 200 });

  return S;
}

// ---------------- 文本清洗 ----------------
function denoise(text) {
  return text.split('\n').filter(line => {
    const l = line.trim();
    if (!l) return true;
    if (/^信管网\(www\.cnitpm\.com\)/.test(l)) return false;
    if (/^请到信管网查看答案和解析/.test(l)) return false;
    if (/^本资料由信管网/.test(l)) return false;
    if (/^信管网(是专业|资料库|培训中心|考试中心|系规频道|——)/.test(l)) return false;
    if (/^查看解析[：:]/.test(l)) return false;
    if (/^解析[：:]\s*https?:\/\//.test(l)) return false;
    if (/^https?:\/\/\S+$/.test(l)) return false;
    if (/^第\s*\d+\s*页/.test(l)) return false;
    if (/更多资料请访问|91grk\.com|联系QQ|全程辅导培训/.test(l)) return false;
    return true;
  }).join('\n');
}

// ---------------- 选项提取 ----------------
// 部分资料里选项字母被排成小写（如 'c. 发布工具'），一律按大写归一
const OPT_LINE = /(?:^|\n)[ \t]*([ABCDabcd])[ \t]*[、.．,][ \t]*([^\n]*)/g;
const OPT_LINE_SP = /(?:^|\n)[ \t]*([ABCD])[ \t]+([^\n]+)/g;   // 模拟卷用空格分隔：'A 量化器'

/** 行首式选项 */
function optionsByLine(block, re) {
  const opts = {}; let firstAt = -1, m;
  const r = new RegExp(re.source, 'g');
  while ((m = r.exec(block)) !== null) {
    const L = m[1].toUpperCase();
    if (opts[L] !== undefined) continue;
    if (firstAt < 0) firstAt = m.index;
    opts[L] = m[2].trim();
  }
  return { opts, firstAt };
}

/** 内联式选项：A、x   B、y   C、z   D、w（可能同行，也可能跨行） */
function optionsInline(block) {
  const at = {};
  for (const L of ['A', 'B', 'C', 'D']) {
    const r = new RegExp('(?:^|[\\s\\n）)])[' + L + L.toLowerCase() + ']\\s*[、.．]\\s*', 'g');
    let m, prev = at[{ A: null, B: 'A', C: 'B', D: 'C' }[L]];
    while ((m = r.exec(block)) !== null) {
      const pos = m.index + m[0].length;
      if (prev === undefined || prev === null || pos > prev.end) { at[L] = { start: m.index, end: pos }; break; }
    }
  }
  if (['A', 'B', 'C', 'D'].some(L => !at[L])) return { opts: {}, firstAt: -1 };
  if (!(at.A.start < at.B.start && at.B.start < at.C.start && at.C.start < at.D.start)) return { opts: {}, firstAt: -1 };
  const ends = { A: at.B.start, B: at.C.start, C: at.D.start, D: block.length };
  const opts = {};
  for (const L of ['A', 'B', 'C', 'D']) {
    opts[L] = block.slice(at[L].end, ends[L])
      .split(/【答案】|【解析】|正确答案|信管网参考答案|参考答案|答案[：:]/)[0]
      .replace(/\s*\n\s*/g, ' ').trim();
  }
  return { opts, firstAt: at.A.start };
}

/** 综合：先试行首式，不齐再试内联式 */
function extractOptions(block, profile) {
  const primary = profile === 'mock'
    ? optionsByLine(block, OPT_LINE_SP)
    : optionsByLine(block, OPT_LINE);
  const full = o => ['A', 'B', 'C', 'D'].every(L => o[L] !== undefined && o[L] !== '');
  if (full(primary.opts)) {
    // 切掉与答案同行的尾巴
    for (const L of ['A', 'B', 'C', 'D'])
      primary.opts[L] = primary.opts[L]
        .split(/【答案】|【解析】|正确答案|信管网参考答案|参考答案[^\n]{0,20}?[：:]|信管网解析|查看解析|解析[：:]/)[0].trim();
    if (full(primary.opts)) return primary;
  }
  const inl = optionsInline(block);
  if (full(inl.opts)) return inl;
  return primary.firstAt >= 0 ? primary : inl;
}

/** 判断是否像一道真题：A/B/C/D 齐全、按序、且 A 紧跟题干 */
function looksLikeQuestion(text, pos, profile) {
  const win = text.slice(pos, pos + 900);
  const { opts, firstAt } = extractOptions(win, profile);
  if (['A', 'B', 'C', 'D'].some(L => !opts[L])) return false;
  return firstAt >= 0 && firstAt <= 400;
}

// ---------------- 各版面的答案定位 ----------------
/** 各家版面的答案写法五花八门，统一成一条 */
const ANSWER_ANY = /(?:【答案】|【参考答案】\s*[：:]?|信管网参考答案[^\n：:]{0,30}?[：:]|参考答案\s*[：:]|正确答案\s*[：:]|答案\s*[：:])[ \t]*\n?[ \t]*([A-D])(?![A-Za-z])/;

const ANSWER_PATTERNS = {
  zhenti: /参考答案[^\n：:]{0,30}?[：:][ \t]*\n?[ \t]*([A-D])(?![A-Za-z])/,
  mock: /正确答案[：:][ \t]*([A-D])(?![A-Za-z])/,
  inline: ANSWER_ANY,
  chapter: ANSWER_ANY,
};

/**
 * 章节模拟题有两种排法：答案集中在文末"参考答案"区，或紧跟每题。
 * 先试着建文末映射；条目太少说明是"紧跟"排法，退回逐题就地找答案。
 */
function buildAnswerMap(text) {
  const idx = text.lastIndexOf('参考答案');
  if (idx < 0) return { map: new Map(), answerZoneAt: -1 };
  const zone = text.slice(idx);
  const map = new Map();
  const re = /(\d{1,3})\s*[、.．]?\s*(?:【答案】|【参考答案】\s*[：:]?|参考答案\s*[：:])\s*([A-D])(?![A-Za-z])/g;
  let m;
  while ((m = re.exec(zone)) !== null) {
    const n = parseInt(m[1], 10);
    if (!map.has(n)) map.set(n, m[2]);
  }
  // 少于 5 条视为"答案紧跟每题"的排法，不截断题目区
  return map.size >= 5 ? { map, answerZoneAt: idx } : { map: new Map(), answerZoneAt: -1 };
}

// ---------------- 单文件解析 ----------------
function parseFile(entry) {
  const raw = extract(path.join(ROOT, entry.file)).pages.join('\n');
  let text = denoise(raw);

  let answerMap = null;
  if (entry.profile === 'chapter') {
    const r = buildAnswerMap(text);
    answerMap = r.map;
    if (r.answerZoneAt > 200) text = text.slice(0, r.answerZoneAt);  // 题目区不含答案区，防串扰
  }

  // 题号候选
  const numRe = entry.profile === 'mock'
    ? /(?:^|\n)[ \t]*(\d{1,3})\s*\/\s*\[单选题\][^\n]*\n?/g
    : /(?:^|\n)[ \t]*(\d{1,3})[ \t]*[、.．][ \t]*/g;

  const cands = [];
  let m;
  while ((m = numRe.exec(text)) !== null)
    cands.push({ num: parseInt(m[1], 10), start: m.index + m[0].length, markerStart: m.index });

  const picked = [];
  let cursor = 0;
  for (let expect = 1; expect <= entry.max; expect++) {
    const hit = cands.find(c => c.num === expect && c.markerStart >= cursor && looksLikeQuestion(text, c.start, entry.profile));
    if (!hit) continue;
    picked.push(hit);
    cursor = hit.start;
  }

  const questions = [], rejects = [];
  for (let i = 0; i < picked.length; i++) {
    const cur = picked[i];
    const end = i + 1 < picked.length ? picked[i + 1].markerStart : text.length;
    const block = text.slice(cur.start, end);

    const { opts, firstAt } = extractOptions(block, entry.profile);
    const stem = (firstAt >= 0 ? block.slice(0, firstAt) : '').replace(/\s*\n\s*/g, '').trim();

    // 多空题防护：形如「（1）A、… （2）A、…」一题多空，每空各有一组 ABCD。
    // 这类题一道对应多个答案，用单选模型收录必然出错，直接丢弃。
    // 只看选项区（答案/解析之前），否则解析正文里的 "A、" 会造成误杀
    const optRegion = block.slice(Math.max(0, firstAt))
      .split(/【答案】|【解析】|正确答案|信管网参考答案|参考答案|信管网解析|解析[：:]/)[0];
    // 必须同行匹配（用 [ \t]* 而非 \s*）：真正的多空题写作「（1）A、… （2）A、…」，
    // 而正常题的选项写作「A.（4）（5）（6）\nB.（3）…」，跨行匹配会把后者误判成多空题。
    const subBlank = (optRegion.match(/[（(][ \t]*\d[ \t]*[）)][ \t]*[ABCDabcd][ \t]*[、.．]/g) || []).length;
    const aMarks = (optRegion.match(/(?:^|[ \t\n）)])[Aa][ \t]*[、.．]/gm) || []).length;
    if (subBlank >= 2 || aMarks >= 2) {
      rejects.push({ label: entry.label, num: cur.num, reasons: ['疑似一题多空/多组选项'] });
      continue;
    }

    // 选项里混进了后面几道题（题号与上一题同行时会发生），先尝试截断
    for (const L of ['A', 'B', 'C', 'D']) {
      if (opts[L] && opts[L].length > 120) {
        const cut = opts[L].search(/\s\d{1,3}\s*[、.．]\s*\S/);
        if (cut > 10) opts[L] = opts[L].slice(0, cut).trim();
      }
    }

    let answer = null;
    if (entry.profile === 'chapter' && answerMap && answerMap.has(cur.num)) answer = answerMap.get(cur.num);
    if (!answer) { const am = block.match(ANSWER_PATTERNS[entry.profile]); answer = am ? am[1] : null; }

    const why = [];
    if (!stem || stem.length < 8) why.push('题干缺失或过短');
    for (const L of ['A', 'B', 'C', 'D']) {
      if (opts[L] === undefined) why.push(`缺选项${L}`);
      else if (!opts[L]) why.push(`选项${L}为空`);
    }
    if (!answer) why.push('未找到答案');
    if (/�/.test(stem) || ['A', 'B', 'C', 'D'].some(L => /�/.test(opts[L] || ''))) why.push('含乱码字符');
    if (['A', 'B', 'C', 'D'].some(L => (opts[L] || '').length > 200)) why.push('选项过长(疑似吞入下一题)');
    {
      const vals = ['A', 'B', 'C', 'D'].map(L => (opts[L] || '').trim());
      if (vals.every(Boolean) && new Set(vals).size !== 4) why.push('存在完全相同的选项(原卷缺陷)');
    }

    if (why.length) {
      rejects.push({ label: entry.label, num: cur.num, reasons: Array.from(new Set(why)) });
      continue;
    }

    let explanation = '';
    const expIdx = block.search(/【解析】|信管网解析[：:]|解析[：:]/);
    if (expIdx >= 0) {
      explanation = block.slice(expIdx)
        .replace(/^(【解析】|信管网解析[：:]|解析[：:])\s*/, '')
        .replace(/(信管网)?参考答案[^\n]*\n?|正确答案[^\n]*\n?|【答案】[^\n]*\n?/g, '')
        .replace(/\s*\n\s*/g, '').trim().slice(0, 600);
    }

    const needsFigure = /下图|上图|如图|图\s*\d|下表|上表|示意图/.test(stem);

    questions.push({
      id: `${entry.label}-${cur.num}`,
      year: entry.label,
      type: entry.type,
      chapter: entry.chapter || null,
      num: cur.num,
      stem,
      options: { A: opts.A, B: opts.B, C: opts.C, D: opts.D },
      answer,
      explanation,
      needsFigure,
      source: path.basename(entry.file),
    });
  }

  return { questions, rejects, markers: picked.length };
}

// ---------------- 主流程 ----------------
const SOURCES = buildSources();
const all = [], allRejects = [], report = [];

for (const entry of SOURCES) {
  if (!fs.existsSync(path.join(ROOT, entry.file))) { report.push({ ...entry, status: '文件不存在' }); continue; }
  let r;
  try { r = parseFile(entry); }
  catch (e) { report.push({ ...entry, status: '解析异常: ' + e.message }); continue; }
  all.push(...r.questions);
  allRejects.push(...r.rejects);
  report.push({ ...entry, status: 'ok', ok: r.questions.length, rej: r.rejects.length, markers: r.markers });
}

const seen = new Set();
const deduped = all.filter(q => { if (seen.has(q.id)) return false; seen.add(q.id); return true; });
const TYPE_ORDER = { 真题: 0, 模拟卷: 1, 章节练习: 2, 复习题: 3 };
deduped.sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || a.year.localeCompare(b.year, 'zh') || a.num - b.num);

fs.writeFileSync(path.join(ROOT, 'questions.json'), JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  total: deduped.length,
  byType: Object.fromEntries(Object.entries(TYPE_ORDER).map(([t]) => [t, deduped.filter(q => q.type === t).length])),
  years: Array.from(new Set(deduped.map(q => q.year))),
  questions: deduped,
}, null, 1), 'utf8');

console.log('===== 解析结果 =====');
let lastType = null;
for (const r of report) {
  if (r.type !== lastType) { console.log(`\n【${r.type}】`); lastType = r.type; }
  if (r.status !== 'ok') { console.log(`  ✗ ${r.label}  ${r.status}`); continue; }
  const flag = r.ok === 0 ? '✗' : r.rej > r.ok * 0.25 ? '△' : '✓';
  console.log(`  ${flag} ${(r.label + '                ').slice(0, 18)} 收录 ${String(r.ok).padStart(3)} 题　识别 ${String(r.markers).padStart(3)}　丢弃 ${r.rej}`);
}

const byType = {};
deduped.forEach(q => { byType[q.type] = (byType[q.type] || 0) + 1; });
console.log(`\n已写入 questions.json：共 ${deduped.length} 题`);
Object.entries(byType).forEach(([t, n]) => console.log(`  ${t}　${n} 题`));

console.log('\n===== 真题各年缺失题号（需人工补录）=====');
for (const e of SOURCES.filter(s => s.type === '真题')) {
  const got = new Set(deduped.filter(q => q.year === e.label).map(q => q.num));
  if (!got.size) continue;
  const miss = []; for (let i = 1; i <= 75; i++) if (!got.has(i)) miss.push(i);
  const ranges = [];
  for (const n of miss) { const l = ranges[ranges.length - 1]; if (l && l[1] === n - 1) l[1] = n; else ranges.push([n, n]); }
  console.log(`  ${e.label}  收录 ${got.size}/75，缺 ${miss.length} 题: ` + (ranges.map(([a, b]) => a === b ? a : `${a}-${b}`).join('、') || '无'));
}

if (allRejects.length) {
  const byReason = {};
  for (const r of allRejects) { const k = r.reasons.join('+'); (byReason[k] = byReason[k] || []).push(`${r.label}#${r.num}`); }
  console.log(`\n===== 丢弃明细（${allRejects.length} 题，不会进入刷题工具）=====`);
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length))
    console.log(`  [${k}] ${v.length} 题: ${v.slice(0, 8).join('、')}${v.length > 8 ? ' …' : ''}`);
}
