'use strict';
/**
 * 纯 Node 实现的 PDF 文本提取器（无第三方依赖）
 * 支持：FlateDecode 流、对象流(ObjStm)、Type0/Identity-H 双字节 CID 字体、
 *       ToUnicode CMap（bfchar / bfrange）、按 Y 坐标还原换行
 * 不支持：加密 PDF、扫描图片型 PDF（无文字层）、CCITT/JBIG2 图像 OCR
 */
const zlib = require('zlib');

const WS = new Set([0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isWS = c => WS.has(c);
const isDelim = c => DELIM.has(c);
const isReg = c => !isWS(c) && !isDelim(c);

class Ref {
  constructor(num) { this.num = num; }
}

class Lexer {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }

  skipWS() {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWS(c)) this.pos++;
      else if (c === 0x25) { while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++; }
      else break;
    }
  }

  readName() {
    const b = this.buf;
    this.pos++; // 跳过 '/'
    let s = '';
    while (this.pos < b.length && isReg(b[this.pos])) {
      let c = b[this.pos];
      if (c === 0x23 && this.pos + 2 < b.length) {
        const hex = String.fromCharCode(b[this.pos + 1], b[this.pos + 2]);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { s += String.fromCharCode(parseInt(hex, 16)); this.pos += 3; continue; }
      }
      s += String.fromCharCode(c);
      this.pos++;
    }
    return '/' + s;
  }

  readLiteralString() {
    const b = this.buf;
    this.pos++; // '('
    const out = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c) { // 反斜杠转义
        const n = b[this.pos++];
        switch (n) {
          case 0x6e: out.push(10); break;
          case 0x72: out.push(13); break;
          case 0x74: out.push(9); break;
          case 0x62: out.push(8); break;
          case 0x66: out.push(12); break;
          case 0x0a: break;
          case 0x0d: if (b[this.pos] === 0x0a) this.pos++; break;
          default:
            if (n >= 0x30 && n <= 0x37) { // 八进制
              let oct = String.fromCharCode(n);
              for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) oct += String.fromCharCode(b[this.pos++]);
              out.push(parseInt(oct, 8) & 0xff);
            } else out.push(n);
        }
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return Buffer.from(out);
  }

  readHexString() {
    const b = this.buf;
    this.pos++; // '<'
    let hex = '';
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++];
      if (/[0-9a-fA-F]/.test(String.fromCharCode(c))) hex += String.fromCharCode(c);
    }
    this.pos++; // '>'
    if (hex.length % 2) hex += '0';
    return Buffer.from(hex, 'hex');
  }

  parse() {
    this.skipWS();
    const b = this.buf;
    if (this.pos >= b.length) return undefined;
    const c = b[this.pos];

    if (c === 0x2f) return this.readName();
    if (c === 0x28) return this.readLiteralString();
    if (c === 0x5b) { // 数组
      this.pos++;
      const arr = [];
      for (;;) {
        this.skipWS();
        if (this.pos >= b.length) break;
        if (b[this.pos] === 0x5d) { this.pos++; break; }
        const v = this.parse();
        if (v === undefined) break;
        arr.push(v);
      }
      return arr;
    }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) { // 字典
        this.pos += 2;
        const d = Object.create(null);
        for (;;) {
          this.skipWS();
          if (this.pos >= b.length) break;
          if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) { this.pos += 2; break; }
          if (b[this.pos] !== 0x2f) { this.pos++; continue; }
          const key = this.readName();
          const val = this.parse();
          d[key] = val;
        }
        return d;
      }
      return this.readHexString();
    }
    if (c === 0x5d || c === 0x3e || c === 0x29) { this.pos++; return undefined; }

    // 数字 / 引用 / 关键字
    let start = this.pos;
    while (this.pos < b.length && isReg(b[this.pos])) this.pos++;
    const tok = b.slice(start, this.pos).toString('latin1');
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^[+-]?\d+$/.test(tok)) {
      // 尝试识别 "num gen R"
      const save = this.pos;
      this.skipWS();
      const s2 = this.pos;
      while (this.pos < b.length && isReg(b[this.pos])) this.pos++;
      const t2 = b.slice(s2, this.pos).toString('latin1');
      if (/^\d+$/.test(t2)) {
        const save2 = this.pos;
        this.skipWS();
        const s3 = this.pos;
        while (this.pos < b.length && isReg(b[this.pos])) this.pos++;
        const t3 = b.slice(s3, this.pos).toString('latin1');
        if (t3 === 'R') return new Ref(parseInt(tok, 10));
        this.pos = save2;
      }
      this.pos = save;
      return parseInt(tok, 10);
    }
    if (/^[+-]?(\d*\.\d*|\d+)$/.test(tok)) return parseFloat(tok);
    if (tok === '') { this.pos++; return undefined; }
    return { op: tok };
  }
}

