#!/usr/bin/env node
/**
 * 本地 ThingsBoard Mock —— 用于验证 client/tb.mjs 的完整读写流程
 * 行为对齐真实 ThingsBoard 3.x：
 *   POST /api/auth/login               {username,password} → {token,refreshToken}
 *   POST /api/auth/token               {refreshToken} → {token,refreshToken}
 *   GET  /api/user/devices             → {data:[...]}
 *   GET  /api/plugins/telemetry/DEVICE/:id/values/attributes/SHARED_SCOPE?keys=
 *   POST /api/plugins/telemetry/DEVICE/:id/SHARED_SCOPE
 *
 * 用法: node mock/tb_server.mjs --port 8099
 *       TB_BASE=http://127.0.0.1:8099 node client/tb.mjs login --user admin --pass 123456
 */
import http from 'node:http';
import crypto from 'node:crypto';

const USER = process.env.MOCK_USER || 'admin';
const PASS = process.env.MOCK_PASS || '123456';
const TTL = 7200;

const devices = [
  {
    id: { id: 'DEV-301-UUID', entityType: 'DEVICE' },
    name: 'JK2-301',
    label: '301',
    type: 'JK-2',
    createdTime: Date.now(),
  },
  {
    id: { id: 'DEV-302-UUID', entityType: 'DEVICE' },
    name: 'JK2-302',
    label: '302',
    type: 'JK-2',
    createdTime: Date.now(),
  },
];

const attrs = {
  'DEV-301-UUID': {
    ElectricControlSwitch: 'N',
    RoomStaticControlSwitch: 'Y',
    TimeControlSwitch: 'Y',
    TimerOneOn: '05:00',
    TimerOneOff: '23:00',
    Power: 0,
    Voltage: 220.5,
    Electric_Current: 0,
    Electric_Quantity: 12.4,
    KeepPower_State: 'N',
  },
  'DEV-302-UUID': {
    ElectricControlSwitch: 'Y',
    RoomStaticControlSwitch: 'Y',
    TimeControlSwitch: 'Y',
    TimerOneOn: '05:00',
    TimerOneOff: '23:00',
    Power: 85,
    Voltage: 221.1,
    Electric_Current: 0.39,
    Electric_Quantity: 30.2,
    KeepPower_State: 'Y',
  },
};

const tokens = new Map();
const refreshTokens = new Map();
const requests = [];

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}
const tbErr = (res, code, errorCode, message) =>
  json(res, code, { status: code, message, errorCode, timestamp: Date.now() });

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
  const t = tokens.get(m[1]);
  if (!t || t.exp < Date.now()) return null;
  return t;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/__state') return json(res, 200, { attrs, requests: requests.slice(-30) });
  if (p === '/__reset') {
    attrs['DEV-301-UUID'].ElectricControlSwitch = 'N';
    attrs['DEV-301-UUID'].RoomStaticControlSwitch = 'Y';
    attrs['DEV-301-UUID'].TimeControlSwitch = 'Y';
    requests.length = 0;
    return json(res, 200, { ok: true });
  }

  requests.push({ method: req.method, path: p + url.search });

  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.username !== USER || b.password !== PASS) {
      return tbErr(res, 401, 10, 'Invalid username or password');
    }
    const token = crypto.randomBytes(24).toString('hex');
    const refresh = crypto.randomBytes(24).toString('hex');
    tokens.set(token, { exp: Date.now() + TTL * 1000 });
    refreshTokens.set(refresh, { user: USER });
    return json(res, 200, { token, refreshToken: refresh });
  }

  if (p === '/api/auth/token' && req.method === 'POST') {
    const b = await readBody(req);
    if (!refreshTokens.has(b.refreshToken)) return tbErr(res, 401, 10, 'Invalid refresh token');
    const token = crypto.randomBytes(24).toString('hex');
    const refresh = crypto.randomBytes(24).toString('hex');
    tokens.set(token, { exp: Date.now() + TTL * 1000 });
    refreshTokens.set(refresh, { user: USER });
    return json(res, 200, { token, refreshToken: refresh });
  }

  const t = auth(req);
  if (!t) return tbErr(res, 401, 10, 'Authentication failed');

  if (p === '/api/user/devices' && req.method === 'GET') {
    return json(res, 200, { data: devices, totalPages: 1, totalElements: devices.length, hasNext: false });
  }
  if (p === '/api/tenant/devices' && req.method === 'GET') {
    return json(res, 200, { data: devices, totalPages: 1, totalElements: devices.length, hasNext: false });
  }

  const mGet = p.match(/^\/api\/plugins\/telemetry\/DEVICE\/([^/]+)\/values\/attributes\/SHARED_SCOPE$/);
  if (mGet && req.method === 'GET') {
    const id = decodeURIComponent(mGet[1]);
    const keys = (url.searchParams.get('keys') || '').split(',').filter(Boolean);
    const a = attrs[id] || {};
    const out = Object.entries(a)
      .filter(([k]) => !keys.length || keys.includes(k))
      .map(([key, value]) => ({ key, value, lastUpdateTs: Date.now() }));
    return json(res, 200, out);
  }

  const mPost = p.match(/^\/api\/plugins\/telemetry\/DEVICE\/([^/]+)\/SHARED_SCOPE$/);
  if (mPost && req.method === 'POST') {
    const id = decodeURIComponent(mPost[1]);
    if (!attrs[id]) return tbErr(res, 404, 30, 'Device not found');
    const b = await readBody(req);
    Object.assign(attrs[id], b);
    requests[requests.length - 1].wrote = b;
    return json(res, 200, {});
  }

  return tbErr(res, 404, 31, `No handler for ${p}`);
});

const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8099);
server.listen(port, '127.0.0.1', () => {
  console.log(`ThingsBoard Mock: http://127.0.0.1:${server.address().port}`);
  console.log(`账号 ${USER} / ${PASS}`);
  console.log('设备: JK2-301(301), JK2-302(302)');
});
