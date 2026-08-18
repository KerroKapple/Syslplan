#!/usr/bin/env node
'use strict';
/**
 * 系统规划与管理师 · 综合知识刷题工具
 *
 *   node quiz.js                  进入交互菜单
 *   node quiz.js --year 2019      按年份/卷别刷题
 *   node quiz.js --random 20      随机抽 20 题
 *   node quiz.js --wrong          只刷错题本
 *   node quiz.js --exam           限时模考：75 题 75 分钟（真题+模拟卷）
 *   node quiz.js --stats          查看统计与历史
 *   node quiz.js --list           列出题库构成
 *
 * 可选参数：
 *   --type 真题       按题型筛选：真题 / 模拟卷 / 章节练习 / 复习题
 *   --chapter 5      只刷某章的章节练习（老教材章号）
 *   --limit N        限制题数
 *   --order seq      按题号顺序（默认随机）
 *   --no-explain     答完不显示解析
 *   --graduate N     错题连续答对 N 次后移出错题本（默认 2）
 *
 * 示例：
 *   node quiz.js --type 真题 --random 30      只从历年真题里随机抽 30 题
 *   node quiz.js --chapter 5                 刷第五章（IT服务部署实施）练习
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = __dirname;
const Q_FILE = path.join(ROOT, 'questions.json');
const W_FILE = path.join(ROOT, 'wrong.json');

// ---------- 终端着色 ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = s => c(1, s), dim = s => c(2, s);
const green = s => c(32, s), red = s => c(31, s), yellow = s => c(33, s), cyan = s => c(36, s);

// ---------- 数据 ----------
function loadQuestions() {
  if (!fs.existsSync(Q_FILE)) {
    console.error(red('找不到 questions.json'));
    console.error('请先运行：' + bold('node tools/extract-questions.js'));
    process.exit(1);
  }
  const d = JSON.parse(fs.readFileSync(Q_FILE, 'utf8'));
  if (!d.questions || !d.questions.length) { console.error(red('题库为空')); process.exit(1); }
  return d;
}

function loadWrong() {
  if (!fs.existsSync(W_FILE)) return { updated: null, items: {}, history: [] };
  try { const d = JSON.parse(fs.readFileSync(W_FILE, 'utf8')); d.items = d.items || {}; d.history = d.history || []; return d; }
  catch (e) { console.error(yellow('wrong.json 损坏，已忽略并将重建')); return { updated: null, items: {}, history: [] }; }
}

function saveWrong(w) {
  w.updated = new Date().toISOString().slice(0, 19).replace('T', ' ');
  fs.writeFileSync(W_FILE, JSON.stringify(w, null, 1), 'utf8');
}

/**
 * 行读取器。
 * 不用 rl.question()：它在管道输入（如 echo ... | node quiz.js）下
 * 只接住第一行，之后缓冲区里的行会因无监听者而被丢弃。
 * 这里自己维护队列，交互与管道两种场景都正确。
 * stdin 关闭时返回 null，调用方据此结束本次练习。
 */
function makeAsker(rl) {
  const queue = [], waiters = [];
  let closed = false;
  rl.on('line', l => { if (waiters.length) waiters.shift()(l); else queue.push(l); });
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  return prompt => new Promise(res => {
    process.stdout.write(prompt);
    if (queue.length) { const l = queue.shift(); if (!process.stdin.isTTY) process.stdout.write(l + '\n'); return res(l); }
    if (closed) return res(null);
    waiters.push(res);
  });
}

const today = () => new Date().toISOString().slice(0, 10);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- 参数 ----------
function parseArgs(argv) {
  const o = { mode: null, year: null, count: null, limit: null, order: 'random', explain: true, graduate: 2, type: null, chapter: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--year') { o.mode = 'year'; o.year = argv[++i]; }
    else if (a === '--random') { o.mode = 'random'; o.count = parseInt(argv[++i], 10) || 20; }
    else if (a === '--wrong') o.mode = 'wrong';
    else if (a === '--exam') o.mode = 'exam';
    else if (a === '--type') { o.type = argv[++i]; if (!o.mode) o.mode = 'random'; if (!o.count) o.count = 0; }
    else if (a === '--chapter') { o.chapter = parseInt(argv[++i], 10); if (!o.mode) o.mode = 'random'; if (!o.count) o.count = 0; }
    else if (a === '--stats') o.mode = 'stats';
    else if (a === '--list') o.mode = 'list';
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10);
    else if (a === '--order') o.order = argv[++i];
    else if (a === '--no-explain') o.explain = false;
    else if (a === '--graduate') o.graduate = Math.max(1, parseInt(argv[++i], 10) || 2);
    else if (a === '-h' || a === '--help') { o.mode = 'help'; }
  }
  return o;
}