class PDFDoc {
  constructor(buf) {
    this.buf = buf;
    this.offsets = new Map();   // objNum -> byte offset
    this.cache = new Map();
    this.inObjStm = new Map();  // objNum -> {stm, idx}
    this.warnings = [];
    this._scan();
    this._scanObjStms();
  }

  /** 暴力扫描 "N G obj"，比解析 xref 更抗损坏 */
  _scan() {
    const s = this.buf.toString('latin1');
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      this.offsets.set(parseInt(m[1], 10), m.index + m[0].length);
    }
  }

  _raw(objNum) {
    if (!this.offsets.has(objNum)) return undefined;
    const lex = new Lexer(this.buf, this.offsets.get(objNum));
    const val = lex.parse();
    // 检查后面是否跟着 stream
    lex.skipWS();
    const tail = this.buf.slice(lex.pos, lex.pos + 6).toString('latin1');
    if (tail.startsWith('stream')) {
      let p = lex.pos + 6;
      if (this.buf[p] === 0x0d) p++;
      if (this.buf[p] === 0x0a) p++;
      let len = this.resolve(val['/Length']);
      let end;
      if (typeof len === 'number' && len > 0 && p + len <= this.buf.length) {
        end = p + len;
        const after = this.buf.slice(end, end + 20).toString('latin1');
        if (!/^\s*endstream/.test(after)) end = undefined;
      }
      if (end === undefined) {
        const idx = this.buf.indexOf('endstream', p, 'latin1');
        end = idx < 0 ? this.buf.length : idx;
      }
      return { dict: val, raw: this.buf.slice(p, end) };
    }
    return val;
  }

  get(objNum) {
    if (this.cache.has(objNum)) return this.cache.get(objNum);
    let v = this._raw(objNum);
    if (v === undefined && this.inObjStm.has(objNum)) v = this._fromObjStm(objNum);
    this.cache.set(objNum, v);
    return v;
  }

  resolve(v) {
    let guard = 0;
    while (v instanceof Ref && guard++ < 32) v = this.get(v.num);
    return v;
  }

  /** 解码流数据 */
  streamData(obj) {
    obj = this.resolve(obj);
    if (!obj || !obj.raw) return null;
    let data = obj.raw;
    let filters = this.resolve(obj.dict['/Filter']);
    if (!filters) return data;
    if (typeof filters === 'string') filters = [filters];
    let parmsArr = this.resolve(obj.dict['/DecodeParms']) || obj.dict['/DP'];
    if (parmsArr && !Array.isArray(parmsArr)) parmsArr = [parmsArr];
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      try {
        if (f === '/FlateDecode' || f === '/Fl') data = zlib.inflateSync(data);
        else if (f === '/LZWDecode' || f === '/ASCIIHexDecode' || f === '/ASCII85Decode' ||
                 f === '/DCTDecode' || f === '/JPXDecode' || f === '/CCITTFaxDecode' || f === '/JBIG2Decode') return null;
      } catch (e) {
        // 尝试跳过可能损坏的首字节
        let ok = false;
        for (let skip = 1; skip <= 2 && !ok; skip++) {
          try { data = zlib.inflateSync(data.slice(skip)); ok = true; } catch (e2) {}
        }
        if (!ok) { try { data = zlib.inflateRawSync(data); } catch (e3) { return null; } }
      }
      const parms = this.resolve(parmsArr && parmsArr[i]);
      if (parms && this.resolve(parms['/Predictor']) >= 2) data = applyPredictor(data, this, parms);
    }
    return data;
  }

  /** 展开对象流 (PDF 1.5+ 压缩对象) */
  _scanObjStms() {
    for (const num of Array.from(this.offsets.keys())) {
      let o;
      try { o = this._raw(num); } catch (e) { continue; }
      if (!o || !o.dict || this.resolve(o.dict['/Type']) !== '/ObjStm') continue;
      const data = this.streamData(o);
      if (!data) continue;
      const n = this.resolve(o.dict['/N']), first = this.resolve(o.dict['/First']);
      const header = data.slice(0, first).toString('latin1').trim().split(/\s+/).map(Number);
      for (let i = 0; i < n; i++) {
        const objNum = header[i * 2], off = header[i * 2 + 1];
        if (!this.offsets.has(objNum)) this.inObjStm.set(objNum, { data, start: first + off });
      }
    }
  }

  _fromObjStm(objNum) {
    const e = this.inObjStm.get(objNum);
    if (!e) return undefined;
    return new Lexer(e.data, e.start).parse();
  }

  /** 按页面树顺序返回页面（含继承的 Resources / MediaBox） */
  pages() {
    const out = [];
    let root = null;
    for (const num of this.offsets.keys()) {
      const o = this.get(num);
      if (o && !o.raw && this.resolve(o['/Type']) === '/Catalog') { root = o; break; }
    }
    if (!root) for (const num of this.inObjStm.keys()) {
      const o = this.get(num);
      if (o && !o.raw && this.resolve(o['/Type']) === '/Catalog') { root = o; break; }
    }

    const walk = (nodeRef, inherited, depth, seen) => {
      if (depth > 64) return;
      const node = this.resolve(nodeRef);
      if (!node || node.raw) return;
      const key = nodeRef instanceof Ref ? nodeRef.num : null;
      if (key !== null) { if (seen.has(key)) return; seen.add(key); }
      const inh = Object.assign({}, inherited);
      for (const k of ['/Resources', '/MediaBox', '/CropBox', '/Rotate']) if (node[k] !== undefined) inh[k] = node[k];
      const type = this.resolve(node['/Type']);
      if (type === '/Page' || (!node['/Kids'] && node['/Contents'])) {
        out.push(Object.assign({}, inh, node));
        return;
      }
      const kids = this.resolve(node['/Kids']);
      if (Array.isArray(kids)) for (const k of kids) walk(k, inh, depth + 1, seen);
    };

    if (root && root['/Pages']) walk(root['/Pages'], {}, 0, new Set());

    if (!out.length) { // 兜底：暴力找 /Type /Page，按对象号排序
      this.warnings.push('未能通过页面树定位页面，改用对象号顺序（页序可能不准）');
      const nums = Array.from(new Set([...this.offsets.keys(), ...this.inObjStm.keys()])).sort((a, b) => a - b);
      for (const num of nums) {
        const o = this.get(num);
        if (o && !o.raw && this.resolve(o['/Type']) === '/Page') out.push(o);
      }
    }
    return out;
  }

  /** 解析字体的 ToUnicode CMap，返回 {map, fallback, twoByte} */
  fontInfo(fontObj) {
    const f = this.resolve(fontObj);
    if (!f) return { map: null, fallback: null, twoByte: false };
    const subtype = this.resolve(f['/Subtype']);
    let twoByte = subtype === '/Type0';
    const map = new Map();

    const tu = this.resolve(f['/ToUnicode']);
    if (tu && tu.raw) {
      const data = this.streamData(tu);
      if (data) parseCMap(data.toString('latin1'), map);
    }
    // Type0 用 CMap 编码判断字节数
    const enc = this.resolve(f['/Encoding']);
    if (typeof enc === 'string' && /Identity/.test(enc)) twoByte = true;

    // 【已停用的兜底方案】曾尝试：CIDFontType2 + CIDToGIDMap=/Identity 时，
    // 反查内嵌 TrueType 的 cmap 表来补全 ToUnicode 缺失的字符。
    // 实测在 Word 生成的 ABCDEE+ 子集字体上会给出**错误但看起来合理**的字
    // （例：题号 "53" 被还原成 "缃"）——子集化重排了字形编号，内嵌 cmap 已失效。
    // 交叉校验也挡不住全部误报。这种错误比缺失危险得多，故彻底停用：
    // 宁可输出 �，由 extract-questions.js 丢弃该题并列入人工清单。
    // parseTrueTypeCmap() 保留在文件末尾，供将来有可靠校验手段时再启用。
    return { map, fallback: null, twoByte, subtype };
  }

  /** 提取一页的文字 */
  pageText(page) {
    let contents = this.resolve(page['/Contents']);
    const parts = [];
    if (Array.isArray(contents)) {
      for (const c of contents) { const d = this.streamData(c); if (d) parts.push(d); }
    } else if (contents && contents.raw) {
      const d = this.streamData(contents);
      if (d) parts.push(d);
    }
    if (!parts.length) return '';
    const content = Buffer.concat(parts.map((p, i) => i ? Buffer.concat([Buffer.from('\n'), p]) : p));

    const res = this.resolve(page['/Resources']) || {};
    const fontsDict = this.resolve(res['/Font']) || {};
    const fontCache = new Map();
    const getFont = name => {
      if (!fontCache.has(name)) fontCache.set(name, this.fontInfo(fontsDict[name]));
      return fontCache.get(name);
    };

    return runContentStream(content, getFont);
  }

  text() {
    const pages = this.pages();
    return pages.map((p, i) => {
      try { return this.pageText(p); } catch (e) { this.warnings.push(`第 ${i + 1} 页解析失败: ${e.message}`); return ''; }
    });
  }
}

