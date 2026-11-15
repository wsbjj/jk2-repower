#!/usr/bin/env node
/**
 * wxapkg 解包器 —— 支持 Mac/PC 微信 4.x 的 V1MMWX 加密格式
 *
 * 三种形态：
 *   1) 明文包：首字节 0xBE
 *   2) V1MMWX 加密包（新版微信）：
 *        - 前 1024 字节：AES-256-CBC，key=PBKDF2(appid,"saltiest",1000,32,sha1)，iv="the iv: 16 bytes"
 *        - 1024 字节之后：逐字节 XOR，key = appid 的倒数第二个字符的 ASCII
 *        - 索引区反混淆：会随机插入 0x01 垃圾字节，需回溯/贪心解析
 *   3) 头部带垃圾偏移的包：自动搜索 0xBE 头
 *
 * 用法：
 *   node scripts/unpack.mjs <pkg-dir-or-file> <out-dir> [--appid wxXXXXXXXXXXXXXXXX]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AES_PREFIX = 1024;

function decryptV1MMWX(raw, appid) {
  if (!appid) throw new Error('加密包需要 --appid（就是包所在目录名，形如 wxXXXXXXXXXXXXXXXX）');
  const body = raw.subarray(6);
  const key = crypto.pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1');
  const iv = Buffer.from('the iv: 16 bytes', 'utf8');

  // 前 1024 字节 AES-CBC（无 padding）
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  d.setAutoPadding(false);
  const head = Buffer.concat([d.update(body.subarray(0, Math.min(AES_PREFIX, body.length))), d.final()]);

  if (!head.length || head[0] !== 0xbe) {
    throw new Error('AES 段解密后无 0xBE 魔数，appid 可能不对');
  }
  if (body.length <= AES_PREFIX) return head;

  // 其余字节 XOR
  const xorKey = appid.length >= 2 ? appid.charCodeAt(appid.length - 2) : 0x66;
  const tail = Buffer.from(body.subarray(AES_PREFIX).map((b) => b ^ xorKey));
  const out = Buffer.concat([head, tail]);

  if (out[0] !== 0xbe) throw new Error('解密结果无 0xBE 魔数');
  return out;
}

function findHeader(buf) {
  if (buf[0] === 0xbe) return 0;
  for (let i = 0; i < Math.min(buf.length - 20, 4096); i++) {
    if (buf[i] === 0xbe && buf[i + 13] === 0xed) return i;
  }
  return -1;
}

/** 反混淆索引解析：容忍随机插入的垃圾字节 */
function parseIndex(buf, idxStart, count, idxEnd) {
  const nameAt = (p) => {
    if (p + 12 > idxEnd) return null;
    const nl = buf.readUInt32BE(p);
    if (nl === 0 || nl > 400) return null;
    if (p + 12 + nl > idxEnd) return null;
    const first = buf[p + 4];
    // 真实微信包里是 '/' 开头；自造包可能无前导斜杠，两者都接受
    if (first !== 0x2f && !/[A-Za-z0-9_]/.test(String.fromCharCode(first))) return null;
    const name = buf.subarray(p + 4, p + 4 + nl).toString('utf8');
    if (!/^\/?[\x20-\x7e\u4e00-\u9fff]+$/.test(name)) return null;
    return {
      name,
      off: buf.readUInt32BE(p + 4 + nl),
      size: buf.readUInt32BE(p + 8 + nl),
      next: p + 12 + nl,
    };
  };

  // DP：判断从 p 开始能否正好解析 need 条
  const memo = new Map();
  const reach = (p, need) => {
    if (need === 0) return true;
    if (p > idxEnd) return false;
    const k = `${p},${need}`;
    if (memo.has(k)) return memo.get(k);
    memo.set(k, false);
    const r = nameAt(p);
    if (r && reach(r.next, need - 1)) { memo.set(k, true); return true; }
    if (reach(p + 1, need)) { memo.set(k, true); return true; }
    return false;
  };

  // 贪心收集（容忍垃圾）
  const ents = [];
  let p = idxStart, junk = 0;
  while (ents.length < count && p <= idxEnd) {
    const r = nameAt(p);
    if (r) { ents.push(r); p = r.next; }
    else { p++; junk++; }
  }

  // 若数量不足，用 DP 找最大可解析数（兜底）
  if (ents.length < count) {
    for (let n = ents.length; n >= 1; n--) {
      memo.clear();
      if (reach(idxStart, n)) break;
    }
  }
  return { ents, junk };
}

