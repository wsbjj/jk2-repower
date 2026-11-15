#!/usr/bin/env python3
"""
mitmproxy 插件 —— 从小程序真实流量里逆出接口

用途：iPhone 连 Mac 代理后，用微信打开那个小程序点一次"扫码复电"，
      本插件会把完整请求（URL / header / body / 签名）落盘，并把关键凭证
      （Authorization、X-Sign、cookie、code）单独提取出来，直接生成 config 片段。

启动：
  mitmdump -s capture/mitm_addon.py --set dump_dir=./captures -p 8080

iPhone 侧：
  1) WiFi 代理指向 Mac 的 局域网IP:8080
  2) Safari 打开 http://mitm.it 装证书
  3) 设置 → 通用 → 关于本机 → 证书信任设置 → 信任 mitmproxy
  4) 打开小程序，点一次复电

产物：
  captures/<时间>.jsonl      —— 每条请求一行
  captures/summary.json       —— 聚合后的接口清单 + 凭证 + 推断出的签名模板
  captures/suggested-config.json —— 可直接当 config.json 的初稿
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

from mitmproxy import ctx, http

DUMP_DIR = Path(os.environ.get("CAPTURE_DIR", "./captures"))
INTERESTING = re.compile(r"/api/|/dorm|/power|/recover|/electric|/room|/auth|/login|/scan|/qr|/order", re.I)
SKIP_EXT = re.compile(r"\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|map)(\?|$)", re.I)
AUTH_HEADERS = ["authorization", "x-sign", "x-token", "x-timestamp", "x-nonce", "sign",
                "cookie", "x-appid", "x-request-id", "user-agent", "referer"]


class Collector:
    def __init__(self):
        DUMP_DIR.mkdir(parents=True, exist_ok=True)
        self.stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.jsonl = DUMP_DIR / f"{self.stamp}.jsonl"
        self.records: list[dict] = []
        self.secrets: dict[str, set] = {}
        self.endpoints: dict[str, dict] = {}
        ctx.log.info(f"[collector] 落盘目录 {DUMP_DIR.resolve()}")

    def response(self, flow: http.HTTPFlow):
        req, res = flow.request, flow.response
        if not req or not res:
            return
        if SKIP_EXT.search(req.path):
            return

        host = req.pretty_host
        # 小程序请求一般走 servicewechat.com 网关或业务域名，两类都收
        is_interesting = INTERESTING.search(req.path) or "servicewechat" in host
        if not is_interesting:
            return

        hdrs = {k: v for k, v in req.headers.items()}
        auth = {h: hdrs.get(h) for h in AUTH_HEADERS if hdrs.get(h)}

        body_txt = ""
        if req.content:
            try:
                body_txt = req.get_text(strict=False) or ""
            except Exception:
                body_txt = f"<binary {len(req.content)}B>"

        res_txt = ""
        if res.content:
            try:
                res_txt = res.get_text(strict=False) or ""
            except Exception:
                res_txt = f"<binary {len(res.content)}B>"

        rec = {
            "time": datetime.now().isoformat(timespec="milliseconds"),
            "method": req.method,
            "url": req.pretty_url,
            "host": host,
            "path": req.path,
            "status": res.status_code,
            "request_headers": hdrs,
            "auth_headers": {k: v for k, v in auth.items() if v},
            "request_body": body_txt[:4000],
            "response_body": res_txt[:4000],
        }
        self.records.append(rec)

        with self.jsonl.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

        # 提取凭证
        for k, v in auth.items():
            if k in ("user-agent", "referer") or not v:
                continue
            self.secrets.setdefault(k, set()).add(v[:200])
        for pat, label in [
            (r'"(?:token|accessToken|access_token|refreshToken)"\s*:\s*"([^"]{8,})"', "token"),
            (r'"(?:qrToken|qr_token|ticket|bizToken)"\s*:\s*"([^"]{4,})"', "qrToken"),
            (r'"(?:roomNo|room_no|roomId|dormNo|room)"\s*:\s*"?([A-Za-z0-9_-]{1,20})"?', "roomNo"),
            (r'"(?:sign|signature|X-Sign)"\s*:\s*"([a-fA-F0-9]{16,})"', "sign"),
        ]:
            for m in re.finditer(pat, body_txt + " " + res_txt):
                self.secrets.setdefault(label, set()).add(m.group(1)[:200])

        # 聚合接口
        key = f"{req.method} {req.path.split('?')[0]}"
        ep = self.endpoints.setdefault(key, {
            "method": req.method, "path": req.path.split("?")[0],
            "host": host, "count": 0, "statuses": set(),
            "auth_headers": set(), "sample_body": None, "sample_response": None,
        })
        ep["count"] += 1
        ep["statuses"].add(res.status_code)
        ep["auth_headers"].update(k for k, v in auth.items() if v)
        if ep["sample_body"] is None and body_txt:
            ep["sample_body"] = body_txt[:1500]
        if ep["sample_response"] is None and res_txt:
            ep["sample_response"] = res_txt[:1500]

        ctx.log.info(f"[{res.status_code}] {req.method} {host}{req.path}  auth={list(auth)}")

    def done(self):
        if not self.records:
            ctx.log.warn("[collector] 没抓到任何业务请求；检查代理/证书信任")
            return

        eps = []
        for k, v in sorted(self.endpoints.items()):
            eps.append({**v, "statuses": sorted(v["statuses"]), "auth_headers": sorted(v["auth_headers"])})

        summary = {
            "generated_at": datetime.now().isoformat(),
            "total_requests": len(self.records),
            "endpoints": eps,
            "secrets": {k: sorted(v) for k, v in self.secrets.items()},
        }
        (DUMP_DIR / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))

        # 推断签名模板
        cfg = self._suggest(eps, summary["secrets"])
        (DUMP_DIR / "suggested-config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2))

        ctx.log.info(f"[collector] {len(self.records)} 条请求 → {DUMP_DIR}/summary.json")
        ctx.log.info(f"[collector] config 初稿 → {DUMP_DIR}/suggested-config.json")

    def _suggest(self, eps, secrets):
        hosts = [e["host"] for e in eps]
        base = ""
        for h in hosts:
            if h and "servicewechat" not in h:
                base = f"https://{h}"
                break
        pick = lambda pat: next((e["path"] for e in eps if re.search(pat, e["path"], re.I)), "")
        has_sign_header = any("x-sign" in e["auth_headers"] or "sign" in e["auth_headers"] for e in eps)
        has_ts_header = any("x-timestamp" in e["auth_headers"] for e in eps)

        return {
            "_comment": "由 mitmproxy 自动生成，需人工核对 sign.template / secret",
            "baseUrl": base or "https://REPLACE_ME",
            "appid": "wxREPLACE_ME",
            "roomNo": (secrets.get("roomNo") or ["301"])[0],
            "sign": {
                "type": "md5" if has_sign_header else "none",
                "template": "{sortedParams}&ts={ts}&k={secret}",
                "secret": "FILL_FROM_JS_OR_CAPTURE",
                "placement": "header" if has_sign_header else "none",
                "headerName": "X-Sign",
                "sendTs": has_ts_header,
            },
            "api": {
                "login": pick(r"login|auth|session") or "/api/login",
                "roomInfo": pick(r"room|info|status") or "/api/room/info",
                "recover": pick(r"recover|power|open|resume|restore") or "/api/power/recover",
            },
            "observed_endpoints": [f'{e["method"]} {e["path"]}' for e in eps],
        }


addons = [Collector()]