function applyPredictor(data, doc, parms) {
  const pred = doc.resolve(parms['/Predictor']) || 1;
  if (pred < 10) return data;
  const colors = doc.resolve(parms['/Colors']) || 1;
  const bpc = doc.resolve(parms['/BitsPerComponent']) || 8;
  const columns = doc.resolve(parms['/Columns']) || 1;
  const bpp = Math.ceil(colors * bpc / 8);
  const rowLen = Math.ceil(colors * bpc * columns / 8);
  const out = [];
  let prev = Buffer.alloc(rowLen);
  for (let i = 0; i + 1 + rowLen <= data.length + rowLen; i += rowLen + 1) {
    if (i >= data.length) break;
    const ft = data[i];
    const row = Buffer.from(data.slice(i + 1, i + 1 + rowLen));
    for (let j = 0; j < row.length; j++) {
      const a = j >= bpp ? row[j - bpp] : 0, b = prev[j] || 0, c = j >= bpp ? (prev[j - bpp] || 0) : 0;
      switch (ft) {
        case 1: row[j] = (row[j] + a) & 0xff; break;
        case 2: row[j] = (row[j] + b) & 0xff; break;
        case 3: row[j] = (row[j] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          row[j] = (row[j] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff; break;
        }
      }
    }
    out.push(row); prev = row;
  }
  return Buffer.concat(out);
}

/**
 * 解析内嵌 TrueType 的 cmap 表，返回 Map<gid, unicode码点>
 * 支持 format 0 / 4 / 6 / 12，选择最优子表（3,10 > 3,1 > 0,x > 3,0 > 1,0）
 */
function parseTrueTypeCmap(buf) {
  if (buf.length < 12) return null;
  const numTables = buf.readUInt16BE(4);
  let cmapOff = -1;
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    if (off + 16 > buf.length) break;
    if (buf.slice(off, off + 4).toString('latin1') === 'cmap') { cmapOff = buf.readUInt32BE(off + 8); break; }
  }
  if (cmapOff < 0 || cmapOff + 4 > buf.length) return null;

  const n = buf.readUInt16BE(cmapOff + 2);
  let best = -1, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    if (rec + 8 > buf.length) break;
    const pid = buf.readUInt16BE(rec), eid = buf.readUInt16BE(rec + 2), off = buf.readUInt32BE(rec + 4);
    let score = -1;
    if (pid === 3 && eid === 10) score = 5;
    else if (pid === 3 && eid === 1) score = 4;
    else if (pid === 0) score = 3;
    else if (pid === 3 && eid === 0) score = 2;
    else if (pid === 1 && eid === 0) score = 1;
    if (score > bestScore) { bestScore = score; best = cmapOff + off; }
  }
  if (best < 0 || best + 4 > buf.length) return null;

  const map = new Map();                       // gid -> 码点
  const put = (gid, cp) => { if (gid && !map.has(gid)) map.set(gid, cp); };
  const fmt = buf.readUInt16BE(best);

  if (fmt === 4) {
    const segX2 = buf.readUInt16BE(best + 6), seg = segX2 / 2;
    const endO = best + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    if (rangeO + segX2 > buf.length) return null;
    for (let s = 0; s < seg; s++) {
      const end = buf.readUInt16BE(endO + s * 2), start = buf.readUInt16BE(startO + s * 2);
      const delta = buf.readInt16BE(deltaO + s * 2), ro = buf.readUInt16BE(rangeO + s * 2);
      if (start === 0xFFFF) continue;
      for (let c = start; c <= end && c <= 0xFFFF; c++) {
        let gid;
        if (ro === 0) gid = (c + delta) & 0xFFFF;
        else {
          const gi = rangeO + s * 2 + ro + (c - start) * 2;
          if (gi + 2 > buf.length) continue;
          gid = buf.readUInt16BE(gi);
          if (gid) gid = (gid + delta) & 0xFFFF;
        }
        put(gid, c);
      }
    }
  } else if (fmt === 12) {
    if (best + 16 > buf.length) return null;
    const nGroups = buf.readUInt32BE(best + 12);
    for (let g = 0; g < nGroups; g++) {
      const o = best + 16 + g * 12;
      if (o + 12 > buf.length) break;
      const sc = buf.readUInt32BE(o), ec = buf.readUInt32BE(o + 4), sg = buf.readUInt32BE(o + 8);
      for (let c = sc; c <= ec && c - sc < 0x10000; c++) put(sg + (c - sc), c);
    }
  } else if (fmt === 6) {
    const first = buf.readUInt16BE(best + 6), cnt = buf.readUInt16BE(best + 8);
    for (let i = 0; i < cnt; i++) {
      const o = best + 10 + i * 2;
      if (o + 2 > buf.length) break;
      put(buf.readUInt16BE(o), first + i);
    }
  } else if (fmt === 0) {
    for (let c = 0; c < 256; c++) { const o = best + 6 + c; if (o < buf.length) put(buf[o], c); }
  } else return null;

  return map;
}