// ---------- 各模式 ----------
function cmdList(db, wrong) {
  console.log(bold('\n题库概况'));
  console.log(`  生成日期 ${db.generated}　总题数 ${bold(db.total)}`);

  const byType = {};
  db.questions.forEach(q => { byType[q.type || '未分类'] = (byType[q.type || '未分类'] || 0) + 1; });
  console.log(bold('\n按题型') + dim('（--type 筛选）'));
  Object.entries(byType).forEach(([t, n]) => console.log(`  ${t}　${String(n).padStart(3)} 题`));

  const byYear = {};
  db.questions.forEach(q => { byYear[q.year] = (byYear[q.year] || 0) + 1; });
  console.log(bold('\n按来源') + dim('（--year 筛选，支持部分匹配）'));
  Object.entries(byYear).forEach(([y, n]) => console.log(`  ${(y + '              ').slice(0, 16)}${String(n).padStart(3)} 题`));

  const byCh = {};
  db.questions.filter(q => q.chapter).forEach(q => { byCh[q.chapter] = (byCh[q.chapter] || 0) + 1; });
  if (Object.keys(byCh).length) {
    console.log(bold('\n章节练习') + dim('（--chapter N 筛选，老教材章号）'));
    console.log('  ' + Object.entries(byCh).sort((a, b) => a[0] - b[0]).map(([c, n]) => `第${c}章:${n}`).join('　'));
  }
  const wn = Object.keys(wrong.items).length;
  console.log(bold('\n错题本') + `　${wn} 题` + (wn ? dim('（node quiz.js --wrong 开始复习）') : dim('（还没有错题）')));
  const fig = db.questions.filter(q => q.needsFigure).length;
  if (fig) console.log(dim(`\n注：其中 ${fig} 题引用了图表，刷到时会提示回原 PDF 看图。`));
}

function cmdStats(db, wrong) {
  const items = Object.entries(wrong.items);
  console.log(bold('\n===== 统计 ====='));
  console.log(`题库总题数　${db.total}`);
  console.log(`错题本题数　${items.length}`);

  if (items.length) {
    const byYear = {};
    items.forEach(([id, v]) => { const y = id.replace(/-\d+$/, ''); byYear[y] = (byYear[y] || 0) + 1; });
    console.log(bold('\n错题分布'));
    Object.entries(byYear).sort().forEach(([y, n]) => console.log(`  ${y}　${n} 题`));

    const top = items.filter(([, v]) => v.wrongCount > 1).sort((a, b) => b[1].wrongCount - a[1].wrongCount).slice(0, 10);
    if (top.length) {
      console.log(bold('\n反复做错的题（重点看）'));
      top.forEach(([id, v]) => {
        const q = db.questions.find(x => x.id === id);
        console.log(`  ${red('×' + v.wrongCount)}　${id}　${(q ? q.stem : '').slice(0, 42)}…`);
      });
    }
  }

  if (wrong.history.length) {
    console.log(bold('\n最近 12 次练习'));
    wrong.history.slice(-12).forEach(h => {
      const rate = h.total ? (h.correct / h.total * 100) : 0;
      const bar = '█'.repeat(Math.round(rate / 5)).padEnd(20, '·');
      const col = rate >= 70 ? green : rate >= 60 ? yellow : red;
      console.log(`  ${h.date}　${(h.mode + '            ').slice(0, 14)}　${col(bar)} ${col(rate.toFixed(0) + '%')}　${h.correct}/${h.total}`);
    });
    const all = wrong.history.reduce((s, h) => ({ t: s.t + h.total, c: s.c + h.correct }), { t: 0, c: 0 });
    if (all.t) {
      const r = all.c / all.t * 100;
      console.log(bold(`\n累计正确率　${r >= 70 ? green(r.toFixed(1) + '%') : r >= 60 ? yellow(r.toFixed(1) + '%') : red(r.toFixed(1) + '%')}　(${all.c}/${all.t})`));
      console.log(dim('　考试 75 题 45 分及格 = 60%；目标线建议定在 70%'));
    }
  } else {
    console.log(dim('\n还没有练习记录。'));
  }
}

