#!/usr/bin/env python3
"""
Mac 蓝牙触发复电 —— 三种玩法，按需组合

模式 A  presence（教学楼/回宿舍自动）：扫描 BLE 信号，你的 iPhone/手环/耳机 RSSI 超过阈值
        → 判定"人到了" → 调 client/recover.mjs
模式 B  beacon（贴一张 iBeacon 在门口/冰箱上）：检测到指定 UUID/Major 就触发
模式 C  button（蓝牙遥控器/智能按钮当实体开关）：监听指定设备的按键通知，按一下复电一次
模式 D  gatt（如果宿舍电控本身就是 BLE 设备，小程序里出现过 createBLEConnection）：
        直接用 bleak 连上去写 characteristic，绕开服务器

用法：
  python3 ble/trigger.py scan                    # 扫描周边 BLE，找你的设备
  python3 ble/trigger.py presence --name iPhone --rssi -65
  python3 ble/trigger.py beacon --uuid <UUID> --major 1
  python3 ble/trigger.py button --address <MAC>
  python3 ble/trigger.py gatt --address <MAC> --char <UUID> --payload 01
  python3 ble/trigger.py list-services --address <MAC>
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Path(os.environ.get("PRIVATE_DIR", ROOT / "private"))
LOG = PRIVATE / "logs" / "ble.log"
RECOVER = ROOT / "client" / "recover.mjs"


def log(*a):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{datetime.now().isoformat(timespec='seconds')}] " + " ".join(str(x) for x in a)
    print(line, flush=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def fire_reason(reason: str, cooldown_note: str = "") -> bool:
    """触发一次复电，返回是否成功。带节流，避免反复刷接口。"""
    stamp = PRIVATE / "trigger" / ".trigger_state.json"
    stamp.parent.mkdir(parents=True, exist_ok=True)
    st = {}
    if stamp.exists():
        try:
            st = json.loads(stamp.read_text())
        except Exception:
            st = {}
    last = st.get("last_fire", 0)
    cooldown = int(os.environ.get("TRIGGER_COOLDOWN", "90"))
    if time.time() - last < cooldown:
        log(f"节流中，距上次触发 {int(time.time() - last)}s < {cooldown}s，跳过")
        return False

    log(f"触发复电：{reason} {cooldown_note}")
    try:
        env = dict(os.environ)
        cfg = env.get("RECOVER_CFG", str(PRIVATE / "config" / "config.json"))
        env["RECOVER_CFG"] = cfg
        p = subprocess.run(
            ["node", str(RECOVER), "--room", env.get("ROOM_NO", "301")],
            capture_output=True, text=True, timeout=120, env=env, cwd=str(ROOT),
        )
        out = (p.stdout or "") + (p.stderr or "")
        for line in out.strip().splitlines()[-6:]:
            log("  " + line)
        ok = p.returncode == 0
        if ok:
            st["last_fire"] = time.time()
            st["last_reason"] = reason
            st["last_ok"] = True
            stamp.write_text(json.dumps(st, indent=2))
        else:
            st["last_ok"] = False
        stamp.write_text(json.dumps(st, indent=2))
        return ok
    except subprocess.TimeoutExpired:
        log("  调用超时")
        return False
    except Exception as e:
        log("  调用失败:", e)
        return False


async def cmd_scan(args):
    from bleak import BleakScanner

    log(f"扫描 BLE {args.timeout}s …")
    found = await BleakScanner.discover(timeout=args.timeout, return_adv=True)
    rows = []
    for dev, adv in found.values():
        rows.append({
            "name": dev.name or adv.local_name or "",
            "address": dev.address,
            "rssi": adv.rssi,
            "service_uuids": adv.service_uuids,
            "manufacturer_data": {k: v.hex() for k, v in (adv.manufacturer_data or {}).items()},
        })
    rows.sort(key=lambda r: -(r["rssi"] or -999))
    print(f"\n找到 {len(rows)} 个设备：")
    print(f"{'RSSI':>5}  {'名称':<22} {'地址':<38} UUID")
    for r in rows:
        print(f"{r['rssi']:>5}  {(r['name'] or '-')[:22]:<22} {r['address']:<38} {','.join(u[:8] for u in r['service_uuids'])}")
    print("\n提示：Apple 设备地址是随机私有 MAC，用 --name 匹配更稳。")
    return rows


async def cmd_presence(args):
    from bleak import BleakScanner

    log(f"presence 模式：等待 '{args.name}' 进入 RSSI>{args.rssi} dBm（{args.hold}s 持续）")
    consecutive = 0
    t0 = time.time()

    def cb(dev, adv):
        nonlocal consecutive
        name = dev.name or adv.local_name or ""
        if args.name and args.name.lower() not in name.lower() and args.address not in dev.address:
            return
        if adv.rssi is None or adv.rssi < args.rssi:
            consecutive = 0
            return
        consecutive += 1
        log(f"  检测到 {name or dev.address} RSSI={adv.rssi} 连续={consecutive}")
        if consecutive >= max(1, args.hold):
            consecutive = 0
            fire_reason(f"presence:{name or dev.address} rssi={adv.rssi}")

    async with BleakScanner(detection_callback=cb):
        while True:
            await asyncio.sleep(args.duration if args.duration else 3600)
            if args.duration:
                log("presence 单轮结束")
                break


async def cmd_beacon(args):
    from bleak import BleakScanner

    want_uuid = args.uuid.lower().replace("-", "")
    log(f"beacon 模式：等待 UUID={args.uuid} major={args.major if args.major is not None else '*'}")

    def cb(dev, adv):
        # iBeacon 通常在 manufacturer_data[0x004C] 里，格式: 02 15 + uuid(16) + major(2) + minor(2) + tx
        for cid, data in (adv.manufacturer_data or {}).items():
            if cid != 0x004C or len(data) < 23:
                continue
            if data[0] != 0x02 or data[1] != 0x15:
                continue
            uuid = data[2:18].hex()
            major = int.from_bytes(data[18:20], "big")
            minor = int.from_bytes(data[20:22], "big")
            if uuid == want_uuid and (args.major is None or major == args.major):
                log(f"  命中 beacon {dev.address} major={major} minor={minor} rssi={adv.rssi}")
                fire_reason(f"ibeacon:{uuid[:8]}/{major}")
                return
        # 兼容用 service UUID 广播的私有 beacon
        for u in adv.service_uuids or []:
            if u.lower().replace("-", "").startswith(want_uuid[:8]):
                log(f"  service UUID 命中 {u} rssi={adv.rssi}")
                fire_reason(f"service-uuid:{u[:8]}")

    async with BleakScanner(detection_callback=cb):
        while True:
            await asyncio.sleep(3600)


async def cmd_button(args):
    from bleak import BleakClient

    log(f"button 模式：连接 {args.address}")
    async with BleakClient(args.address, timeout=20) as client:
        log("  已连接，枚举服务")
        target = None
        for svc in client.services:
            for ch in svc.characteristics:
                props = ch.properties
                log(f"    {svc.uuid}  {ch.uuid}  {props}")
                if "notify" in props or "indicate" in props:
                    if args.char is None or ch.uuid.lower().startswith(args.char.lower()):
                        target = ch
        if target is None:
            log("  找不到可 notify 的特征，用 list-services 手动挑一个 --char")
            return
        log(f"  订阅 {target.uuid}")

        def on_notify(_h, data: bytearray):
            log(f"  收到通知 {data.hex()}")
            # 按键设备一般按一下发 0x01 或 0x0100
            if data and any(b != 0 for b in data):
                fire_reason(f"button:{args.address} data={data.hex()}")

        await client.start_notify(target, on_notify)
        log("  监听中（Ctrl-C 退出）")
        while True:
            await asyncio.sleep(1)
            if not client.is_connected:
                log("  连接断开，退出")
                return


async def cmd_list_services(args):
    from bleak import BleakClient

    async with BleakClient(args.address, timeout=20) as c:
        print(f"设备 {args.address}  已连接={c.is_connected}")
        for svc in c.services:
            print(f"\n[service] {svc.uuid}  {svc.description}")
            for ch in svc.characteristics:
                print(f"  [char] {ch.uuid}  props={ch.properties}")
        await asyncio.sleep(0.2)


async def cmd_gatt(args):
    from bleak import BleakClient

    payload = bytes.fromhex(args.payload.replace(" ", ""))
    log(f"gatt 写入 {args.address} char={args.char} payload={payload.hex()}")
    async with BleakClient(args.address, timeout=20) as c:
        await c.write_gatt_char(args.char, payload, response=not args.no_response)
        log("  写入完成")
        if args.read_after:
            v = await c.read_gatt_char(args.char)
            log("  回读:", v.hex())
        await asyncio.sleep(0.3)


def main():
    ap = argparse.ArgumentParser(description="Mac BLE 触发复电")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="扫描周边 BLE 设备")
    s.add_argument("--timeout", type=float, default=8.0)

    p = sub.add_parser("presence", help="设备靠近即复电")
    p.add_argument("--name", default=os.environ.get("BLE_NAME", "iPhone"))
    p.add_argument("--address", default="")
    p.add_argument("--rssi", type=int, default=-65)
    p.add_argument("--hold", type=int, default=2, help="连续命中次数")
    p.add_argument("--duration", type=float, default=0, help="单轮秒数，0=常驻")

    b = sub.add_parser("beacon", help="iBeacon 触发")
    b.add_argument("--uuid", required=True)
    b.add_argument("--major", type=int, default=None)

    btn = sub.add_parser("button", help="BLE 按键触发")
    btn.add_argument("--address", required=True)
    btn.add_argument("--char", default=None)

    ls = sub.add_parser("list-services", help="枚举 GATT")
    ls.add_argument("--address", required=True)

    g = sub.add_parser("gatt", help="直接写 GATT 控电")
    g.add_argument("--address", required=True)
    g.add_argument("--char", required=True)
    g.add_argument("--payload", required=True, help="hex，例如 01 / 0a0b")
    g.add_argument("--no-response", action="store_true")
    g.add_argument("--read-after", action="store_true")

    args = ap.parse_args()
    fn = {
        "scan": cmd_scan, "presence": cmd_presence, "beacon": cmd_beacon,
        "button": cmd_button, "list-services": cmd_list_services, "gatt": cmd_gatt,
    }[args.cmd]
    try:
        asyncio.run(fn(args))
    except KeyboardInterrupt:
        log("已退出")


if __name__ == "__main__":
    main()
