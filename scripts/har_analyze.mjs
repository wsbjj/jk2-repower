#!/usr/bin/env node
/**
 * ProxyPin / Charles / Chrome HAR 分析器（针对微信小程序 + ThingsBoard 设备 API）
 *
 * 干的事：
 *   1) 按 host 分组、还原时间线
 *   2) 认领人：微信 SDK 上报（wxgateway）→ 解 base64 拿 appid / 版本 / 页面路径
 *   3) 认领设备 API：/api/v1/{token}/telemetry | rpc | attributes → 抽出 token、方法名、参数
 *   4) telemetry 数字 key 展开成 k=v 表
 *   5) rpc 响应两种形态分别处理：
 *        - 明文 "D1:2026,34:11,...,D13:Y"  → 解析成 {寄存器: 值}
 *        - 密文 "BASE64IV:BASE64CT"        → 识别分组/长度/熵，判断是不是 AES/SM4 类分组密码
 *   6) 产出 suggested-config.json（给 client/recover.mjs 用）+ 分析 JSON
 *
 * 用法:
 *   node scripts/har_analyze.mjs capture.har
 *   node scripts/har_analyze.mjs capture.har --out private/analysis
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const harPath = args.find((a) => !a.startsWith('--')) || 'ProxyPin11-15_10_20_03.har';
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'private/analysis';

if (!fs.existsSync(harPath)) {
  console.error(`找不到 HAR: ${harPath}`);
  process.exit(1);
}

const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const entries = har.log?.entries || [];
const creator = har.log?.creator || {};

/* ─────────── 小工具 ─────────── */
const b64len = (s) => Buffer.from(s, 'base64').length;
const entropy = (buf) => {
  const f = {};
  for (const c of buf) f[c] = (f[c] || 0) + 1;
  let H = 0;
  for (const k in f) {
    const p = f[k] / buf.length;
    H -= p * Math.log2(p);
  }
  return +H.toFixed(3);
};
const isBase64ish = (s) => /^[A-Za-z0-9+/=]+$/.test(s) && s.length > 8;
const trim = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

const report = {
  har: { file: path.resolve(harPath), creator, entries: entries.length },
  hosts: {},
  timeline: [],
  wechat: { appid: null, appVersions: new Set(), libVersions: new Set(), pages: new Set(), devices: new Set() },
  deviceApi: { baseUrls: new Set(), tokens: new Set(), endpoints: new Set(), rpcMethods: new Set(), telemetryKeys: new Set() },
  rpcSamples: [],
  telemetrySamples: [],
  attributeSamples: [],
  cdn: {},          // 206 分片下载（小程序包/大资源）覆盖统计
  notes: [],
};

/* 合并区间 → 覆盖率 + 缺口 */
function rangeStats(ranges, total) {
  const rs = [...ranges].sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of rs) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const got = merged.reduce((n, [a, b]) => n + (b - a + 1), 0);
  const gaps = [];
  let cursor = 0;
  for (const [a, b] of merged) {
    if (a > cursor) gaps.push([cursor, a - 1]);
    cursor = b + 1;
  }
  if (total && cursor < total) gaps.push([cursor, total - 1]);
  return {
    chunks: rs.length,
    got,
    total,
    coverage: total ? +((got / total) * 100).toFixed(2) : null,
    merged,
    gaps,
    complete: total ? gaps.length === 0 : null,
  };
}