function pickQuestions(db, wrong, opt) {
  let list;
  // 题型 / 章节筛选先于模式生效
  let pool = db.questions;
  if (opt.type) pool = pool.filter(q => (q.type || '').includes(opt.type));
  if (opt.chapter) pool = pool.filter(q => q.chapter === opt.chapter);
  if (!pool.length) {
    console.error(red('筛选后没有题目。可用题型：') + Array.from(new Set(db.questions.map(q => q.type))).join(' / '));
    const chs = Array.from(new Set(db.questions.map(q => q.chapter).filter(Boolean))).sort((a, b) => a - b);
    if (chs.length) console.error(red('可用章节：') + chs.join(' '));
    return null;
  }

  if (opt.mode === 'exam') {
    // 模考只用真题与模拟卷，最接近考场
    const src = pool.filter(q => q.type === '真题' || q.type === '模拟卷');
    list = shuffle((src.length >= 75 ? src : pool).slice()).slice(0, 75);
    console.log(yellow('\n【限时模考】75 题 / 75 分钟。建议自己掐表，中途不要查资料。'));
    return list;
  }

  if (opt.mode === 'year') {
    list = pool.filter(q => q.year.includes(opt.year));
    if (!list.length) {
      console.error(red(`没有匹配「${opt.year}」的题目。可用年份：`));
      Array.from(new Set(db.questions.map(q => q.year))).sort().forEach(y => console.error('  ' + y));
      return null;
    }
    if (opt.order !== 'seq') shuffle(list); else list.sort((a, b) => a.num - b.num);
  } else if (opt.mode === 'random') {
    list = shuffle(pool.slice());
    if (opt.count) list = list.slice(0, opt.count);
  } else if (opt.mode === 'wrong') {
    const ids = new Set(Object.keys(wrong.items));
    list = pool.filter(q => ids.has(q.id));
    if (!list.length) { console.log(green('\n错题本是空的 —— 目前没有做错的题。')); return null; }
    // 错得越多越靠前
    list.sort((a, b) => (wrong.items[b.id].wrongCount || 0) - (wrong.items[a.id].wrongCount || 0));
    if (opt.order === 'random') shuffle(list);
  }
  if (opt.limit) list = list.slice(0, opt.limit);
  return list;
}

// ---------- 出题主循环 ----------
async function runQuiz(db, wrong, list, opt, modeLabel) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsker(rl);

  console.log(bold(`\n===== 开始：${modeLabel}　共 ${list.length} 题 =====`));
  console.log(dim('输入 A/B/C/D 作答；直接回车＝跳过；输入 q 结束本次练习并统计\n'));

  let correct = 0, answered = 0, skipped = 0;
  const wrongThisRound = [];
  const startAt = Date.now();

  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const rec = wrong.items[q.id];
    console.log(bold(`\n[${i + 1}/${list.length}] ${cyan(q.year)} 第 ${q.num} 题`) +
      (rec ? red(`　(错题本 · 已错 ${rec.wrongCount} 次)`) : ''));
    if (q.needsFigure) console.log(yellow('⚠ 本题引用图/表，文字版不完整，请对照原 PDF：') + dim(q.source));
    console.log('  ' + q.stem);
    for (const L of ['A', 'B', 'C', 'D']) console.log(`   ${L}. ${q.options[L]}`);

    const input = await ask('\n你的答案 > ');
    if (input === null) { console.log(dim('\n输入结束，提前统计。')); break; }
    const ansRaw = input.trim();
    if (/^q(uit)?$/i.test(ansRaw)) { console.log(dim('\n已结束本次练习。')); break; }
    if (!ansRaw) { skipped++; console.log(dim(`跳过。正确答案是 ${q.answer}`)); continue; }

    const pick = ansRaw[0].toUpperCase();
    if (!'ABCD'.includes(pick)) { skipped++; console.log(dim(`无效输入，按跳过处理。正确答案是 ${q.answer}`)); continue; }

    answered++;
    if (pick === q.answer) {
      correct++;
      console.log(green('✓ 正确'));
      if (rec) {
        rec.rightStreak = (rec.rightStreak || 0) + 1;
        if (rec.rightStreak >= opt.graduate) {
          delete wrong.items[q.id];
          console.log(green(`  已连续答对 ${opt.graduate} 次，移出错题本 🎉`));
        } else {
          console.log(dim(`  错题本：连续答对 ${rec.rightStreak}/${opt.graduate} 次后移出`));
        }
      }
    } else {
      console.log(red(`✗ 错误`) + `　你选 ${pick}，正确答案 ${bold(green(q.answer))}`);
      console.log(dim(`  ${q.answer}. ${q.options[q.answer]}`));
      wrongThisRound.push(q.id);
      const r = wrong.items[q.id] || { wrongCount: 0, rightStreak: 0, firstWrong: today() };
      r.wrongCount = (r.wrongCount || 0) + 1;
      r.rightStreak = 0;
      r.lastWrong = today();
      r.lastChoice = pick;
      wrong.items[q.id] = r;
    }

    if (opt.explain && q.explanation) {
      console.log(dim('  解析：' + q.explanation.slice(0, 300) + (q.explanation.length > 300 ? '…' : '')));
    }
  }

  rl.close();

  const mins = ((Date.now() - startAt) / 60000);
  console.log(bold('\n===== 本次统计 ====='));
  console.log(`作答 ${answered} 题　跳过 ${skipped} 题　用时 ${mins.toFixed(1)} 分钟`);
  if (answered) {
    const rate = correct / answered * 100;
    const col = rate >= 70 ? green : rate >= 60 ? yellow : red;
    console.log(`正确 ${correct} 题　正确率 ${bold(col(rate.toFixed(1) + '%'))}`);
    console.log(dim(`折算 75 题卷面约 ${Math.round(rate / 100 * 75)} 分（45 分及格）`));
    if (rate >= 70) console.log(green('稳了，保持这个水平。'));
    else if (rate >= 60) console.log(yellow('刚过及格线，还有提升空间。'));
    else console.log(red('低于及格线，建议回教材对应章节再过一遍。'));
    console.log(`每题平均 ${(mins * 60 / answered).toFixed(0)} 秒` + dim('（考试节奏：75 题 75 分钟 = 60 秒/题）'));
  }
  if (wrongThisRound.length) console.log(`\n本次新增/累加错题 ${red(wrongThisRound.length)} 题，已记入 wrong.json`);
  console.log(`错题本现有 ${Object.keys(wrong.items).length} 题　` + dim('（node quiz.js --wrong 复习）'));

  if (answered) {
    wrong.history.push({ date: today(), mode: modeLabel, total: answered, correct, minutes: +mins.toFixed(1) });
    if (wrong.history.length > 300) wrong.history = wrong.history.slice(-300);
  }
  saveWrong(wrong);
}

