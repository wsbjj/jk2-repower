#!/usr/bin/env node
/**
 * wx 小程序 app-service.js 静态+动态混合分析器
 *
 * 目标：不靠手工翻混淆代码，直接在 Node 沙箱里"跑起来"小程序逻辑，
 *      劫持 wx.* API（request / login / storage / scanCode / bluetooth），
 *      把所有网络请求的 URL、method、header、体、以及**签名函数实际输出**全部录下来。
 *
 * 用法:
 *   node scripts/analyze.mjs out/app-service.js            # 动态跑 + 静态扫
 *   node scripts/analyze.mjs out/app-service.js --static   # 只静态扫
 *   node scripts/analyze.mjs out/app-service.js --entry "pages/index/index.js"
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const args = process.argv.slice(2);
const target = args[0] || 'out/app-service.js';
const STATIC_ONLY = args.includes('--static');
const entryHint = args.includes('--entry') ? args[args.indexOf('--entry') + 1] : '';

if (!fs.existsSync(target)) {
  console.error(`找不到 ${target}，先跑: bash scripts/pull_wxapkg.sh && node scripts/unpack.mjs pkg out`);
  process.exit(1);
}
const code = fs.readFileSync(target, 'utf8');

// 沙箱内小程序回调抛出的异常不能终止分析
const softErrors = [];
process.on('uncaughtException', (e) => { softErrors.push(String(e)); });
process.on('unhandledRejection', (e) => { softErrors.push('unhandledRejection: ' + String(e)); });

const report = {
  generatedAt: new Date().toISOString(),
  source: path.resolve(target),
  size: code.length,
  baseUrls: [],
  endpoints: [],
  signCandidates: [],
  needsCaptcha: [],
  calls: [],
  wxApiUsage: {},
  storage: {},
  loginCode: null,
};

/* ─────────────── 静态扫描 ─────────────── */
const STATIC_PATTERNS = [
  // 完整 URL 字面量
  { re: /["'`]((https?:\/\/)[^"'`\s]{4,200})["'`]/g, group: 1, bucket: 'baseUrls' },
  // 路径字面量
  { re: /["'`](\/[a-zA-Z0-9_\-./{}:]{2,120})["'`]/g, group: 1, bucket: 'endpoints' },
  // 拼接式 url: host + "/api/xxx"
  { re: /\.url\s*=\s*([^,\n;]{3,160})/g, group: 1, bucket: 'endpoints' },
  // 签名相关标识符
  { re: /\b([A-Za-z0-9_$]*(?:sign|Sign|SIGN|md5|MD5|hmac|HMAC|sha1|SHA1|sha256|SHA256|encrypt|AES|token|appId|appkey|secret)[A-Za-z0-9_$]*)\s*[:(=]/g, group: 1, bucket: 'signCandidates' },
  // 验证码 / 风控
  { re: /\b([A-Za-z0-9_$]*(?:captcha|Captcha|verifyCode|validate|riskControl|geetest|slider|人机)[A-Za-z0-9_$]*)/g, group: 1, bucket: 'needsCaptcha' },
];

for (const { re, group, bucket } of STATIC_PATTERNS) {
  for (const m of code.matchAll(re)) {
    const v = String(m[group]).trim();
    if (!v || v.length > 300) continue;
    if (!report[bucket].includes(v)) report[bucket].push(v);
  }
}

for (const api of ['request', 'login', 'scanCode', 'getStorageSync', 'setStorageSync',
  'getStorage', 'setStorage', 'connectSocket', 'openBluetoothAdapter',
  'createBLEConnection', 'writeBLECharacteristicValue', 'getBLEDeviceCharacteristics',
  'startBluetoothDevicesDiscovery', 'getSystemInfoSync', 'getNetworkType',
  'checkSession', 'getUserProfile', 'requestSubscribeMessage']) {
  const n = (code.match(new RegExp(`wx\\.${api}\\s*\\(`, 'g')) || []).length;
  if (n) report.wxApiUsage[api] = n;
}

report.baseUrls = report.baseUrls
  .filter((u) => !/w3\.org|json-schema|\.map$/.test(u))
  .slice(0, 40);
report.endpoints = report.endpoints
  .filter((u) => /^\/|\/api\/|\/$/.test(u) && !/\.(js|css|wxss|png|jpg|svg|json|wxml)$/.test(u))
  .slice(0, 200);
report.signCandidates = [...new Set(report.signCandidates)].slice(0, 60);
report.needsCaptcha = [...new Set(report.needsCaptcha)].slice(0, 20);

/* ─────────────── 动态沙箱 ─────────────── */
const sandboxRecords = [];
let appInstance = null;
const pageInstances = [];
const storage = {};

if (!STATIC_ONLY) {
  const mkHeader = () => ({
    'content-type': 'application/json',
    'user-agent': 'MicroMessenger/8.0.49 miniProgram',
  });

  const record = (r) => {
    const rec = {
      seq: sandboxRecords.length + 1,
      ts: new Date().toISOString(),
      url: String(r.url || ''),
      method: (r.method || 'GET').toUpperCase(),
      header: r.header || mkHeader(),
      data: r.data ?? null,
      dataType: r.dataType || 'json',
    };
    sandboxRecords.push(rec);
    return rec;
  };

  // 通用成功响应：让小程序继续往下走（拿到"登录成功"的分支），
  // 这样后续携带 token 的业务请求才会被真实触发。
  const fakeOk = (rec) => {
    const isLogin = /login|auth|session|token/i.test(rec.url);
    const body = isLogin
      ? { code: 0, msg: 'ok', data: { token: 'SANDBOX_TOKEN_FILL_ME', expiresIn: 7200, userId: 1 } }
      : { code: 0, msg: 'ok', data: { roomNo: 'SANDBOX_ROOM', power: false, orderId: 'SANDBOX_ORDER', status: 1 } };
    return body;
  };

  const wx = {
    request(opt) {
      const rec = record(opt);
      const res = fakeOk(rec);
      // 用 safeCall 包裹：小程序回调里的异常不能把分析进程带走
      const safeCall = (fn, arg) => setTimeout(() => { try { fn(arg); } catch (e) { report.callbackErrors = [...(report.callbackErrors || []), String(e)]; } }, 0);
      if (typeof opt.success === 'function') safeCall(opt.success, { statusCode: 200, data: res, header: {} });
      if (typeof opt.complete === 'function') safeCall(opt.complete, { statusCode: 200, data: res });
      return { abort() { } };
    },
    login(opt = {}) {
      report.loginCode = 'SANDBOX_WX_LOGIN_CODE';
      if (opt.success) setTimeout(() => opt.success({ code: report.loginCode, errMsg: 'login:ok' }), 0);
      if (opt.complete) setTimeout(() => opt.complete({ code: report.loginCode }), 0);
      return {};
    },
    checkSession(opt = {}) { opt.success && setTimeout(() => opt.success({ errMsg: 'ok' }), 0); return {}; },
    scanCode(opt = {}) {
      // 关键：喂一个可控的二维码内容，观察它如何进入请求参数/签名
      const result = process.env.SANDBOX_QR || 'SANDBOX_QR_CONTENT';
      if (opt.success) setTimeout(() => opt.success({ result, scanType: 'QR_CODE', charSet: 'utf-8' }), 0);
      return {};
    },
    getStorageSync(k) { return storage[k]; },
    setStorageSync(k, v) { storage[k] = v; report.storage[k] = v; },
    getStorage(opt = {}) { opt.success && opt.success({ data: storage[opt.key] }); return {}; },
    setStorage(opt = {}) { storage[opt.key] = opt.data; report.storage[opt.key] = opt.data; return {}; },
    removeStorageSync(k) { delete storage[k]; },
    clearStorageSync() { for (const k of Object.keys(storage)) delete storage[k]; },
    getSystemInfoSync() {
      return {
        brand: 'iPhone', model: 'iPhone SE', system: 'iOS 15.8', platform: 'ios',
        version: '8.0.49', SDKVersion: '3.5.0', screenWidth: 375, screenHeight: 667,
        pixelRatio: 2, windowWidth: 375, windowHeight: 603, language: 'zh_CN',
        bluetoothEnabled: true, locationEnabled: false, wifiEnabled: true,
      };
    },
    getSystemInfo(opt = {}) { opt.success && opt.success(wx.getSystemInfoSync()); return {}; },
    getNetworkType(opt = {}) { opt.success && opt.success({ networkType: 'wifi' }); return {}; },
    getUserProfile(opt = {}) {
      opt.success && opt.success({ userInfo: { nickName: 'SANDBOX_USER', avatarUrl: '' } });
      return {};
    },
    showToast() { }, showModal(opt = {}) { opt.success && opt.success({ confirm: true }); return {}; },
    showLoading() { }, hideLoading() { }, hideToast() { },
    navigateTo() { }, redirectTo() { }, switchTab() { }, navigateBack() { }, reLaunch() { },
    setNavigationBarTitle() { }, stopPullDownRefresh() { }, startPullDownRefresh() { },
    requestSubscribeMessage(opt = {}) { opt.success && opt.success({}); return {}; },
    connectSocket() { return { onOpen() { }, onMessage() { }, onClose() { }, send() { }, close() { } }; },
    // 蓝牙：录制调用序列，供 BLE 直控参考
    openBluetoothAdapter(opt = {}) { recordBle('openBluetoothAdapter', opt); opt.success && opt.success({}); return {}; },
    startBluetoothDevicesDiscovery(opt = {}) { recordBle('startBluetoothDevicesDiscovery', opt); opt.success && opt.success({}); return {}; },
    createBLEConnection(opt = {}) { recordBle('createBLEConnection', opt); opt.success && opt.success({}); return {}; },
    getBLEDeviceServices(opt = {}) { recordBle('getBLEDeviceServices', opt); opt.success && opt.success({ services: [] }); return {}; },
    getBLEDeviceCharacteristics(opt = {}) { recordBle('getBLEDeviceCharacteristics', opt); opt.success && opt.success({ characteristics: [] }); return {}; },
    writeBLECharacteristicValue(opt = {}) { recordBle('writeBLECharacteristicValue', opt); opt.success && opt.success({}); return {}; },
    notifyBLECharacteristicValueChange(opt = {}) { recordBle('notifyBLECharacteristicValueChange', opt); opt.success && opt.success({}); return {}; },
    closeBLEConnection(opt = {}) { opt.success && opt.success({}); return {}; },
  };

  report.ble = [];
  function recordBle(api, opt) {
    report.ble.push({
      api,
      deviceId: opt?.deviceId, serviceId: opt?.serviceId, characteristicId: opt?.characteristicId,
      value: opt?.value ? Buffer.from(opt.value).toString('hex') : undefined,
    });
  }

  const wxLike = new Proxy(wx, {
    get(t, k) {
      if (k in t) return t[k];
      // 未实现的 wx.xxx 一律返回空函数，避免小程序直接崩
      return (...a) => {
        const opt = a[0];
        if (opt && typeof opt === 'object') {
          if (opt.success) setTimeout(() => opt.success({}), 0);
          if (opt.fail) { /* 不主动 fail */ }
          if (opt.complete) setTimeout(() => opt.complete({}), 0);
        }
        return {};
      };
    },
  });

  // 模块系统：兼容 webpack 打包后的 define/require
  const modules = {};
  const defineReg = /define\(\s*["']([^"']+)["']\s*,\s*function\s*\(([^)]*)\)\s*\{/g;
  const defs = [];
  for (const m of code.matchAll(defineReg)) {
    defs.push({ name: m[1], start: m.index + m[0].length });
  }

  function makeApp(opts) {
    appInstance = opts;
    if (typeof opts.onLaunch === 'function') { try { opts.onLaunch.call(opts, {}); } catch (e) { report.appLaunchError = String(e); } }
    if (typeof opts.onShow === 'function') { try { opts.onShow.call(opts, {}); } catch (e) { /* ignore */ } }
    return opts;
  }
  function makePage(opts) {
    const inst = Object.assign({}, opts, {
      data: JSON.parse(JSON.stringify(opts.data || {})),
      setData(d, cb) { Object.assign(this.data, d || {}); if (typeof cb === 'function') cb(); },
      route: entryHint || 'pages/index/index',
      __isPage: true,
    });
    for (const [k, v] of Object.entries(opts)) {
      if (typeof v === 'function') inst[k] = v.bind(inst);
    }
    pageInstances.push(inst);
    try { inst.onLoad && inst.onLoad({}); } catch (e) { report.pageLoadErrors = [...(report.pageLoadErrors || []), String(e)]; }
    try { inst.onShow && inst.onShow(); } catch (e) { /* ignore */ }
    try { inst.onReady && inst.onReady(); } catch (e) { /* ignore */ }
    return inst;
  }

  const ctx = vm.createContext({
    wx: wxLike,
    App: makeApp,
    Page: makePage,
    Component: (o) => o,
    getApp: () => appInstance || { globalData: {} },
    getCurrentPages: () => pageInstances.map((p, i) => ({ ...p, route: entryHint || `pages/p${i}/index` })),
    define: (n, f) => { modules[n] = { fn: f, exports: {}, loaded: false }; },
    require: (n) => loadModule(n),
    module: { exports: {} },
    exports: {},
    console: { log: (...a) => { }, info: () => { }, warn: () => { }, error: () => { }, debug: () => { } },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => { },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    encodeURI, decodeURI, escape: globalThis.escape, unescape: globalThis.unescape,
    Buffer, TextEncoder, TextDecoder, URL, URLSearchParams,
    navigator: { userAgent: 'miniProgram' },
    __wxConfig: { platform: 'ios', envVersion: 'release' },
  });
  ctx.global = ctx;
  ctx.globalThis = ctx;
  ctx.window = ctx;

  function loadModule(name) {
    let key = String(name).replace(/^\.\//, '');
    if (!modules[key]) {
      if (modules[key + '.js']) key = key + '.js';
      else {
        const hit = Object.keys(modules).find((k) => k.endsWith('/' + key) || k.endsWith('/' + key + '.js'));
        if (hit) key = hit;
      }
    }
    const mod = modules[key];
    if (!mod) return {};
    if (mod.loaded) return mod.exports;
    mod.loaded = true;
    try {
      mod.fn(loadModule, mod, mod.exports);
    } catch (e) {
      report.moduleErrors = [...(report.moduleErrors || []), `${key}: ${e}`];
    }
    return mod.exports;
  }

  try {
    vm.runInContext(code, ctx, { timeout: 15000, filename: 'app-service.js' });
  } catch (e) {
    report.runError = String(e);
  }

  // 关键兼容处理：真实 wxapkg 的 app-service.js 自己声明了 define/require
  // （会覆盖沙箱注入的同名全局），模块表就落在这个自建闭包里。
  // 必须用"它自己的" require 去驱动模块工厂，App()/Page() 才会被执行。
  const selfDefs = ctx.__defs && typeof ctx.__defs === 'object' ? ctx.__defs : null;
  const selfRequire = typeof ctx.require === 'function' ? ctx.require : null;
  if (selfDefs && selfRequire) {
    report.bootstrap = 'self-defined define/require';
    const names = Object.keys(selfDefs);
    report.modules = names;
    // 先跑看起来是入口的模块，让 App/Page 尽早注册
    const ordered = names.sort((a, b) => {
      const score = (n) => (/app\.js$/.test(n) ? 0 : /pages\//.test(n) ? 1 : 2);
      return score(a) - score(b);
    });
    for (const n of ordered) {
      try { selfRequire(n); } catch (e) {
        report.moduleErrors = [...(report.moduleErrors || []), `${n}: ${e.message || e}`];
      }
    }
  } else if (Object.keys(modules).length) {
    report.bootstrap = 'injected define';
    report.modules = Object.keys(modules);
    for (const n of Object.keys(modules)) loadModule(n);
  }

  // 等 setTimeout 队列跑完（模拟"用户扫码"再跑一轮）
  await new Promise((r) => setTimeout(r, 60));

  // 主动触发扫码复电流程：直接调用每个 Page 的扫码/复电相关方法
  const ACTION_RE = /scan|recover|rePower|onRecover|resume|restore|通电|复电|openPower|turnOn|unlock/i;
  for (const p of pageInstances) {
    for (const [k, fn] of Object.entries(p)) {
      if (typeof fn !== 'function' || !ACTION_RE.test(k)) continue;
      if (/onLoad|onShow|onReady|onHide|onUnload/.test(k)) continue;
      try { fn.call(p, process.env.SANDBOX_QR || 'SANDBOX_QR_CONTENT'); } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await new Promise((r) => setTimeout(r, 80));

  report.calls = sandboxRecords;
  report.storage = storage;
  report.callbackErrors = [...new Set([...(report.callbackErrors || []), ...softErrors])];
  report.pages = pageInstances.map((p) => ({ data: p.data, methods: Object.keys(p).filter((k) => typeof p[k] === 'function' && k !== '__isPage') }));
}

/* ─────────────── 输出 ─────────────── */
const outJson = path.join(path.dirname(target), 'analysis.json');
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));

const line = (s = '') => console.log(s);
line('═'.repeat(64));
line('小程序接口分析报告');
line('═'.repeat(64));
line(`源文件   : ${report.source}`);
line(`大小     : ${report.size} bytes`);
line(`模块数   : ${(report.modules || []).length}`);
line(`页面数   : ${(report.pages || []).length}`);
line();
line('【wx API 使用统计】');
for (const [k, v] of Object.entries(report.wxApiUsage)) line(`  wx.${k.padEnd(32)} ${v} 次`);

line();
line('【Base URL】');
if (!report.baseUrls.length) line('  (无)');
for (const u of report.baseUrls) line('  ' + u);

line();
line('【候选接口路径】' + (report.endpoints.length ? '' : ' (无)'));
for (const u of report.endpoints.slice(0, 40)) line('  ' + u);

line();
line('【签名/凭证相关标识】' + (report.signCandidates.length ? '' : ' (无)'));
for (const s of report.signCandidates.slice(0, 30)) line('  ' + s);

if (report.needsCaptcha.length) {
  line();
  line('【风控/验证码痕迹】');
  for (const s of report.needsCaptcha) line('  ' + s);
}

line();
line('【抓到的实际请求】' + (report.calls.length ? '' : ' (无 — 可能未触发，试试 --entry 或 SANDBOX_QR)'));
for (const c of report.calls) {
  line(`  #${c.seq} ${c.method} ${c.url}`);
  const hk = Object.keys(c.header || {});
  if (hk.length) line(`      header: ${JSON.stringify(c.header)}`);
  if (c.data !== null && c.data !== undefined) line(`      body  : ${JSON.stringify(c.data)}`);
}

if ((report.ble || []).length) {
  line();
  line('【BLE 调用序列（小程序自己就有蓝牙通道？）】');
  for (const b of report.ble) line('  ' + JSON.stringify(b));
}

if (report.runError) {
  line();
  line('【沙箱运行异常】' + report.runError);
  line('  提示：多半是缺少某个 wx API 或需要 DOM。仍可用静态结果 + mitmproxy 抓包兜底。');
}
if (report.moduleErrors?.length) {
  line();
  line('【模块加载异常】');
  for (const e of report.moduleErrors.slice(0, 10)) line('  ' + e);
}

line();
line(`完整报告 → ${outJson}`);
line('═'.repeat(64));