/* ─────────── 逐条分析 ─────────── */
for (const [i, e] of entries.entries()) {
  const req = e.request || {};
  const res = e.response || {};
  const url = new URL(req.url);
  const host = url.host;
  const reqBody = req.postData?.text || '';
  const resBody = res.content?.text || '';
  const ua = (req.headers || []).find((h) => h.name.toLowerCase() === 'user-agent')?.value || '';
  const referer = (req.headers || []).find((h) => h.name.toLowerCase() === 'referer')?.value || '';

  report.hosts[host] = (report.hosts[host] || 0) + 1;

  // 206 分片：统计大文件抓包完整性
  const cr = (res.headers || []).find((h) => h.name.toLowerCase() === 'content-range')?.value;
  if (res.status === 206 && cr) {
    const m2 = cr.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
    if (m2) {
      const [, a, b, tot] = m2;
      const key = `${host}${url.pathname}`;
      const g = (report.cdn[key] ||= {
        url: `${url.origin}${url.pathname}`,
        object: url.pathname.split('/').pop(),
        total: tot === '*' ? 0 : +tot,
        ranges: [],
      });
      g.ranges.push([+a, +b]);
      if (tot !== '*' && !g.total) g.total = +tot;
    }
  }
  report.timeline.push({
    i,
    t: e.startedDateTime,
    ms: e.time,
    method: req.method,
    url: trim(req.url, 120),
    status: res.status,
    reqBytes: reqBody.length,
    resBytes: resBody.length,
  });

  // 1) 微信 SDK 上报
  if (/wxgateway\.com/.test(host)) {
    try {
      const outer = JSON.parse(reqBody);
      const raw = Buffer.from(outer.request_body?.body || '', 'base64').toString('utf8');
      const inner = JSON.parse(raw);
      const br = inner.base_request || {};
      if (br.AppId) report.wechat.appid = br.AppId;
      if (br.AppVersion) report.wechat.appVersions.add(br.AppVersion);
      if (br.LibVersion) report.wechat.libVersions.add(br.LibVersion);
      if (br.DeviceModel) report.wechat.devices.add(`${br.DeviceModel} / ${br.OsName}`);
      for (const it of inner.item_data_list || []) {
        const p = it.item?.current_path || '';
        if (p) report.wechat.pages.add(trim(p, 200));
      }
    } catch {
      report.notes.push(`[${i}] wxgateway 报文无法解 base64 JSON`);
    }
    continue;
  }

  // 2) ThingsBoard 风格设备 API /api/v1/{token}/{action}
  const m = url.pathname.match(/^\/api\/v1\/([^/]+)\/(telemetry|rpc|attributes|claim|provision|alarm)\b/);
  if (m) {
    const [, token, action] = m;
    report.deviceApi.baseUrls.add(`${url.protocol}//${host}`);
    report.deviceApi.tokens.add(token);
    report.deviceApi.endpoints.add(`/${action}`);
    if (referer) {
      const wm = referer.match(/servicewechat\.com\/(wx[0-9a-f]+)\/(\d+)/);
      if (wm) {
        report.wechat.appid = report.wechat.appid || wm[1];
        report.wechat.appVersions.add(wm[2]);
      }
    }

    if (action === 'telemetry') {
      let body = {};
      try { body = JSON.parse(reqBody); } catch {}
      Object.keys(body).forEach((k) => report.deviceApi.telemetryKeys.add(k));
      report.telemetrySamples.push({ i, at: e.startedDateTime, token, body, status: res.status });
    }

    if (action === 'rpc') {
      let body = {};
      try { body = JSON.parse(reqBody); } catch {}
      if (body.method) report.deviceApi.rpcMethods.add(body.method);

      // 响应可能是 JSON 字符串、{rpcResponse:...}、明文或 "iv:ct"
      let resText = resBody;
      try {
        const j = JSON.parse(resBody);
        resText = typeof j === 'string' ? j : j.rpcResponse ?? resBody;
      } catch {}

      const sample = { i, at: e.startedDateTime, method: body.method, params: body.params, response: trim(resText, 500) };

      if (typeof resText === 'string' && resText.includes(':') && isBase64ish(resText.split(':')[0])) {
        const [ivB64, ctB64] = resText.split(':');
        if (isBase64ish(ctB64)) {
          const iv = Buffer.from(ivB64, 'base64');
          const ct = Buffer.from(ctB64, 'base64');
          sample.encrypted = {
            ivBytes: iv.length,
            ctBytes: ct.length,
            blockAligned: ct.length % 16 === 0,
            blocks: ct.length / 16,
            ctEntropy: entropy(ct),
            format: 'base64(IV) : base64(CIPHERTEXT)',
            guess: ct.length % 16 === 0 && iv.length === 16
              ? 'AES-128/192/256-CBC 或 SM4-CBC（16 字节 IV 前缀 + 16 字节分组）'
              : '分组密码，需补看分组长度',
          };
        }
      } else if (typeof resText === 'string') {
        // 形如 "D1:2026,34:11,...,D13:Y" —— 可能是 键:值 / 地址:值，也可能有重复键，所以保留有序数组
        sample.pairs = resText
          .split(',')
          .filter((p) => p.includes(':'))
          .map((p, idx) => {
            const at = p.lastIndexOf(':');
            return { idx: idx + 1, key: p.slice(0, at), value: p.slice(at + 1) };
          });
        sample.pairMap = Object.fromEntries(sample.pairs.map((p) => [p.key, p.value]));
      }
      report.rpcSamples.push(sample);
    }

    if (action === 'attributes') {
      try {
        report.attributeSamples.push({ i, at: e.startedDateTime, token, scope: JSON.parse(resBody) });
      } catch {}
    }
    continue;
  }

  // 3) 其它：OCSP / 证书检查之类
  if (/ocsp|crl|ct\./i.test(host)) {
    report.notes.push(`[${i}] 证书链检查流量（${host}），与业务无关`);
  }
}

/* ─────────── CDN 覆盖统计 ─────────── */
for (const g of Object.values(report.cdn)) {
  Object.assign(g, rangeStats(g.ranges, g.total));
  g.ranges = g.ranges.map(([a, b]) => `${a}-${b}`);
}

