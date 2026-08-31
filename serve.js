#!/usr/bin/env node
'use strict';
/**
 * 系统规划与管理师 · 刷题网页版
 *
 * 本地：
 *   node serve.js                 启动后浏览器打开 http://127.0.0.1:3000
 *   node serve.js --port 8080
 *   node serve.js --no-open       不自动打开浏览器
 *
 * 服务器部署：
 *   QUIZ_TOKEN=你的口令 node serve.js --host 0.0.0.0 --port 3000
 *   --host / HOST 环境变量：监听地址（默认 127.0.0.1）
 *   --port / PORT 环境变量：端口
 *   --token / QUIZ_TOKEN：访问口令。对外监听但未设口令时会拒绝启动，
 *   因为错题本是可写的个人数据。口令通过请求头 X-Quiz-Token 校验，
 *   网页端首次输入后存入 localStorage。
 *
 * 与命令行版 quiz.js 共用同一份 questions.json 与 wrong.json，
 * 错题本互通（但不要同时开着两边刷，后写入的一方会覆盖前一方）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const Q_FILE = path.join(ROOT, 'questions.json');
const W_FILE = path.join(ROOT, 'wrong.json');
const WEB_DIR = path.join(ROOT, 'web');

const argv = process.argv.slice(2);
const argOf = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const PORT = parseInt(argOf('--port') || process.env.PORT || '', 10) || 3000;
const HOST = argOf('--host') || process.env.HOST || '127.0.0.1';
const TOKEN = argOf('--token') || process.env.QUIZ_TOKEN || '';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const AUTO_OPEN = !argv.includes('--no-open') && LOOPBACK;
const GRADUATE = parseInt(argOf('--graduate') || '', 10) || 2;

if (!LOOPBACK && !TOKEN) {
  console.error('监听 ' + HOST + ' 会把可写的错题本暴露到网络上。');
  console.error('请设置访问口令：QUIZ_TOKEN=你的口令 node serve.js --host ' + HOST);
  process.exit(1);
}

// ---------- 数据 ----------
if (!fs.existsSync(Q_FILE)) {
  console.error('找不到 questions.json，请先运行：node tools/extract-questions.js');
  process.exit(1);
}
const DB = JSON.parse(fs.readFileSync(Q_FILE, 'utf8'));
const BY_ID = new Map(DB.questions.map(q => [q.id, q]));

function loadWrong() {
  if (!fs.existsSync(W_FILE)) return { updated: null, items: {}, history: [] };
  try {
    const d = JSON.parse(fs.readFileSync(W_FILE, 'utf8'));
    d.items = d.items || {}; d.history = d.history || [];
    return d;
  } catch (e) {
    console.warn('wrong.json 损坏，已忽略并将重建');
    return { updated: null, items: {}, history: [] };
  }
}
function saveWrong(w) {
  w.updated = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const tmp = W_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(w, null, 1), 'utf8');
  fs.renameSync(tmp, W_FILE);   // 原子替换，避免半截文件
}
const today = () => new Date().toISOString().slice(0, 10);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- 出题 ----------
function buildList(o) {
  let pool = DB.questions;
  if (o.type) pool = pool.filter(q => q.type === o.type);
  if (o.chapter) pool = pool.filter(q => q.chapter === Number(o.chapter));
  if (o.year) pool = pool.filter(q => q.year === o.year);

  if (o.mode === 'exam') {
    const src = DB.questions.filter(q => q.type === '真题' || q.type === '模拟卷');
    return shuffle(src.slice()).slice(0, 75);
  }
  if (o.mode === 'wrong') {
    const w = loadWrong();
    const ids = new Set(Object.keys(w.items));
    const list = pool.filter(q => ids.has(q.id));
    list.sort((a, b) => (w.items[b.id].wrongCount || 0) - (w.items[a.id].wrongCount || 0));
    return o.order === 'random' ? shuffle(list) : list;
  }
  let list = pool.slice();
  if (o.order === 'seq') list.sort((a, b) => a.year.localeCompare(b.year, 'zh') || a.num - b.num);
  else shuffle(list);
  if (o.count > 0) list = list.slice(0, o.count);
  return list;
}

// ---------- 统计口径（与 quiz.js 保持一致） ----------
function summary() {
  const w = loadWrong();
  const byType = {}, byYear = {}, byChapter = {};
  for (const q of DB.questions) {
    byType[q.type || '未分类'] = (byType[q.type || '未分类'] || 0) + 1;
    byYear[q.year] = (byYear[q.year] || 0) + 1;
    if (q.chapter) byChapter[q.chapter] = (byChapter[q.chapter] || 0) + 1;
  }
  const all = w.history.reduce((s, h) => ({ t: s.t + h.total, c: s.c + h.correct }), { t: 0, c: 0 });
  return {
    total: DB.total, generated: DB.generated,
    byType, byYear, byChapter,
    wrongCount: Object.keys(w.items).length,
    history: w.history.slice(-40),
    lifetime: all,
    wrongItems: Object.entries(w.items)
      .map(([id, v]) => ({ id, ...v, stem: (BY_ID.get(id) || {}).stem || '', year: (BY_ID.get(id) || {}).year || '' }))
      .sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0)),
    graduate: GRADUATE,
  };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJSON(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 1e6) { req.destroy(); reject(new Error('请求体过大')); } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// 恒定时间比较，避免口令被逐字符试探
const crypto = require('crypto');
function tokenOK(req) {
  if (!TOKEN) return true;
  const got = String(req.headers['x-quiz-token'] || '');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = decodeURIComponent(url.pathname);

  try {
    // 静态页面不含题目数据，可匿名访问；所有 API 需要口令
    if (p.startsWith('/api/') && !tokenOK(req)) {
      return sendJSON(res, { error: 'unauthorized' }, 401);
    }

    if (p === '/api/summary') return sendJSON(res, summary());

    if (p === '/api/quiz' && req.method === 'POST') {
      const o = await readBody(req);
      const list = buildList(o);
      // 不把答案发给前端之外的地方；本地自用，直接连答案与解析一起下发
      return sendJSON(res, { list, mode: o.mode || 'practice' });
    }

    if (p === '/api/answer' && req.method === 'POST') {
      const { id, pick } = await readBody(req);
      const q = BY_ID.get(id);
      if (!q) return sendJSON(res, { error: '题目不存在' }, 404);
      const w = loadWrong();
      const correct = pick === q.answer;
      let graduated = false, streak = 0;
      const rec = w.items[id];
      if (correct) {
        if (rec) {
          rec.rightStreak = (rec.rightStreak || 0) + 1;
          streak = rec.rightStreak;
          if (rec.rightStreak >= GRADUATE) { delete w.items[id]; graduated = true; }
        }
      } else {
        const r = rec || { wrongCount: 0, rightStreak: 0, firstWrong: today() };
        r.wrongCount = (r.wrongCount || 0) + 1;
        r.rightStreak = 0;
        r.lastWrong = today();
        r.lastChoice = pick;
        w.items[id] = r;
      }
      saveWrong(w);
      return sendJSON(res, {
        correct, answer: q.answer, explanation: q.explanation || '',
        graduated, streak, graduate: GRADUATE,
        wrongCount: Object.keys(w.items).length,
      });
    }

    if (p === '/api/finish' && req.method === 'POST') {
      const { mode, total, correct, minutes } = await readBody(req);
      if (total > 0) {
        const w = loadWrong();
        w.history.push({ date: today(), mode: String(mode || '练习'), total, correct, minutes: +Number(minutes || 0).toFixed(1) });
        if (w.history.length > 300) w.history = w.history.slice(-300);
        saveWrong(w);
      }
      return sendJSON(res, { ok: true });
    }

    // 静态文件
    let file = p === '/' ? '/index.html' : p;
    const abs = path.join(WEB_DIR, file);
    if (!abs.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); return res.end('404'); }
    const buf = fs.readFileSync(abs);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    sendJSON(res, { error: e.message }, 500);
  }
});

function start(port, attempt = 0) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`端口 ${port} 被占用，改用 ${port + 1}`);
      start(port + 1, attempt + 1);
    } else { console.error('启动失败:', err.message); process.exit(1); }
  });
  server.listen(port, HOST, () => {
    const url = `http://${LOOPBACK ? '127.0.0.1' : HOST}:${port}`;
    console.log(`\n  系规刷题网页版已启动`);
    console.log(`  ${url}${TOKEN ? '　（已启用访问口令）' : ''}`);
    console.log(`  题库 ${DB.total} 题　错题本 ${Object.keys(loadWrong().items).length} 题`);
    console.log(`  按 Ctrl+C 停止\n`);
    if (AUTO_OPEN) {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      execFile(cmd[0], cmd[1], () => {});
    }
  });
}
start(PORT);
