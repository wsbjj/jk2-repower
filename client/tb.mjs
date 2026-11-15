#!/usr/bin/env node
/**
 * 用电监控 —— ThingsBoard 直连客户端
 *
 * 通过分析小程序「用电监控扫码」，确认其云端是 ThingsBoard：
 *   https://thingsboard.example.com:8080
 *
 * 关键发现：设备的通断由「共享属性」控制，不需要蓝牙、不需要扫码。
 *
 *   POST /api/plugins/telemetry/DEVICE/{deviceId}/SHARED_SCOPE
 *   {
 *     "ElectricControlSwitch":     "Y",   // 电控总开关
 *     "RoomStaticControlSwitch":   "Y",   // 房间静态断电控制
 *     "TimeControlSwitch":         "Y",   // 定时控制开关
 *     "TimerOneOn":                "05:00",
 *     "TimerOneOff":               "23:00"
 *   }
 *
 * 用法：
 *   node client/tb.mjs login --user 账号 --pass 密码
 *   node client/tb.mjs devices                    # 列出名下设备
 *   node client/tb.mjs status  --device 301       # 读当前状态
 *   node client/tb.mjs on      --device 301       # 复电
 *   node client/tb.mjs off     --device 301       # 断电
 *   node client/tb.mjs forever --device 301       # 关掉所有自动断电（推荐）
 *   node client/tb.mjs timer   --device 301 --on 06:00 --off 23:00
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRIVATE = path.resolve(process.env.PRIVATE_DIR || path.join(ROOT, 'private'));
const STATE = path.join(PRIVATE, 'state', '.tb-state.json');
const LOG = path.join(PRIVATE, 'logs', 'tb.log');

const BASE = process.env.TB_BASE || process.env.JK2_BASE || 'https://thingsboard.example.com:8080';

const ATTR_KEYS = [
  'TimerOneOn', 'TimerOneOff',
  'ElectricControlSwitch', 'RoomStaticControlSwitch', 'TimeControlSwitch',
  'KeepPower_State', 'Power', 'Voltage', 'Electric_Current', 'Electric_Quantity',
];

function log(...a) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

async function req(method, urlPath, { token, body, query } = {}) {
  const url = new URL(BASE + urlPath);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const headers = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text }; }
  if (!res.ok && res.status !== 401) {
    log(`  ! ${method} ${urlPath} → ${res.status}`, JSON.stringify(json).slice(0, 200));
  }
  return { status: res.status, json, ok: res.ok };
}

async function login(user, pass) {
  const r = await req('POST', '/api/auth/login', { body: { username: user, password: pass } });
  if (!r.ok || !r.json?.token) {
    throw new Error(`登录失败: ${r.status} ${JSON.stringify(r.json)}`);
  }
  const st = loadState();
  st.token = r.json.token;
  st.refreshToken = r.json.refreshToken;
  st.user = user;
  st.expiresAt = Date.now() + 2 * 3600 * 1000;
  saveState(st);
  log(`登录成功，用户 ${user}`);
  return st.token;
}

/** 拿有效 token：优先缓存，401 时用 refreshToken 或重新登录 */
async function ensureToken() {
  const st = loadState();
  if (st.token && st.expiresAt && Date.now() < st.expiresAt - 60000) return st.token;
  if (st.refreshToken) {
    const r = await req('POST', '/api/auth/token', { body: { refreshToken: st.refreshToken } });
    if (r.ok && r.json?.token) {
      st.token = r.json.token;
      st.refreshToken = r.json.refreshToken || st.refreshToken;
      st.expiresAt = Date.now() + 2 * 3600 * 1000;
      saveState(st);
      return st.token;
    }
  }
  if (st.user && process.env.TB_PASS) return login(st.user, process.env.TB_PASS);
  throw new Error('无有效登录态，先执行: node client/tb.mjs login --user X --pass Y');
}

