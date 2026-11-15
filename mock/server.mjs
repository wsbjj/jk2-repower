#!/usr/bin/env node
/**
 * 本地 Mock 复电服务端 —— 用于在拿到真实凭证前，端到端验证 client/recover.mjs 的正确性。
 * 它会真实校验 sign / token / 幂等 / 二维码一次性，行为对齐典型校园用电平台。
 *
 * 用法: node mock/server.mjs [--port 8787]
 *       node client/recover.mjs --room 301 --dry-run   (需 config.mock.json)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = process.env.MOCK_SECRET || 'DORM9f2c';
const TOKEN_TTL = 3600;

const state = {
  // 房间 -> 是否通电
  rooms: new Map([
    ['301', false],
    ['302', true],
    ['303', false],
  ]),
  // 一次性二维码票据
  qrTickets: new Map(),
  // 使用过的二维码
  usedQr: new Set(),
  tokens: new Map(),
  requests: [],
};

function sortedParams(o) {
  // 与客户端对齐：ts/nonce 由模板单独注入，不参与 sortedParams
  return Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== null && !['sign', 'ts', 'nonce'].includes(k))
    .sort()
    .map((k) => `${k}=${o[k]}`)
    .join('&');
}

function expectSign(params, ts) {
  const raw = `${sortedParams(params)}&ts=${ts}&k=${SECRET}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

function auth(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return null;
  const t = state.tokens.get(m[1]);
  if (!t || t.exp < Date.now()) return null;
  return t;
}

function verifySign(req, params, ts) {
  const given = req.headers['x-sign'] || params.sign;
  if (!given || !ts) return { ok: false, reason: 'missing sign/ts' };
  const want = expectSign(params, ts);
  return { ok: given === want, want, given };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // 调试端点放在鉴权之前
  if (p === '/__requests') return json(res, 200, state.requests);
  if (p === '/__state') return json(res, 200, { rooms: Object.fromEntries(state.rooms), usedQr: [...state.usedQr] });
  if (p === '/__reset') {
    state.rooms.set('301', false); state.rooms.set('302', true); state.rooms.set('303', false);
    state.usedQr.clear(); state.qrTickets.clear(); state.requests.length = 0;
    return json(res, 200, { ok: true });
  }

  const entry = { ts: new Date().toISOString(), method: req.method, path: p + url.search, sign: req.headers['x-sign'] };
  state.requests.push(entry);

  // 登录：发 token
  if (p === '/api/dorm/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.code) return json(res, 400, { code: 400, msg: 'code required' });
    const token = crypto.randomBytes(24).toString('hex');
    state.tokens.set(token, { exp: Date.now() + TOKEN_TTL * 1000, code: body.code });
    return json(res, 200, { code: 0, msg: 'ok', data: { token, expiresIn: TOKEN_TTL, userId: 10086 } });
  }

  // 二维码签发（模拟扫码拿到的票据）
  if (p === '/api/dorm/qr/issue' && req.method === 'POST') {
    const body = await readBody(req);
    const room = String(body.roomNo || '301');
    const ticket = crypto.randomBytes(12).toString('hex');
    state.qrTickets.set(ticket, { room, exp: Date.now() + 120000 });
    return json(res, 200, { code: 0, data: { qrToken: ticket, roomNo: room } });
  }

  const t = auth(req);
  if (!t) return json(res, 401, { code: 401, msg: 'unauthorized' });

  // 房间状态
  if (p === '/api/dorm/room/info' && req.method === 'GET') {
    const room = url.searchParams.get('roomNo') || '301';
    const ts = url.searchParams.get('ts');
    const sig = verifySign(req, { roomNo: room }, ts);
    if (!sig.ok) return json(res, 200, { code: 403, msg: 'bad sign' });
    if (!state.rooms.has(room)) return json(res, 200, { code: 404, msg: 'room not found' });
    return json(res, 200, {
      code: 0, msg: 'ok',
      data: { roomNo: room, power: state.rooms.get(room), balance: 12.5, building: 'A栋' },
    });
  }

  // 复电
  if (p === '/api/dorm/power/recover' && req.method === 'POST') {
    const body = await readBody(req);
    const ts = body.ts || req.headers['x-timestamp'];
    const { qrToken, roomNo } = body;
    const room = String(roomNo || '301');

    const sig = verifySign(req, body, ts);
    if (!sig.ok) {
      entry.result = 'sign_fail';
      return json(res, 200, { code: 403, msg: '签名校验失败', expect: sig.want });
    }
    if (!state.rooms.has(room)) return json(res, 200, { code: 404, msg: '房间不存在' });

    // 二维码校验必须先于"已通电"短路：
    // 否则重复扫同一张码会被幂等逻辑吞掉，暴露不出一次性语义
    if (qrToken) {
      if (state.usedQr.has(qrToken)) {
        entry.result = 'qr_used';
        return json(res, 200, { code: 1002, msg: '二维码已使用，请重新扫码' });
      }
      const ticket = state.qrTickets.get(qrToken);
      if (ticket) {
        if (ticket.room !== room) return json(res, 200, { code: 1003, msg: '二维码与房间不匹配' });
        if (ticket.exp < Date.now()) return json(res, 200, { code: 1004, msg: '二维码已过期' });
      }
      state.usedQr.add(qrToken);
    }

    if (state.rooms.get(room)) {
      entry.result = 'already_on';
      return json(res, 200, { code: 0, msg: '已通电', data: { roomNo: room, power: true, idempotent: true } });
    }

    state.rooms.set(room, true);
    entry.result = 'recovered';
    return json(res, 200, {
      code: 0, msg: '复电成功',
      data: { roomNo: room, power: true, orderId: 'ORD' + Date.now(), at: new Date().toISOString() },
    });
  }

  if (p === '/__requests_old') return json(res, 200, state.requests);
  if (p === '/__state_old') return json(res, 200, { rooms: Object.fromEntries(state.rooms), usedQr: [...state.usedQr] });
  if (p === '/__reset_old') {
    state.rooms.set('301', false); state.rooms.set('302', true); state.rooms.set('303', false);
    state.usedQr.clear(); state.qrTickets.clear(); state.requests.length = 0;
    return json(res, 200, { ok: true });
  }

  json(res, 404, { code: 404, msg: 'not found' });
});

const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`Mock 用电平台: http://127.0.0.1:${server.address().port}`);
  console.log(`签名密钥 SECRET = ${SECRET}`);
  console.log('端点: POST /api/dorm/auth/login | GET /api/dorm/room/info | POST /api/dorm/power/recover');
  console.log('调试: GET /__state  /__requests  /__reset');
});
