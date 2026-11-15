#!/usr/bin/env python3
"""
JK-2 用电监控器 —— 多宿舍复电客户端

协议（已实测）：
  服务 0000ffe0 / 特征 0000ffe1 (handle 0x0019)
  写入序列：明文配置串 → 加密 RPC（云端 getCurrentRPCStr_B03.08）
  每段 80 字节，Write Request

设备令牌 = 设备名 = B03-<房间号>，云端接口无需登录：
  https://www.myneepu.com:8080/api/v1/DEV_TOKEN/...

用法：
  python3 jk2.py rooms                   # 列出已配置的宿舍
  python3 jk2.py discover                # 扫描周边所有 JK-2
  python3 jk2.py status                  # 单台（默认第一台）
  python3 jk2.py status --all            # 全部
  python3 jk2.py status --token DEV_TOKEN # 指定
  python3 jk2.py recover --all           # 全部复电
  python3 jk2.py watch --all             # 全部常驻守护
  python3 jk2.py add B03-XXXX 张三宿舍   # 添加宿舍到配置
"""
from __future__ import annotations

import argparse
import asyncio
import os
import json
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

BASE = os.environ.get("JK2_BASE", "https://www.myneepu.com:8080")
CH = "0000ffe1-0000-1000-8000-00805f9b34fb"
CHUNK = 80
ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Path(os.environ.get("PRIVATE_DIR", ROOT / "private"))
DEVICES_FILE = Path(os.environ.get("JK2_DEVICES", PRIVATE / "devices" / "devices.json"))

_addr_cache: dict[str, str] = {}

# 写指令的全局节流：设备 RTC 会被频繁写入搞乱（故障码 24），
# 小程序正常是「扫一次写一次」，我们不该比它更频繁
MIN_WRITE_GAP = float(__import__("os").environ.get("JK2_MIN_WRITE_GAP", "600"))
_LASTWRITE_FILE = DEVICES_FILE.parent / ".lastwrite.json"


def _load_lastwrite() -> dict:
    try:
        return json.loads(_LASTWRITE_FILE.read_text())
    except Exception:
        return {}


def _save_lastwrite(d: dict):
    try:
        _LASTWRITE_FILE.write_text(json.dumps(d))
    except Exception:
        pass


def log(*a, tag=""):
    ts = datetime.now().strftime("%H:%M:%S")
    prefix = f"[{ts}]" + (f" [{tag}]" if tag else "")
    print(prefix, *a, flush=True)


# ── 设备配置 ──
def load_devices() -> list[dict]:
    if not DEVICES_FILE.exists():
        return []
    try:
        data = json.loads(DEVICES_FILE.read_text())
        return [d for d in data if d.get("token")]
    except Exception as e:
        log(f"{DEVICES_FILE} 解析失败: {e}")
        return []


def save_devices(devs: list[dict]):
    DEVICES_FILE.parent.mkdir(parents=True, exist_ok=True)
    DEVICES_FILE.write_text(json.dumps(devs, ensure_ascii=False, indent=2))


def pick_devices(args) -> list[dict]:
    devs = load_devices()
    token = getattr(args, "token", None)
    if token:
        hit = [d for d in devs if d["token"] == token]
        return hit or [{"token": token, "name": token}]
    if not devs:
        log("没有配置任何设备，先执行: python3 jk2.py add DEV_TOKEN 我的宿舍")
        return []
    if getattr(args, "all", False):
        return devs
    return [devs[0]]


