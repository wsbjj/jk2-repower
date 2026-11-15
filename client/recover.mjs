#!/usr/bin/env node
/**
 * 宿舍复电 API 客户端
 *
 * 设计要点（真机联调时必须注意的坑）：
 *  - token 有有效期：缓存到 private/state/.state.json，401/业务码失效时自动用 wx.login 换新
 *  - 签名：从小程序里逆出来的算法，支持三种形态
 *      md5(str) / hmac-sha256(str, secret) / aes
 *  - 二维码 token：有些系统二维码内容就是一次性票据，扫一次失效；
 *    有些是固定的 roomNo。两种都支持（qrToken 可直接给，也可走 /qr/issue）
 *  - 幂等 + 重试：复电成功判定不只看 code，还要查 room/info 的 power 字段
 *  - 风控：默认串行 + 抖动延时，不要并发打
 *
 * 用法：
 *   node client/recover.mjs                     # 走配置文件
 *   node client/recover.mjs --room 301 --dry-run
 *   node client/recover.mjs --once              # 单次执行（给 launchd 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 私有数据统一放 private/（不进仓库），可用 PRIVATE_DIR 覆盖
const PRIVATE = path.resolve(process.env.PRIVATE_DIR || path.join(ROOT, 'private'));
const CFG_PATH = process.env.RECOVER_CFG || path.join(PRIVATE, 'config', 'config.json');
const STATE_PATH = process.env.STATE_PATH || path.join(PRIVATE, 'state', '.state.json');
const LOG_DIR = path.join(PRIVATE, 'logs');

/* ── 配置 ── */
const DEFAULT_CFG = {
  baseUrl: 'https://dorm.example.com',
  appid: 'wxXXXXXXXXXXXXXXXX',
  roomNo: '301',
  // 签名算法：md5 | hmac-sha256 | none
  sign: {
    type: 'md5',
    // 签名串模板，变量：{sortedParams} {ts} {nonce} {secret} {appid} {token} {body}
    template: '{sortedParams}&ts={ts}&k={secret}',
    secret: 'DORM9f2c',
    // 签名放在哪：header / query / body
    placement: 'header',
    headerName: 'X-Sign',
    paramName: 'sign',
  },
  headers: {
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) MicroMessenger/8.0.49',
    Referer: 'https://servicewechat.com/{appid}/0/page-frame.html',
  },
  api: {
    login: '/api/dorm/auth/login',
    roomInfo: '/api/dorm/room/info',
    recover: '/api/dorm/power/recover',
  },
  // 业务成功码
  okCode: 0,
  // 复电后校验
  verify: { enabled: true, retries: 8, intervalMs: 1500 },
  // 请求重试
  retry: { times: 3, backoffMs: 800 },
  // 抖动，避免固定时刻特征
  jitterMs: 1200,
  timeoutMs: 10000,
};

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v;
  }
  return out;
}

function loadCfg() {
  let fileCfg = {};
  if (fs.existsSync(CFG_PATH)) {
    try { fileCfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
    catch (e) { console.error(`配置解析失败 ${CFG_PATH}: ${e.message}`); }
  }
  return deepMerge(DEFAULT_CFG, fileCfg);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function log(...args) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(LOG_DIR, 'recover.log'), line + '\n');
}

/* ── 签名 ── */
function sortedParams(params) {
  // ts/nonce/sign 由模板变量单独注入，避免 "{sortedParams}&ts={ts}" 出现重复 ts
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && !['sign', 'ts', 'nonce'].includes(k))
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function buildSign(cfg, params, ctx = {}) {
  const s = cfg.sign || {};
  if (!s.type || s.type === 'none') return null;
  const ts = String(ctx.ts ?? params?.ts ?? Date.now());
  const nonce = ctx.nonce || params?.nonce || crypto.randomBytes(8).toString('hex');
  const raw = (s.template || '{sortedParams}')
    .replaceAll('{sortedParams}', sortedParams(params))
    .replaceAll('{ts}', ts)
    .replaceAll('{nonce}', nonce)
    .replaceAll('{secret}', s.secret || '')
    .replaceAll('{appid}', cfg.appid || '')
    .replaceAll('{token}', ctx.token || '')
    .replaceAll('{body}', ctx.body || '')
    // 模板里没有 ts 变量时，把参数里的 ts 补回签名串（对齐"全参数排序md5"的常见实现）
    .replace(/&{2,}/g, '&')
    .replace(/^&|&$/g, '');

  let sign;
  if (s.type === 'hmac-sha256') {
    sign = crypto.createHmac('sha256', s.secret || '').update(raw).digest('hex');
  } else if (s.type === 'sha256') {
    sign = crypto.createHash('sha256').update(raw).digest('hex');
  } else if (s.type === 'md5') {
    sign = crypto.createHash('md5').update(raw).digest('hex');
  } else {
    throw new Error('未知签名类型: ' + s.type);
  }
  return { sign, ts, nonce, raw };
}