async function listDevices(token) {
  // 普通用户看自己名下；租户管理员看全部
  for (const p of ['/api/user/devices?pageSize=200&page=0', '/api/tenant/devices?pageSize=200&page=0']) {
    const r = await req('GET', p, { token });
    if (r.ok && r.json?.data) return r.json.data;
  }
  return [];
}

function matchDevice(devices, name) {
  if (!name) return devices[0];
  const n = String(name).toLowerCase();
  return devices.find((d) =>
    String(d.name || '').toLowerCase() === n ||
    String(d.label || '').toLowerCase() === n ||
    String(d.name || '').toLowerCase().includes(n) ||
    String(d.label || '').toLowerCase().includes(n)
  );
}

async function readAttrs(token, deviceId) {
  const r = await req('GET', `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SHARED_SCOPE`, {
    token,
    query: { keys: ATTR_KEYS.join(',') },
  });
  if (!r.ok) return {};
  const out = {};
  for (const item of r.json || []) out[item.key] = item.value;
  return out;
}

async function writeAttrs(token, deviceId, attrs) {
  return req('POST', `/api/plugins/telemetry/DEVICE/${deviceId}/SHARED_SCOPE`, {
    token,
    body: attrs,
  });
}

async function resolveDevice(token, name) {
  const devices = await listDevices(token);
  if (!devices.length) throw new Error('名下没有设备，检查账号权限');
  const d = matchDevice(devices, name);
  if (!d) {
    log('可用设备:', devices.map((x) => `${x.name}(${x.label || ''})`).join(', '));
    throw new Error(`找不到设备: ${name}`);
  }
  return d;
}

const isOn = (v) => v === 'Y' || v === 'y' || v === true || v === 1 || v === '1' || v === 'true';
const label = (v) => (isOn(v) ? '开' : '关');

async function cmdLogin(argv) {
  const user = argv[argv.indexOf('--user') + 1];
  const pass = argv[argv.indexOf('--pass') + 1];
  if (!user || !pass) throw new Error('用法: login --user 账号 --pass 密码');
  await login(user, pass);
  const devs = await listDevices(loadState().token);
  log(`名下设备 ${devs.length} 个:`);
  for (const d of devs) log(`  ${d.name}  label=${d.label || '-'}  id=${d.id?.id || d.id}`);
}

async function cmdDevices() {
  const token = await ensureToken();
  const devs = await listDevices(token);
  console.log(`共 ${devs.length} 个设备:`);
  for (const d of devs) {
    console.log(`  ${String(d.name).padEnd(20)} label=${String(d.label || '-').padEnd(12)} id=${d.id?.id || d.id}`);
  }
}

async function cmdStatus(argv) {
  const token = await ensureToken();
  const dev = await resolveDevice(token, argv[argv.indexOf('--device') + 1]);
  const a = await readAttrs(token, dev.id.id);
  console.log(`\n设备 ${dev.name} (${dev.label || ''})`);
  console.log('─'.repeat(46));
  console.log(`  电控开关 ElectricControlSwitch    ${label(a.ElectricControlSwitch)}  (${a.ElectricControlSwitch ?? '-'})`);
  console.log(`  静态断电 RoomStaticControlSwitch  ${label(a.RoomStaticControlSwitch)}  (${a.RoomStaticControlSwitch ?? '-'})`);
  console.log(`  定时控制 TimeControlSwitch        ${label(a.TimeControlSwitch)}  (${a.TimeControlSwitch ?? '-'})`);
  console.log(`  供电时段 ${a.TimerOneOn || '-'} ~ ${a.TimerOneOff || '-'}`);
  if (a.Power !== undefined) console.log(`  实时功率 ${a.Power} W   电压 ${a.Voltage ?? '-'} V   电流 ${a.Electric_Current ?? '-'} A`);
  if (a.Electric_Quantity !== undefined) console.log(`  累计电量 ${a.Electric_Quantity} kWh`);
  return { dev, attrs: a };
}