/* ─────────── 输出 ─────────── */
const jsonSafe = JSON.parse(
  JSON.stringify(report, (k, v) => (v instanceof Set ? [...v] : v))
);

// suggested-config：给 client/recover.mjs 用
const baseUrl = [...report.deviceApi.baseUrls][0] || '';
const token = [...report.deviceApi.tokens][0] || '';
const suggested = {
  _comment: '由 scripts/har_analyze.mjs 自动生成，来自 HAR 实测流量。签名/加密类型需要看小程序 JS 才能最终确定。',
  baseUrl,
  appid: report.wechat.appid,
  deviceToken: token,
  authMode: 'url-token',
  sign: { type: 'none' },
  headers: {
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.74 NetType/WIFI Language/zh_CN',
    Referer: `https://servicewechat.com/${report.wechat.appid}/0/page-frame.html`,
  },
  api: {
    telemetry: `${baseUrl}/api/v1/${token}/telemetry`,
    rpc: `${baseUrl}/api/v1/${token}/rpc`,
    attributes: `${baseUrl}/api/v1/${token}/attributes`,
  },
  rpc: { read: 'getCurrentRPCStr', readEncrypted: 'getCurrentRPCStr_B03.08' },
  telemetryKeys: [...report.deviceApi.telemetryKeys],
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'har-analysis.json'), JSON.stringify(jsonSafe, null, 2));
fs.writeFileSync(path.join(outDir, 'suggested-config.json'), JSON.stringify(suggested, null, 2));

/* ─────────── 控制台报告 ─────────── */
console.log(`HAR: ${harPath}`);
console.log(`采集器: ${creator.name} ${creator.version}   条目: ${entries.length}`);
console.log('\n== host 分布 ==');
for (const [h, c] of Object.entries(report.hosts)) console.log(`  ${String(c).padStart(3)}  ${h}`);

console.log('\n== 时间线 ==');
for (const t of report.timeline) {
  console.log(`  [${String(t.i).padStart(2)}] ${t.t}  ${t.method.padEnd(4)} ${String(t.status).padStart(3)}  ${t.url}`);
}

console.log('\n== 微信侧 ==');
console.log('  appid      :', report.wechat.appid);
console.log('  小程序版本 :', [...report.wechat.appVersions].join(', '));
console.log('  SDK 版本   :', [...report.wechat.libVersions].join(', '));
console.log('  设备       :', [...report.wechat.devices].join(', '));
console.log('  页面路径   :', [...report.wechat.pages].join(', '));

console.log('\n== 设备 API ==');
console.log('  baseUrl :', baseUrl);
console.log('  token   :', token, token ? '(URL 路径即凭证)' : '');
console.log('  endpoint:', [...report.deviceApi.endpoints].join(', '));
console.log('  RPC 方法:', [...report.deviceApi.rpcMethods].join(', '));

for (const t of report.telemetrySamples) {
  const n = Object.keys(t.body).length;
  console.log(`\n  telemetry @${t.at}  ${n} 个字段`);
  console.log('   ', JSON.stringify(t.body));
}

for (const r of report.rpcSamples) {
  console.log(`\n  rpc @${r.at}  method=${r.method}`);
  console.log('    params :', JSON.stringify(r.params));
  console.log('    resp   :', trim(r.response, 160));
  if (r.pairs) console.log('    解析   :', JSON.stringify(r.pairs));
  if (r.encrypted) console.log('    密文   :', JSON.stringify(r.encrypted));
}

for (const a of report.attributeSamples) {
  console.log(`\n  attributes @${a.at}`);
  console.log('   ', JSON.stringify(a.scope));
}

if (Object.keys(report.cdn).length) {
  console.log('\n== 大文件分片下载（抓包完整性）==');
  let sumGot = 0, sumTotal = 0;
  for (const [k, g] of Object.entries(report.cdn)) {
    sumGot += g.got; sumTotal += g.total;
    console.log(`  ${g.object}  ${g.total} bytes  ${g.chunks} 片  ${g.got} bytes = ${g.coverage}%  ${g.complete ? '✅ 完整' : '⚠️ 缺 ' + g.gaps.length + ' 段'}`);
    if (!g.complete) {
      const show = g.gaps.slice(0, 6).map(([a, b]) => `${a}-${b}(${b - a + 1})`);
      console.log(`      缺口: ${show.join(', ')}${g.gaps.length > 6 ? ` …共 ${g.gaps.length} 段` : ''}`);
    }
  }
  if (sumTotal) console.log(`  合计: ${sumGot}/${sumTotal} = ${((sumGot / sumTotal) * 100).toFixed(2)}%`);
}

if (report.notes.length) {
  console.log('\n== 备注 ==');
  for (const n of report.notes) console.log('  -', n);
}

console.log(`\n已写出: ${outDir}/har-analysis.json`);
console.log(`已写出: ${outDir}/suggested-config.json`);