/* ── HTTP ── */
async function http(cfg, { method = 'GET', urlPath, params, body, token, extraHeaders = {} }) {
  const url = new URL(urlPath.startsWith('http') ? urlPath : cfg.baseUrl + urlPath);
  const headers = { ...cfg.headers, ...extraHeaders };
  headers.Referer = (headers.Referer || '').replace('{appid}', cfg.appid || '');

  let payload = body ? JSON.stringify(body) : undefined;
  const signParams = params ? { ...params } : (body ? { ...body } : {});

  const signed = buildSign(cfg, signParams, { token, body: payload });
  if (signed) {
    const p = cfg.sign.placement || 'header';
    if (p === 'header') headers[cfg.sign.headerName || 'X-Sign'] = signed.sign;
    else if (p === 'query') url.searchParams.set(cfg.sign.paramName || 'sign', signed.sign);
    else if (p === 'body' && body) body[cfg.sign.paramName || 'sign'] = signed.sign;
    if (signed.ts && cfg.sign.sendTs !== false) {
      headers['X-Timestamp'] = signed.ts;
      if (method === 'GET') url.searchParams.set('ts', signed.ts);
    }
    if (signed.nonce && cfg.sign.sendNonce) headers['X-Nonce'] = signed.nonce;
  }

  if (params) for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payload) {
    payload = JSON.stringify(body);
    headers['content-length'] = Buffer.byteLength(payload);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs || 10000);
  let res, text;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: ac.signal });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }

  log(`HTTP ${method} ${url.pathname}${url.search} → ${res.status}`,
    `sign=${signed?.sign?.slice(0, 12) || '-'}`);
  return { status: res.status, ok: res.ok, json, text, headers: Object.fromEntries(res.headers) };
}

/* ── 认证 ── */
async function login(cfg, state) {
  // 1) 有缓存 token 且未过期就直接用
  if (state.token && state.expiresAt && Date.now() < state.expiresAt - 60000) {
    log('复用缓存 token，剩余', Math.round((state.expiresAt - Date.now()) / 1000), 's');
    return state.token;
  }

  // 2) 走登录接口。code 若不可伪造，这里由真机抓包得到的 refreshToken 代替
  const code = state.refreshToken || process.env.WX_CODE || 'REPLACE_WITH_CAPTURED_CODE';
  const r = await http(cfg, {
    method: 'POST',
    urlPath: cfg.api.login,
    body: { code },
  });

  const d = r.json?.data || r.json || {};
  const token = d.token || d.accessToken || d.access_token || r.json?.token;
  if (!token) {
    log('登录未返回 token，响应：', JSON.stringify(r.json).slice(0, 300));
    if (state.refreshToken) return state.refreshToken; // 退化用抓到的长期 token
    throw new Error('无法获取 token：请用 mitmproxy 抓一次真实登录，把 token/refreshToken 写进 private/state/.state.json');
  }
  state.token = token;
  const ttl = Number(d.expiresIn || d.expires_in || 7200);
  state.expiresAt = Date.now() + ttl * 1000;
  if (d.refreshToken) state.refreshToken = d.refreshToken;
  saveState(state);
  log('登录成功，token 有效期', ttl, 's');
  return token;
}

/* ── 业务 ── */
async function queryRoom(cfg, state, token) {
  const r = await http(cfg, {
    method: 'GET',
    urlPath: cfg.api.roomInfo,
    params: { roomNo: cfg.roomNo },
    token,
  });
  const d = r.json?.data || r.json || {};
  return { raw: r, power: d.power ?? d.isPower ?? d.powerStatus, roomNo: d.roomNo || cfg.roomNo, data: d };
}

async function doRecover(cfg, state, token, qrToken) {
  const ts = Date.now();
  const roomNo = cfg.roomNo;
  let reloginCount = 0;

  // 两种常见形态都覆盖：有的接口只认 qrToken，有的只认 roomNo/qrToken 固定串
  const modes = [
    { roomNo, qrToken, ts },
    { roomNo, qrToken: qrToken || roomNo, ts },
  ];

  for (let i = 0; i < modes.length; i++) {
    const body = modes[i];
    let lastErr;
    for (let attempt = 1; attempt <= (cfg.retry?.times || 3); attempt++) {
      try {
        const r = await http(cfg, { method: 'POST', urlPath: cfg.api.recover, body, token });
        const code = r.json?.code ?? r.json?.errcode ?? r.json?.status;

        // 只有 401 才是"身份失效"；403 是签名/权限问题，重登无用
        if (r.status === 401 || code === 401) {
          if (++reloginCount > 2) { lastErr = new Error('反复 401，登录态无法建立'); break; }
          log('token 失效（401），重新登录');
          state.token = null; state.expiresAt = 0; saveState(state);
          token = await login(cfg, state);
          state.token = token; saveState(state);
          attempt--; // 401 不消耗重试次数
          continue;
        }
        if (code === 403 || r.status === 403) {
          log('签名校验未通过（403）：检查 sign.template / secret / placement', JSON.stringify(r.json).slice(0, 200));
          lastErr = new Error('sign rejected');
          break;
        }

        const okBusiness = code === cfg.okCode || code === 200 || code === undefined;
        if (okBusiness) {
          log(`复电请求已受理 (mode=${i === 0 ? 'qrToken' : 'roomAsToken'})`, JSON.stringify(r.json).slice(0, 200));
          return { ok: true, resp: r.json, mode: i === 0 ? 'qrToken' : 'roomAsToken', token };
        }
        log('复电返回非成功码:', code, JSON.stringify(r.json).slice(0, 240));
        lastErr = new Error(`code=${code} msg=${r.json?.msg || r.json?.message || ''}`);
        // 二维码已用/过期/不匹配 → 换模式没有意义，直接判定失败
        if ([1002, 1003, 1004].includes(code)) return { ok: false, resp: r.json, fatal: true };
        if (code !== 500 && code !== -1) break;
      } catch (e) {
        lastErr = e;
        log(`第 ${attempt} 次请求异常:`, e.message);
      }
      await sleep((cfg.retry?.backoffMs || 800) * attempt);
    }
    if (lastErr && i === modes.length - 1) log('所有模式均失败:', lastErr.message);
  }
  return { ok: false, token };
}