async function cmdOn(argv) {
  const token = await ensureToken();
  const dev = await resolveDevice(token, argv[argv.indexOf('--device') + 1]);
  const r = await writeAttrs(token, dev.id.id, { ElectricControlSwitch: 'Y' });
  log(r.ok ? `已发送复电指令 → ${dev.name}` : `复电失败 ${r.status}`);
  if (!r.ok) process.exit(2);
  await new Promise((s) => setTimeout(s, 1500));
  const a = await readAttrs(token, dev.id.id);
  log(`当前 ElectricControlSwitch = ${a.ElectricControlSwitch}`);
}

async function cmdOff(argv) {
  const token = await ensureToken();
  const dev = await resolveDevice(token, argv[argv.indexOf('--device') + 1]);
  const r = await writeAttrs(token, dev.id.id, { ElectricControlSwitch: 'N' });
  log(r.ok ? `已发送断电指令 → ${dev.name}` : `断电失败 ${r.status}`);
}

/** 最关键的一条：把所有自动断电机制关掉，从此不用再复电 */
async function cmdForever(argv) {
  const token = await ensureToken();
  const dev = await resolveDevice(token, argv[argv.indexOf('--device') + 1]);
  const before = await readAttrs(token, dev.id.id);
  log('修改前:', JSON.stringify({
    ElectricControlSwitch: before.ElectricControlSwitch,
    RoomStaticControlSwitch: before.RoomStaticControlSwitch,
    TimeControlSwitch: before.TimeControlSwitch,
  }));
  const r = await writeAttrs(token, dev.id.id, {
    ElectricControlSwitch: 'Y',
    RoomStaticControlSwitch: 'N',   // 关闭静态断电
    TimeControlSwitch: 'N',         // 关闭定时断电
  });
  if (!r.ok) { log(`失败 ${r.status}`, JSON.stringify(r.json).slice(0, 200)); process.exit(2); }
  log('已关闭自动断电机制');
  await new Promise((s) => setTimeout(s, 1500));
  const after = await readAttrs(token, dev.id.id);
  log('修改后:', JSON.stringify({
    ElectricControlSwitch: after.ElectricControlSwitch,
    RoomStaticControlSwitch: after.RoomStaticControlSwitch,
    TimeControlSwitch: after.TimeControlSwitch,
  }));
  log('提示：若读回仍是 Y，说明服务端策略强制覆盖，只能走定时复电。');
}

async function cmdTimer(argv) {
  const token = await ensureToken();
  const dev = await resolveDevice(token, argv[argv.indexOf('--device') + 1]);
  const on = argv[argv.indexOf('--on') + 1];
  const off = argv[argv.indexOf('--off') + 1];
  if (!/^\d{1,2}:\d{2}$/.test(on) || !/^\d{1,2}:\d{2}$/.test(off)) {
    throw new Error('用法: timer --device 301 --on 06:00 --off 23:00');
  }
  const r = await writeAttrs(token, dev.id.id, {
    TimerOneOn: on, TimerOneOff: off, TimeControlSwitch: 'Y',
  });
  log(r.ok ? `定时已设为 ${on} ~ ${off}` : `设置失败 ${r.status}`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const table = {
  login: cmdLogin, devices: cmdDevices, status: cmdStatus,
  on: cmdOn, off: cmdOff, forever: cmdForever, timer: cmdTimer,
};
if (!table[cmd]) {
  console.log(`用电监控 ThingsBoard 客户端

  node client/tb.mjs login   --user 账号 --pass 密码
  node client/tb.mjs devices
  node client/tb.mjs status  --device 301
  node client/tb.mjs on      --device 301      # 复电
  node client/tb.mjs off     --device 301      # 断电
  node client/tb.mjs forever --device 301      # 关闭所有自动断电（一劳永逸）
  node client/tb.mjs timer   --device 301 --on 06:00 --off 23:00

  服务器: ${BASE}   （TB_BASE 环境变量可覆盖）`);
  process.exit(argv.length ? 1 : 0);
}

table[cmd](argv).catch((e) => {
  log('错误:', e.message);
  process.exit(1);
});