function parsePkg(raw, appid) {
  let buf = raw;

  if (buf.subarray(0, 6).toString('latin1') === 'V1MMWX') {
    buf = decryptV1MMWX(buf, appid);
  } else {
    const h = findHeader(buf);
    if (h < 0) throw new Error('找不到 wxapkg 头（0xBE ... 0xED）');
    buf = buf.subarray(h);
  }

  const idxLen = buf.readUInt32BE(5);
  const bodyLen = buf.readUInt32BE(9);
  const count = buf.readUInt32BE(14);
  const idxEnd = 18 + idxLen;

  const { ents, junk } = parseIndex(buf, 18, count, idxEnd);

  const base = idxEnd;
  for (const e of ents) {
    const end = base + e.off + e.size;
    e.data = end <= buf.length ? buf.subarray(base + e.off, end) : Buffer.alloc(0);
  }

  return { ents, buf, base, idxLen, bodyLen, count, junk };
}

function safeJoin(root, name) {
  const clean = name.replace(/^\/+/, '').replace(/\.\./g, '_');
  const full = path.resolve(path.join(root, clean));
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) {
    throw new Error('路径穿越: ' + name);
  }
  return full;
}

function unpackFile(file, outDir, appid) {
  const raw = fs.readFileSync(file);
  const r = parsePkg(raw, appid);
  let n = 0, bytes = 0;
  for (const e of r.ents) {
    if (!e.name || !e.data.length) continue;
    const dest = safeJoin(outDir, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
    n++; bytes += e.data.length;
  }
  const tag = raw.subarray(0, 6).toString('latin1') === 'V1MMWX' ? 'encrypted' : 'plain';
  console.log(`  ${path.basename(file)} [${tag}] → ${n}/${r.count} 个文件, ${(bytes / 1024) | 0}KB` +
    (r.junk ? ` (跳过索引垃圾 ${r.junk}B)` : '') +
    (n < r.count ? ` ⚠ ${r.count - n} 条缺失` : ''));
  return n;
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const appidIdx = args.indexOf('--appid');
let appid = appidIdx >= 0 ? args[appidIdx + 1] : '';
const src = positional[0] || 'pkg';
const dst = positional[1] || 'unpacked';

fs.mkdirSync(dst, { recursive: true });
let files = [];
if (fs.existsSync(src) && fs.statSync(src).isFile()) {
  files = [src];
  // 单个文件且没给 appid：尝试用父目录名推断
  if (!appid) {
    const guess = path.basename(path.dirname(path.dirname(src)));
    if (/^wx[0-9a-f]{16}$/.test(guess)) appid = guess;
  }
} else if (fs.existsSync(src)) {
  // 递归找
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.wxapkg')) files.push(p);
    }
  };
  walk(src);
}
if (!files.length) {
  console.error(`没有找到 .wxapkg：${src}`);
  process.exit(1);
}

let total = 0;
for (const f of files) {
  // 每个包用自己所在目录的 appid
  let a = appid;
  const seg = f.split(path.sep);
  for (const s of seg) if (/^wx[0-9a-f]{16}$/.test(s)) a = s;
  try { total += unpackFile(f, dst, a); }
  catch (err) { console.error(`  ${path.basename(f)} 失败: ${err.message}`); }
}
console.log(`\n解包完成，共 ${total} 个文件 → ${dst}`);
console.log('关键目标: app-service.js / appservice.app.js / app-config.json');