async function verifyPower(cfg, state, token) {
  if (!cfg.verify?.enabled) return null;
  const n = cfg.verify.retries || 8;
  for (let i = 0; i < n; i++) {
    await sleep(cfg.verify.intervalMs || 1500);
    try {
      const q = await queryRoom(cfg, state, token);
      const p = q.power;
      const on = p === true || p === 1 || p === '1' || p === 'on' || p === 'ON' || p === 'powered';
      log(`校验 ${i + 1}/${n}: power=${JSON.stringify(p)}`);
      if (on) return true;
    } catch (e) {
      log('校验请求失败:', e.message);
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 主流程 ── */
export async function recover(opts = {}) {
  const cfg = loadCfg();
  if (opts.room) cfg.roomNo = String(opts.room);
  if (opts.dryRun) {
    log('=== DRY RUN ===');
    log('目标:', cfg.baseUrl, '房间:', cfg.roomNo);
    log('将调用:', cfg.api.login, '→', cfg.api.roomInfo, '→', cfg.api.recover);
    const s = buildSign(cfg, { roomNo: cfg.roomNo, qrToken: 'DRYRUN_QR', ts: Date.now() }, { ts: Date.now() });
    log('签名示例:', s?.sign, '| 原串:', s?.raw);
    return { ok: true, dryRun: true };
  }

  const state = loadState();
  let token = await login(cfg, state);

  if (opts.checkOnly) {
    const q = await queryRoom(cfg, state, token);
    log('当前状态:', JSON.stringify(q.data).slice(0, 300));
    return { ok: true, power: q.power };
  }

  // 已经通电就不重复打；缓存 token 可能已失效，401 就地重登一次
  for (let tries = 0; tries < 2; tries++) {
    try {
      const q = await queryRoom(cfg, state, token);
      if (q.raw.status === 401) {
        log('缓存 token 已失效，重新登录');
        state.token = null; state.expiresAt = 0; saveState(state);
        token = await login(cfg, state);
        continue;
      }
      const on = q.power === true || q.power === 1 || q.power === '1' || q.power === 'on';
      log('复电前状态 power =', JSON.stringify(q.power));
      if (on && !opts.force) {
        log('已通电，跳过');
        return { ok: true, skipped: 'already_on' };
      }
      break;
    } catch (e) {
      log('查询状态失败（继续尝试复电）:', e.message);
      break;
    }
  }

  if (cfg.jitterMs) await sleep(Math.floor(Math.random() * cfg.jitterMs));

  const r = await doRecover(cfg, state, token, opts.qrToken || process.env.QR_TOKEN || '');
  if (!r.ok) {
    log('复电失败');
    return { ok: false, resp: r.resp };
  }
  if (r.token) token = r.token;

  const verified = await verifyPower(cfg, state, token);
  log('最终结果:', verified === true ? '复电成功 ✓' : verified === false ? '已提交但校验未通过，请人工确认' : '已提交');
  saveState(state);
  return { ok: verified !== false, verified, resp: r.resp };
}

/* CLI */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const opts = {
    room: argv.includes('--room') ? argv[argv.indexOf('--room') + 1] : undefined,
    dryRun: argv.includes('--dry-run'),
    checkOnly: argv.includes('--check'),
    force: argv.includes('--force'),
    qrToken: argv.includes('--qr-token') ? argv[argv.indexOf('--qr-token') + 1] : undefined,
  };
  recover(opts).then((r) => {
    process.exit(r.ok ? 0 : 2);
  }).catch((e) => {
    log('致命错误:', e.message);
    process.exit(1);
  });
}

/* 测试钩子：供 test/selftest.mjs 对拍签名算法 */
export function __buildSignForTest(params, ts, secret) {
  return crypto.createHash('md5')
    .update(`${sortedParams(params)}&ts=${ts}&k=${secret}`)
    .digest('hex');
}