# ── 云端 ──
def http_rpc(token: str, method: str, temperature: str = "25"):
    req = urllib.request.Request(
        f"{BASE}/api/v1/{token}/rpc",
        data=json.dumps({"method": method, "params": {"temperature": temperature}}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def fetch_commands(token: str, temperature: str = "25"):
    cfg = http_rpc(token, "getCurrentRPCStr", temperature)
    enc = http_rpc(token, "getCurrentRPCStr_B03.08", temperature)
    if isinstance(enc, dict) and "rpcResponse" in enc:
        payload = json.dumps(enc, separators=(",", ":"))
    else:
        payload = json.dumps({"rpcResponse": enc}, separators=(",", ":"))
    return cfg, payload


def chunks(s: str, n: int = CHUNK):
    b = s.encode()
    return [b[i:i + n] for i in range(0, len(b), n)]


# ── 蓝牙 ──
async def find_device(token: str, timeout: float = 10.0):
    from bleak import BleakClient, BleakScanner

    cached = _addr_cache.get(token)
    if cached:
        try:
            async with BleakClient(cached, timeout=6) as c:
                if c.is_connected:
                    return _Dev(token, cached)
        except Exception:
            _addr_cache.pop(token, None)

    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    hits = [(d, a) for d, a in found.values() if (d.name or a.local_name or "") == token]
    if not hits:
        # 前缀兜底
        hits = [(d, a) for d, a in found.values() if token.lower() in (d.name or a.local_name or "").lower()]
    if not hits:
        return None
    hits.sort(key=lambda x: -(x[1].rssi or -999))
    dev, adv = hits[0]
    _addr_cache[token] = dev.address
    return _Dev(dev.name, dev.address, adv.rssi)


class _Dev:
    def __init__(self, name, address, rssi=None):
        self.name = name
        self.address = address
        self.rssi = rssi


def parse_status(text: str) -> dict:
    out = {}
    for part in text.split(","):
        if ":" in part:
            k, v = part.split(":", 1)
            if k.isdigit():
                out[int(k)] = v
    return out


def describe(st: dict) -> str:
    if not st:
        return "  （无状态数据）"
    g = lambda i, d="-": st.get(i, d)
    sw = lambda v: "开" if v == "Y" else ("关" if v == "N" else str(v))
    win = g(27, "")
    m = re.match(r"^(\d{4})-(\d{4})$", win or "")
    if m:
        win = f"{m.group(1)[:2]}:{m.group(1)[2:]} ~ {m.group(2)[:2]}:{m.group(2)[2:]}（12小时制）"
    return "\n".join("  " + l for l in [
        f"设备      {g(1)}",
        f"时间      {g(2)} {g(3)}",
        f"累计电量  {g(4)} kWh",
        f"电压      {g(6)} V",
        f"电流      {g(7)} A",
        f"功率因数  {g(8)}",
        f"固件      {g(18)} {g(19)}",
        f"开关1/2/3 {sw(g(24))} / {sw(g(25))} / {sw(g(26))}",
        f"供电时段  {win}",
    ])


async def talk(token: str, quiet=False, wait=12.0):
    """连一台设备，写指令，取状态。返回 status dict 或 None"""
    import time
    lw = _load_lastwrite()
    gap = time.time() - float(lw.get(token, 0))
    if gap < MIN_WRITE_GAP:
        if not quiet:
            log(f"距上次写入仅 {gap:.0f}s < {MIN_WRITE_GAP:.0f}s 保护阈值，跳过（防止 RTC 异常）", tag=token)
        return None
    lw[token] = time.time()
    _save_lastwrite(lw)

    try:
        cfg, payload = fetch_commands(token)
    except Exception as e:
        if not quiet:
            log(f"云端取指令失败: {e}", tag=token)
        return None

    dev = await find_device(token)
    if not dev:
        if not quiet:
            log("蓝牙未找到该设备（超出范围？）", tag=token)
        return None
    if not quiet and dev.rssi is not None:
        log(f"命中 RSSI={dev.rssi}", tag=token)

    from bleak import BleakClient
    notes = []
    try:
        async with BleakClient(dev.address, timeout=30) as c:
            await c.start_notify(CH, lambda h, d: notes.append(bytes(d)))
            await asyncio.sleep(0.7)
            for ch in chunks(cfg):
                await c.write_gatt_char(CH, ch, response=True)
                await asyncio.sleep(0.12)
            for ch in chunks(payload):
                await c.write_gatt_char(CH, ch, response=True)
                await asyncio.sleep(0.12)
            for _ in range(int(wait)):
                await asyncio.sleep(1)
                if any(b"1:" in n for n in notes):
                    break
    except Exception as e:
        if not quiet:
            log(f"蓝牙通信失败: {e}", tag=token)
        return None

    st = None
    for n in notes:
        t = n.decode("utf-8", "replace")
        if re.search(r"\b24:[YN]", t):
            st = parse_status(t)
    return st


# ── 守护模式风险提示 ──
def _dwidth(text: str) -> int:
    """按终端显示宽度计算（CJK 全角算 2 列）"""
    import unicodedata
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in text)


def _box(lines: list[str], width: int = 64) -> str:
    """画一个对齐的方框"""
    top = "╔" + "═" * width + "╗"
    mid = "╠" + "═" * width + "╣"
    bot = "╚" + "═" * width + "╝"
    out = [top]
    for ln in lines:
        if ln == "---":
            out.append(mid)
            continue
        pad = width - 2 - _dwidth(ln)
        out.append("║ " + ln + " " * max(0, pad) + " ║")
    out.append(bot)
    return "\n".join(out)


def watch_warning(interval: float, min_gap: float, n_devices: int) -> str:
    """守护模式的完整风险提示"""
    per_day = int(86400 / max(interval, 1)) * max(n_devices, 1)
    packets = per_day * 4          # 一次复电序列 = 4 个 BLE 写包
    body = [
        "⚠  守护模式 —— 请先读完这段再决定",
        "---",
        "本模式会【周期性向监控器写入指令】。",
        "",
        "已知风险：写入过于频繁可能导致设备 RTC 异常（故障码 24），",
        "出现的症状：",
        "  · 电压 / 电流 / 电量全部读成 0",
        "  · 继电器锁死在断开状态 ——【房间直接没电】",
        "  · 但小程序仍显示“开关=开”，容易误判",
        "",
        "恢复办法（软件无法修复）：",
        "  · 拔掉 JK-2 电源，等 10 秒再插上；或",
        "  · 等 30 分钟让设备自行退出保护态",
        "",
        "设备的设计用途是「人走到设备前扫一次码」，不适合高频轮询。",
        "---",
        "当前配置",
        f"  设备数量        {n_devices} 台",
        f"  轮询间隔        {interval:.0f} 秒",
        f"  写入最小间隔    {min_gap:.0f} 秒（强制节流）",
        f"  每天复电序列    {per_day} 次",
        f"  每天 BLE 写包   {packets} 个（每次复电 4 包）",
        "",
        "对比：手动扫码一次 = 4 个写包。",
        "      正常人一天扫几次 = 20~40 包。",
        "---",
        "建议",
        "  · 日常复电用单次：./run.sh jk-recover",
        "  · 真要自动化，一天 2 次定点（launchd StartCalendarInterval）",
        "  · 不建议长期挂守护模式",
    ]
    return "\n" + _box(body) + "\n"


def confirm_watch(interval: float, min_gap: float, n_devices: int, assume_yes: bool) -> bool:
    """打印风险提示并要求确认。非交互环境或 --yes 时跳过询问"""
    print(watch_warning(interval, min_gap, n_devices))
    if assume_yes:
        log("已通过 --yes 跳过确认")
        return True
    if not sys.stdin.isatty():
        log("非交互环境，默认继续（风险见上）")
        return True
    try:
        ans = input("确认已理解风险并继续？输入 yes 继续，其他任意键取消：").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return False
    if ans in ("yes", "y"):
        return True
    log("已取消")
    return False


# ── 命令 ──
def cmd_rooms(args):
    devs = load_devices()
    print(f"已配置 {len(devs)} 个宿舍：\n")
    print(f"{'令牌':<12} {'名称':<16} 缓存地址")
    for d in devs:
        print(f"{d['token']:<12} {d.get('name',''):<16} {_addr_cache.get(d['token'],'-')}")
    print(f"\n配置文件: {DEVICES_FILE}")


def cmd_add(args):
    devs = load_devices()
    token, name = args.token, (args.name or args.token)
    if not re.match(r"^B03-\d+$", token):
        log(f"令牌格式不对，应为 B03-<数字>，收到 {token}")
        return
    for d in devs:
        if d["token"] == token:
            d["name"] = name
            save_devices(devs)
            log(f"已更新 {token} → {name}")
            return
    devs.append({"token": token, "name": name})
    save_devices(devs)
    log(f"已添加 {token} → {name}（共 {len(devs)} 个）")


def cmd_remove(args):
    devs = [d for d in load_devices() if d["token"] != args.token]
    save_devices(devs)
    log(f"已移除 {args.token}（剩余 {len(devs)} 个）")


async def cmd_discover(args):
    from bleak import BleakScanner
    log(f"扫描 {args.timeout}s …")
    found = await BleakScanner.discover(timeout=args.timeout, return_adv=True)
    configured = {d["token"] for d in load_devices()}
    rows = []
    for d, a in found.values():
        n = d.name or a.local_name or ""
        if n.startswith("B03-"):
            rows.append((a.rssi, n, d.address))
    rows.sort(key=lambda r: -(r[0] or -999))
    print(f"\n可达 {len(rows)} 台：\n")
    print(f"{'RSSI':>5}  {'令牌':<12} {'已配置':<8} 地址")
    for rssi, n, addr in rows:
        mark = "✓" if n in configured else ""
        print(f"{rssi:>5}  {n:<12} {mark:<8} {addr}")
    print("\nRSSI > -80 可稳定连接；< -90 基本不可用。")


async def cmd_status(args):
    devs = pick_devices(args)
    for d in devs:
        tok = d["token"]
        name = d.get("name", "")
        if args.all:
            print(f"\n{'─'*46}\n【{name}】{tok}")
        st = await talk(tok)
        print()
        print(describe(st))
        if not st:
            log("未取到状态", tag=tok)


async def cmd_recover(args):
    devs = pick_devices(args)
    ok = 0
    for d in devs:
        tok, name = d["token"], d.get("name", "")
        print(f"\n{'─'*46}\n【{name}】{tok}")
        st = await talk(tok)
        if st:
            print(describe(st))
            if st.get(24) == "Y":
                ok += 1
                log("已通电 ✓", tag=tok)
            else:
                log("开关未打开，可能被服务端策略限制", tag=tok)
        else:
            log("失败", tag=tok)
    if args.all:
        log(f"完成：{ok}/{len(devs)} 台正常")


async def cmd_watch(args):
    devs = pick_devices(args)
    # 安全护栏：轮询间隔不能低于写入阈值，否则每轮都会真写设备
    if args.interval < MIN_WRITE_GAP:
        log(f"⚠ 间隔 {args.interval:.0f}s 低于安全阈值 {MIN_WRITE_GAP:.0f}s，已自动抬高")
        args.interval = MIN_WRITE_GAP

    if not args.quiet_start:
        if not confirm_watch(args.interval, MIN_WRITE_GAP, len(devs), getattr(args, "yes", False)):
            return
        print()

    log(f"守护 {len(devs)} 台设备，每 {args.interval:.0f}s 一轮（写入间隔 ≥{MIN_WRITE_GAP:.0f}s）：")
    for d in devs:
        print(f"   {d['token']}  {d.get('name','')}")
    while True:
        for d in devs:
            tok = d["token"]
            st = await talk(tok, quiet=True, wait=8)
            if not st:
                log("连不上（超范围或占用）", tag=tok)
                continue
            on = st.get(24) == "Y"
            log(f"开关 {'开' if on else '关'}  电压{st.get(6)}V 电流{st.get(7)}A", tag=tok)
            if not on:
                log("检测到断电，执行复电 …", tag=tok)
                st2 = await talk(tok, quiet=False, wait=12)
                if st2 and st2.get(24) == "Y":
                    log("复电成功 ✓", tag=tok)
                else:
                    log("复电未确认，下轮重试", tag=tok)
        await asyncio.sleep(args.interval)


def main():
    ap = argparse.ArgumentParser(description="JK-2 多宿舍复电客户端")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("rooms", help="列出已配置宿舍")

    a = sub.add_parser("add", help="添加宿舍")
    a.add_argument("token", help="B03-<房间号>")
    a.add_argument("name", nargs="?", help="备注名")
    r = sub.add_parser("remove", help="移除宿舍")
    r.add_argument("token")

    dc = sub.add_parser("discover", help="扫描周边所有 JK-2")
    dc.add_argument("--timeout", type=float, default=10.0)

    for nm, hlp in [("status", "读状态"), ("recover", "复电"), ("watch", "常驻守护")]:
        p = sub.add_parser(nm, help=hlp)
        p.add_argument("--token", help="指定单个")
        p.add_argument("--all", action="store_true", help="全部")
        if nm == "watch":
            p.add_argument("--interval", type=float, default=600.0)
            p.add_argument("--yes", action="store_true", help="跳过风险确认")
            p.add_argument("--quiet-start", action="store_true", help="不打印风险提示（供后台服务使用）")
        if nm in ("status", "recover"):
            p.add_argument("--wait", type=float, default=12.0)

    args = ap.parse_args()
    table = {
        "rooms": lambda a: cmd_rooms(a),
        "add": lambda a: cmd_add(a),
        "remove": lambda a: cmd_remove(a),
        "discover": lambda a: asyncio.run(cmd_discover(a)),
        "status": lambda a: asyncio.run(cmd_status(a)),
        "recover": lambda a: asyncio.run(cmd_recover(a)),
        "watch": lambda a: asyncio.run(cmd_watch(a)),
    }
    try:
        table[args.cmd](args)
    except KeyboardInterrupt:
        log("退出")


if __name__ == "__main__":
    main()