function hexToStr(h) {
  // CMap 的 UTF-16BE 码点
  let s = '';
  for (let i = 0; i + 3 < h.length + 1; i += 4) {
    const cu = parseInt(h.substr(i, 4), 16);
    if (!isNaN(cu)) s += String.fromCharCode(cu);
  }
  return s;
}

function parseCMap(txt, map) {
  // bfchar: <src> <dst>
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfcharRe.exec(txt)) !== null) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let p;
    while ((p = pairRe.exec(m[1])) !== null) map.set(parseInt(p[1], 16), hexToStr(p[2]));
  }
  // bfrange: <lo> <hi> <dst> 或 <lo> <hi> [<d1> <d2> ...]
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrangeRe.exec(txt)) !== null) {
    const body = m[1];
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g;
    let r;
    while ((r = re.exec(body)) !== null) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
      if (r[3] !== undefined) {
        const base = r[3];
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          if (base.length <= 4) map.set(c, String.fromCharCode(parseInt(base, 16) + (c - lo)));
          else { // 多码元：只递增最后一个码元
            const units = base.match(/.{1,4}/g).map(x => parseInt(x, 16));
            units[units.length - 1] += (c - lo);
            map.set(c, units.map(u => String.fromCharCode(u)).join(''));
          }
        }
      } else {
        const items = r[4].match(/<([0-9A-Fa-f]*)>/g) || [];
        items.forEach((it, i) => map.set(lo + i, hexToStr(it.replace(/[<>]/g, ''))));
      }
    }
  }
}

