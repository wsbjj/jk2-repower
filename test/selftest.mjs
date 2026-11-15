#!/usr/bin/env node
/**
 * 全链路自测 —— 断言 mock 服务端与客户端行为一致
 *
 * 用法: node test/selftest.mjs
 * 覆盖：
 *   1) wxapkg 打包/解包/加密包解密
 *   2) 沙箱分析能抓到复电接口 + 签名值
 *   3) 签名算法与服务端对拍
 *   4) 端到端复电（未通电→成功→已通电幂等）
 *   5) 签名错误被拒
 *   6) 二维码一次性 / 归属校验
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jk2-selftest-'));
const PRIVATE = path.join(TEST_DIR, 'private');
let BASE;
let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { results.push(`\n【${t}】`); }
async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: opts.headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t }; }
  return { status: r.status, json: j };
}

async function main() {
  // ── 1. 解包 ──
  section('wxapkg 解包');
  const pkg = path.join(PRIVATE, 'samples', '__APP__.wxapkg');
  fs.mkdirSync(path.dirname(pkg), { recursive: true });
  execFileSync('node', [path.join(ROOT, 'scripts/make_test_pkg.mjs'), pkg], { cwd: ROOT });
  ok('生成测试包', fs.existsSync(pkg));
  const tmpOut = path.join(TEST_DIR, 'out');
  fs.rmSync(tmpOut, { recursive: true, force: true });
  execFileSync('node', [path.join(ROOT, 'scripts/unpack.mjs'), pkg, tmpOut], { cwd: ROOT });
  const svc = path.join(tmpOut, 'app-service.js');
  ok('解出 app-service.js', fs.existsSync(svc), svc);
  const txt = fs.readFileSync(svc, 'utf8');
  ok('含复电接口路径', txt.includes('/api/dorm/power/recover'));

  // 加密包（V1MMWX）往返
  const appid = 'wxTESTAPPID0000001';
  const raw = fs.readFileSync(pkg);
  const key = crypto.pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1');
  const iv = Buffer.from('the iv: 16 bytes', 'utf8');
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  c.setAutoPadding(false);
  const pad = 16 - (raw.length % 16);
  const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
  const enc = Buffer.concat([Buffer.from('V1MMWX'), c.update(padded), c.final()]);
  const encPath = path.join(PRIVATE, 'samples', '__APP__.enc.wxapkg');
  fs.writeFileSync(encPath, enc);
  const decOut = path.join(TEST_DIR, 'out-enc');
  fs.rmSync(decOut, { recursive: true, force: true });
  try {
    execFileSync('node', [path.join(ROOT, 'scripts/unpack.mjs'), encPath, decOut, '--appid', appid], { cwd: ROOT, stdio: 'pipe' });
    ok('加密包解密+解包', fs.existsSync(path.join(decOut, 'app-service.js')));
  } catch (e) {
    ok('加密包解密+解包', false, String(e.message).slice(0, 120));
  }

  // ── 2. 沙箱分析 ──
  section('沙箱接口提取');
  const analysisPath = path.join(tmpOut, 'analysis.json');
  execFileSync('node', [path.join(ROOT, 'scripts/analyze.mjs'), svc], { cwd: ROOT, stdio: 'pipe' });
  ok('生成 analysis.json', fs.existsSync(analysisPath));
  const an = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
  ok('抓到 baseUrl', an.baseUrls.some((u) => u.includes('dorm')), JSON.stringify(an.baseUrls));
  const calls = an.calls || [];
  ok('抓到登录请求', calls.some((c) => /login/.test(c.url)));
  const recCall = calls.find((c) => /recover/.test(c.url));
  ok('抓到复电请求', !!recCall);
  ok('抓到签名头 X-Sign', !!recCall?.header?.['X-Sign'], JSON.stringify(recCall?.header));
  ok('签名值形似 md5(32hex)', /^[a-f0-9]{32}$/.test(recCall?.header?.['X-Sign'] || ''));
  ok('抓到 qrToken 参数', JSON.stringify(recCall?.data || '').includes('qrToken'));
  ok('识别签名相关标识', an.signCandidates.length > 0, JSON.stringify(an.signCandidates.slice(0, 5)));

  // ── 3. 签名对拍 ──
  section('签名算法对拍');
  const SECRET = 'DORM9f2c';
  const ts = String(Date.now());
  const params = { roomNo: '301', qrToken: 'abc' };
  const rawStr = `qrToken=abc&roomNo=301&ts=${ts}&k=${SECRET}`;
  const want = crypto.createHash('md5').update(rawStr).digest('hex');
  const { buildSignTest } = await import(path.join(ROOT, 'client/recover.mjs')).then((m) => ({ buildSignTest: m.__buildSignForTest }));
  ok('客户端签名 = 期望值', typeof buildSignTest === 'function' && buildSignTest(params, ts, SECRET) === want,
    buildSignTest ? '' : '未导出测试钩子');

  // ── 4. 端到端 ──
  section('端到端复电（mock 服务端）');
  const env = { ...process.env, PRIVATE_DIR: PRIVATE, RECOVER_CFG: path.join(PRIVATE, 'config', '.test-config.json'), STATE_PATH: path.join(PRIVATE, 'state', '.state.json') };
  fs.mkdirSync(path.dirname(env.RECOVER_CFG), { recursive: true });
  fs.writeFileSync(env.RECOVER_CFG, JSON.stringify({
    baseUrl: BASE, appid, roomNo: '301',
    sign: { type: 'md5', template: '{sortedParams}&ts={ts}&k={secret}', secret: SECRET, placement: 'header', headerName: 'X-Sign', sendTs: true },
    api: { login: '/api/dorm/auth/login', roomInfo: '/api/dorm/room/info', recover: '/api/dorm/power/recover' },
    okCode: 0, verify: { enabled: true, retries: 3, intervalMs: 200 },
    retry: { times: 2, backoffMs: 100 }, jitterMs: 0, timeoutMs: 5000,
  }));

  const statePath = path.join(PRIVATE, 'state', '.state.json');
  fs.rmSync(statePath, { force: true });

  const runClient = (args = []) => new Promise((resolve) => {
    const p = spawn('node', [path.join(ROOT, 'client/recover.mjs'), ...args], { cwd: ROOT, env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

  let st = (await api('/__state')).json;
  ok('初始 301 断电', st.rooms['301'] === false);

  const r1 = await runClient(['--room', '301']);
  ok('首次复电成功退出码 0', r1.code === 0, r1.out.slice(-200));
  st = (await api('/__state')).json;
  ok('服务端 301 已通电', st.rooms['301'] === true);
  ok('日志含"复电成功"', /复电成功/.test(r1.out));

  const r2 = await runClient(['--room', '301']);
  ok('二次执行幂等跳过', r2.code === 0 && /已通电|跳过/.test(r2.out), r2.out.slice(-160));

  // ── 5. 签名错误 ──
  section('错误签名应被拒');
  const ts2 = String(Date.now());
  const badSign = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const login = await api('/api/dorm/auth/login', { method: 'POST', body: { code: 'x' } });
  const token = login.json?.data?.token;
  ok('拿到 token', !!token);
  const bad = await api('/api/dorm/power/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-sign': badSign },
    body: { roomNo: '303', qrToken: 'q1', ts: Number(ts2) },
  });
  ok('签名错误返回 403 业务码', bad.json.code === 403, JSON.stringify(bad.json));

  // 正确签名打 303（断电）
  const ts3 = String(Date.now());
  const p3 = { roomNo: '303', qrToken: 'q303', ts: Number(ts3) };
  const sorted3 = Object.keys(p3).filter((k) => !['ts', 'nonce', 'sign'].includes(k)).sort().map((k) => `${k}=${p3[k]}`).join('&');
  const s3 = crypto.createHash('md5').update(`${sorted3}&ts=${ts3}&k=${SECRET}`).digest('hex');
  const good = await api('/api/dorm/power/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-sign': s3 },
    body: p3,
  });
  ok('正确签名复电 303 成功', good.json.code === 0, JSON.stringify(good.json));

  // ── 6. 二维码一次性 ──
  section('二维码一次性校验');
  const issue = await api('/api/dorm/qr/issue', { method: 'POST', body: { roomNo: '303' } });
  const qt = issue.json?.data?.qrToken;
  ok('签发二维码', !!qt);
  st = (await api('/__state')).json;
  // 303 现在已通电，先重置
  await api('/__reset');

  const payloadA = { roomNo: '303', qrToken: qt, ts: Date.now() };
  const sA = crypto.createHash('md5').update(
    `${Object.keys(payloadA).filter((k) => !['ts', 'nonce', 'sign'].includes(k)).sort().map((k) => `${k}=${payloadA[k]}`).join('&')}&ts=${payloadA.ts}&k=${SECRET}`
  ).digest('hex');
  const first = await api('/api/dorm/power/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-sign': sA },
    body: payloadA,
  });
  ok('首次使用二维码成功', first.json.code === 0, JSON.stringify(first.json));

  // 注意：不能 __reset（会清空 usedQr），否则测不出一性
  const second = await api('/api/dorm/power/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-sign': sA },
    body: payloadA,
  });
  ok('重复使用同一二维码被拒 (code 1002)', second.json.code === 1002, JSON.stringify(second.json));

  // ── 7. dry-run 不产生请求 ──
  section('dry-run 安全');
  const before = (await api('/__requests')).json.length;
  const dry = await runClient(['--room', '301', '--dry-run']);
  const after = (await api('/__requests')).json.length;
  ok('dry-run 未发出请求', before === after, `${before} vs ${after}`);
  ok('dry-run 打印签名示例', /签名示例/.test(dry.out));

  // 清理
  fs.rmSync(tmpOut, { recursive: true, force: true });
  fs.rmSync(decOut, { recursive: true, force: true });
  fs.rmSync(env.RECOVER_CFG, { force: true });
  fs.rmSync(encPath, { force: true });
}

const server = spawn('node', [path.join(ROOT, 'mock/server.mjs'), '--port', '0'], { cwd: ROOT });
try {
  BASE = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('mock 服务启动超时')), 5000);
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`mock 服务提前退出: ${code}`)));
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Mock 用电平台: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  await main();
} catch (e) {
  fail++;
  results.push(`\n  ✗ 测试崩溃: ${e.message}\n${e.stack?.split('\n').slice(0, 4).join('\n')}`);
} finally {
  server.kill();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

console.log('═'.repeat(60));
console.log(' 自测结果');
console.log('═'.repeat(60));
console.log(results.join('\n'));
console.log('─'.repeat(60));
console.log(` 通过 ${pass}  失败 ${fail}`);
console.log('═'.repeat(60));

process.exit(fail === 0 ? 0 : 1);
