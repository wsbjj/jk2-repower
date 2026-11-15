#!/usr/bin/env python3
"""
盯住设备（DEV_TOKEN）的电压，来电了立刻告诉你

用途：设备进故障态（13:24，电压 0）时，去配电箱操作，
      这个脚本帮你确认电到底回来没有。

用法：
  python3 ble/wait_power.py              # 每 20 秒查一次
  python3 ble/wait_power.py --interval 10
  python3 ble/wait_power.py --recover    # 来电后自动复电
  python3 ble/wait_power.py --once       # 只查一次
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime

TOKEN = os.environ.get("DEV_TOKEN", "")
CH = "0000ffe1-0000-1000-8000-00805f9b34fb"
BASE = os.environ.get("JK2_BASE", "https://thingsboard.example.com:8080")


def log(*a):
    print(f"[{datetime.now().strftime('%H:%M:%S')}]", *a, flush=True)


def rpc(method):
    req = urllib.request.Request(
        f"{BASE}/api/v1/{TOKEN}/rpc",
        data=json.dumps({"method": method, "params": {"temperature": "25"}}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def parse(t):
    d = {}
    for p in t.split(","):
        if ":" in p:
            k, v = p.split(":", 1)
            if k.isdigit():
                d[int(k)] = v
    return d


async def query():
    """连一次设备，取状态。返回 dict 或 None"""
    from bleak import BleakScanner, BleakClient

    found = await BleakScanner.discover(timeout=8, return_adv=True)
    addr = next((d.address for d, a in found.values()
                 if (d.name or a.local_name or "") == TOKEN), None)
    if not addr:
        return {"_err": "扫描不到设备"}

    try:
        enc = rpc("getCurrentRPCStr_B03.08")
        payload = json.dumps(enc, separators=(",", ":"))
        cfg = rpc("getCurrentRPCStr")
    except Exception as e:
        return {"_err": f"云端失败: {e}"}

    try:
        async with BleakClient(addr, timeout=25) as c:
            notes = []
            await c.start_notify(CH, lambda h, d: notes.append(bytes(d)))
            await asyncio.sleep(0.6)
            for s in (cfg, payload):
                b = s.encode()
                for i in range(0, len(b), 80):
                    await c.write_gatt_char(CH, b[i:i + 80], response=True)
                    await asyncio.sleep(0.1)
            st = None
            for _ in range(9):
                await asyncio.sleep(1)
                for n in notes:
                    t = n.decode("utf-8", "replace")
                    if "24:" in t:
                        st = parse(t)
                if st:
                    break
            return st or {"_err": "无状态回报"}
    except Exception as e:
        return {"_err": f"蓝牙失败: {e}"}


def _dwidth(t: str) -> int:
    import unicodedata
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in t)


def _box(lines, width=64):
    out = ["╔" + "═" * width + "╗"]
    for ln in lines:
        if ln == "---":
            out.append("╠" + "═" * width + "╣")
            continue
        out.append("║ " + ln + " " * max(0, width - 2 - _dwidth(ln)) + " ║")
    out.append("╚" + "═" * width + "╝")
    return "\n".join(out)


def watch_warning(interval: float) -> str:
    per_day = int(86400 / max(interval, 1))
    return "\n" + _box([
        "⚠  这个脚本会周期性向监控器写指令",
        "---",
        "已知风险：写入过频可能导致设备 RTC 异常（故障码 24），",
        "表现为电压/电流全 0、继电器锁死断开 —— 房间直接没电。",
        "",
        "恢复：拔掉 JK-2 电源等 10 秒再插上，或等 30 分钟。",
        "---",
        f"当前间隔 {interval:.0f} 秒 → 每天 {per_day} 次复电",
        f"每天 BLE 写包 {per_day * 4} 个（每次复电 4 包）",
        "对比：手动扫码一次 = 4 个写包。",
        "",
        "建议间隔 ≥ 600 秒，或只在需要时手动查。",
    ]) + "\n"


def beep(times=3):
    for _ in range(times):
        print("\a", end="", flush=True)


async def main_loop(args):
    import os
    gap_min = float(os.environ.get("JK2_MIN_WRITE_GAP", "600"))
    if args.interval < gap_min:
        log(f"⚠ 间隔 {args.interval:.0f}s 低于安全阈值 {gap_min:.0f}s，已自动抬高到 {gap_min:.0f}s")
        args.interval = gap_min
    print(watch_warning(args.interval))
    log(f"监控 {TOKEN}，每 {args.interval:.0f}s 一次。来电会提示。")
    log("（设备故障码 13 正常应为小数值；24 表示异常）")
    print()

    was_off = None
    seen_on = False

    while True:
        st = await query()

        if "_err" in st:
            log(f"✗ {st['_err']}")
        else:
            v = float(st.get(6, 0) or 0)
            a = float(st.get(7, 0) or 0)
            code = st.get(13, "?")
            on = v > 180

            if on:
                log(f"✓ 电压 {v:.1f}V  电流 {a:.3f}A  故障码 {code}  → 来电了")
                if not seen_on:
                    seen_on = True
                    beep()
                    log("★★ 电已恢复 ★★")
                    if args.recover:
                        log("自动执行复电 …")
                        subprocess.run(
                            [sys.executable, str(__file__).replace("wait_power.py", "jk2.py"),
                             "recover", "--token", TOKEN],
                            check=False,
                        )
                    if args.exit_on_power:
                        log("按 --exit-on-power 退出")
                        return
            else:
                log(f"· 电压 {v:.1f}V  电流 {a:.3f}A  故障码 {code}  → 仍无电")
                seen_on = False
                if was_off is None:
                    was_off = True

        if args.once:
            return
        await asyncio.sleep(args.interval)


def main():
    ap = argparse.ArgumentParser(description="监控设备电压")
    ap.add_argument("--interval", type=float, default=600.0)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--recover", action="store_true", help="来电后自动复电")
    ap.add_argument("--exit-on-power", action="store_true", help="来电后退出")
    args = ap.parse_args()

    try:
        asyncio.run(main_loop(args))
    except KeyboardInterrupt:
        log("退出")


if __name__ == "__main__":
    main()