/** 执行内容流，还原带换行的文字 */
function runContentStream(content, getFont) {
  const lex = new Lexer(content, 0);
  const stack = [];
  let font = { map: null, twoByte: false };
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm.slice();
  let ctm = [1, 0, 0, 1, 0, 0];
  const gsStack = [];
  let leading = 0, fontSize = 1;
  const chunks = [];   // {x, y, s}

  const mul = (a, b) => [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];

  const decode = buf => {
    let s = '';
    if (font.twoByte) {
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const code = (buf[i] << 8) | buf[i + 1];
        if (font.map && font.map.has(code)) s += font.map.get(code);
        else if (font.fallback && font.fallback.has(code)) s += font.fallback.get(code);
        else s += '�';
      }
      if (buf.length % 2) s += '�';
    } else {
      for (let i = 0; i < buf.length; i++) {
        const code = buf[i];
        if (font.map && font.map.has(code)) s += font.map.get(code);
        else s += String.fromCharCode(code);
      }
    }
    return s;
  };

  const emit = s => {
    if (!s) return;
    const trm = mul(tm, ctm);   // 文本矩阵 × 当前变换矩阵 = 设备坐标
    chunks.push({ x: trm[4], y: trm[5], s });
    // 粗略推进 x（不做精确度量，仅用于间隙判断）
    tm = tm.slice(); tm[4] += s.length * fontSize * 0.5;
  };

  for (;;) {
    const v = lex.parse();
    if (v === undefined && lex.pos >= content.length) break;
    if (v === undefined) { lex.pos++; continue; }
    if (v && v.op) {
      const op = v.op;
      switch (op) {
        case 'q': gsStack.push(ctm.slice()); break;
        case 'Q': ctm = gsStack.pop() || [1, 0, 0, 1, 0, 0]; break;
        case 'cm': {
          const f = Number(stack.pop()), e = Number(stack.pop()), d = Number(stack.pop()),
                c = Number(stack.pop()), b = Number(stack.pop()), a = Number(stack.pop());
          if ([a, b, c, d, e, f].every(n => Number.isFinite(n))) ctm = mul([a, b, c, d, e, f], ctm);
          break;
        }
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
        case 'ET': break;
        case 'Tf': {
          fontSize = Number(stack[stack.length - 1]) || 1;
          const fname = stack[stack.length - 2];
          if (typeof fname === 'string' && fname[0] === '/') font = getFont(fname) || font;
          break;
        }
        case 'TL': leading = Number(stack[stack.length - 1]) || 0; break;
        case 'Td': {
          const ty = Number(stack.pop()), tx = Number(stack.pop());
          tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); break;
        }
        case 'TD': {
          const ty = Number(stack.pop()), tx = Number(stack.pop());
          leading = -ty;
          tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); break;
        }
        case 'Tm': {
          const f = Number(stack.pop()), e = Number(stack.pop()), d = Number(stack.pop()),
                c = Number(stack.pop()), b = Number(stack.pop()), a = Number(stack.pop());
          tlm = [a, b, c, d, e, f]; tm = tlm.slice(); break;
        }
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); break;
        case 'Tj': case '\'': case '"': {
          if (op !== 'Tj') { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); }
          const s = stack[stack.length - 1];
          if (Buffer.isBuffer(s)) emit(decode(s));
          break;
        }
        case 'TJ': {
          const arr = stack[stack.length - 1];
          if (Array.isArray(arr)) {
            let acc = '';
            for (const it of arr) {
              if (Buffer.isBuffer(it)) acc += decode(it);
              else if (typeof it === 'number' && it < -180) acc += ' ';
            }
            emit(acc);
          }
          break;
        }
        default: break;
      }
      stack.length = 0;
    } else {
      stack.push(v);
      if (stack.length > 64) stack.shift();
    }
  }

  // 按 y 降序、x 升序排序后还原行
  chunks.sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
  let out = '', lastY = null;
  for (const c of chunks) {
    if (lastY !== null && Math.abs(c.y - lastY) > 2) out += '\n';
    out += c.s;
    lastY = c.y;
  }
  return out;
}

function extract(filePathOrBuffer) {
  const buf = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : require('fs').readFileSync(filePathOrBuffer);
  if (buf.slice(0, 4).toString('latin1') !== '%PDF') throw new Error('不是 PDF 文件');
  if (/\/Encrypt\b/.test(buf.slice(-3000).toString('latin1'))) {
    // 只是提示，仍尝试解析
  }
  const doc = new PDFDoc(buf);
  const pages = doc.text();
  return { pages, warnings: doc.warnings, doc };
}

module.exports = { extract, PDFDoc, Lexer, Ref };

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error('用法: node pdftext.js <file.pdf> [起始页] [结束页]'); process.exit(1); }
  const r = extract(f);
  const a = parseInt(process.argv[3] || '1', 10), b = parseInt(process.argv[4] || String(r.pages.length), 10);
  console.log(`# 共 ${r.pages.length} 页`);
  r.warnings.forEach(w => console.log('# 警告: ' + w));
  for (let i = a - 1; i < Math.min(b, r.pages.length); i++) {
    console.log(`\n===== 第 ${i + 1} 页 =====`);
    console.log(r.pages[i]);
  }
}