// ---------- 交互菜单 ----------
async function menu(db, wrong, opt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsker(rl);

  const years = Array.from(new Set(db.questions.map(q => q.year))).sort();
  const wn = Object.keys(wrong.items).length;

  console.log(bold('\n===== 系统规划与管理师 · 综合知识刷题 ====='));
  console.log(`题库 ${bold(db.total)} 题　错题本 ${wn ? red(wn) : 0} 题\n`);
  console.log('  1) 按年份/卷别刷题');
  console.log('  2) 随机抽题');
  console.log(`  3) 只刷错题本${wn ? '' : dim('（空）')}`);
  console.log('  4) ' + yellow('限时模考') + '（75 题 / 75 分钟，真题+模拟卷）');
  console.log('  5) 查看统计');
  console.log('  6) 题库概况');
  console.log('  q) 退出\n');

  const selRaw = await ask('选择 > ');
  const sel = (selRaw === null ? 'q' : selRaw).trim();

  if (sel === '1') {
    years.forEach((y, i) => console.log(`  ${i + 1}) ${y}　${db.questions.filter(q => q.year === y).length} 题`));
    const yi = parseInt(((await ask('\n选择年份 > ')) || '').trim(), 10);
    rl.close();
    if (!years[yi - 1]) { console.log(red('无效选择')); return; }
    opt.mode = 'year'; opt.year = years[yi - 1];
    const list = pickQuestions(db, wrong, opt);
    if (list) await runQuiz(db, wrong, list, opt, '年份:' + opt.year);
  } else if (sel === '2') {
    const n = parseInt(((await ask('抽多少题（默认 20）> ')) || '').trim(), 10) || 20;
    rl.close();
    opt.mode = 'random'; opt.count = n;
    const list = pickQuestions(db, wrong, opt);
    if (list) await runQuiz(db, wrong, list, opt, '随机' + n + '题');
  } else if (sel === '3') {
    rl.close();
    opt.mode = 'wrong';
    const list = pickQuestions(db, wrong, opt);
    if (list) await runQuiz(db, wrong, list, opt, '错题本');
  } else if (sel === '4') {
    rl.close();
    opt.mode = 'exam'; opt.explain = false;
    const list = pickQuestions(db, wrong, opt);
    if (list) await runQuiz(db, wrong, list, opt, '限时模考');
  } else if (sel === '5') { rl.close(); cmdStats(db, wrong); }
  else if (sel === '6') { rl.close(); cmdList(db, wrong); }
  else { rl.close(); console.log(dim('再见。')); }
}

// ---------- 入口 ----------
(async () => {
  const opt = parseArgs(process.argv.slice(2));

  if (opt.mode === 'help') {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, ''));
    return;
  }

  const db = loadQuestions();
  const wrong = loadWrong();

  if (opt.mode === 'list') return cmdList(db, wrong);
  if (opt.mode === 'stats') return cmdStats(db, wrong);
  if (!opt.mode) return menu(db, wrong, opt);

  const list = pickQuestions(db, wrong, opt);
  if (!list) return;
  const filt = (opt.type ? opt.type : '') + (opt.chapter ? `第${opt.chapter}章` : '');
  const label = opt.mode === 'exam' ? '限时模考'
    : opt.mode === 'year' ? '年份:' + opt.year
    : opt.mode === 'random' ? (filt || '随机') + list.length + '题'
    : '错题本' + (filt ? '/' + filt : '');
  await runQuiz(db, wrong, list, opt, label);
})().catch(e => { console.error(red('出错: ' + e.message)); process.exit(1); });
