#!/usr/bin/env python3
"""
JK-2 用电监控器 BLE 探针 / 重放工具

设备实测档案（2026-11-15）：
  型号    DX-smart DX-BT24（蓝牙串口透传模块）
  名称    B03-xxxx（房间号即设备名）
  服务    0000ffe0-0000-1000-8000-00805f9b34fb  (Vendor specific)
  特征    0000ffe1  read + write + notify + write-no-response   ← 数据通道
          0000ffe2  write only
  MAC     macOS 上是随机私有地址，每次扫描会变，按名字匹配

已确认：
  - 写入 ffe1 成功，设备接受任意字节
  - read ffe1 返回的是「最后写入的内容」（回显），不是设备响应
  - 设备真实响应走 notify
  - 收到过设备应答: fw_title:POWER02,fw_version:B03.08

用法：
  python3 ble/probe.py scan
  python3 ble/probe.py info                            # 枚举 GATT
  python3 ble/probe.py listen  --seconds 20            # 只监听通知
  python3 ble/probe.py send    --hex 0103030000000944  # 发一帧
  python3 ble/probe.py send    --ascii "D1:2026,..."
  python3 ble/probe.py replay  --file frames.txt       # 逐行重放
  python3 ble/probe.py brute   --start 0 --end 40      # 扫描 Modbus 寄存器（试探）
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
from datetime import datetime

SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
CHAR_DATA = "0000ffe1-0000-1000-8000-00805f9b34fb"
CHAR_ALT = "0000ffe2-0000-1000-8000-00805f9b34fb"
DEFAULT_NAME = os.environ.get("DEV_TOKEN", "JK-2")


def log(*a):
    print(f"[{datetime.now().strftime('%H:%M:%S')}]", *a, flush=True)


async def find_device(name: str, timeout: float = 10.0):
    from bleak import BleakScanner
    log(f"扫描 {name} …")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    hits = []
    for dev, adv in found.values():
        n = dev.name or adv.local_name or ""
        if name.lower() in n.lower():
            hits.append((dev, adv))
    if not hits:
        log(f"未找到 {name!r}；周边 B03 设备：")
        for dev, adv in found.values():
            n = dev.name or ""
            if "B03" in n:
                log(f"   {n}  {dev.address}  RSSI={adv.rssi}")
        return None
    hits.sort(key=lambda x: -(x[1].rssi or -999))
    dev, adv = hits[0]
    log(f"命中 {dev.name}  addr={dev.address}  RSSI={adv.rssi}")
    return dev


async def cmd_scan(args):
    from bleak import BleakScanner
    found = await BleakScanner.discover(timeout=args.timeout, return_adv=True)
    rows = []
    for dev, adv in found.values():
        n = dev.name or adv.local_name or ""
        if not args.all and "B03" not in n:
            continue
        rows.append((adv.rssi, n, dev.address, adv.service_uuids))
    rows.sort(key=lambda r: -(r[0] or -999))
    print(f"{'RSSI':>5}  {'名称':<16} {'地址':<40} UUID")
    for rssi, n, addr, uu in rows:
        print(f"{rssi:>5}  {n[:16]:<16} {addr:<40} {','.join(u[:8] for u in uu)}")


async def cmd_info(args):
    from bleak import BleakClient
    dev = await find_device(args.name, args.timeout)
    if not dev:
        return
    async with BleakClient(dev.address, timeout=25) as c:
        log("已连接:", c.is_connected)
        for s in c.services:
            print(f"  [service] {s.uuid}  {s.description}")
            for ch in s.characteristics:
                print(f"     [char] {ch.uuid}  props={ch.properties}")
        for s in c.services:
            for ch in s.characteristics:
                if "read" in ch.properties:
                    try:
                        v = await c.read_gatt_char(ch)
                        txt = bytes(v).decode("utf-8", "replace")
                        print(f"  READ {ch.uuid} = {bytes(v).hex()}  {txt!r}")
                    except Exception as e:
                        print(f"  READ {ch.uuid} 失败: {e}")


async def cmd_listen(args):
    from bleak import BleakClient
    dev = await find_device(args.name, args.timeout)
    if not dev:
        return
    async with BleakClient(dev.address, timeout=25) as c:
        def on_n(_h, d: bytearray):
            b = bytes(d)
            log(f"← notify {len(b)}B  hex={b.hex()}")
            log(f"          ascii={b.decode('utf-8','replace')!r}")
        await c.start_notify(CHAR_DATA, on_n)
        log(f"已订阅，监听 {args.seconds}s …")
        await asyncio.sleep(args.seconds)


async def cmd_send(args):
    from bleak import BleakClient
    dev = await find_device(args.name, args.timeout)
    if not dev:
        return
    if args.hex:
        payload = bytes.fromhex(args.hex.replace(" ", ""))
    elif args.ascii:
        payload = args.ascii.encode()
    else:
        log("需要 --hex 或 --ascii")
        return
    async with BleakClient(dev.address, timeout=25) as c:
        got = []
        def on_n(_h, d: bytearray):
            got.append(bytes(d))
            log(f"← {bytes(d).hex()}  {bytes(d).decode('utf-8','replace')!r}")
        await c.start_notify(CHAR_DATA, on_n)
        log(f"→ 发送 {len(payload)}B  hex={payload.hex()}")
        try:
            await c.write_gatt_char(CHAR_DATA, payload, response=not args.no_response)
        except Exception as e:
            log("写入异常:", e)
            return
        await asyncio.sleep(args.wait)
        log(f"收到 {len(got)} 条通知")


async def cmd_replay(args):
    from bleak import BleakClient
    lines = []
    with open(args.file) as f:
        for ln in f:
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            delay = 0.0
            m = re.match(r"^(.+?)\s*(?:#\s*sleep=([\d.]+))?$", ln)
            body = m.group(1).strip()
            if m.group(2):
                delay = float(m.group(2))
            if body.startswith("ascii:"):
                lines.append((body[6:].encode(), delay))
            else:
                lines.append((bytes.fromhex(body.replace(" ", "")), delay))
    log(f"共 {len(lines)} 帧待重放")
    dev = await find_device(args.name, args.timeout)
    if not dev:
        return
    async with BleakClient(dev.address, timeout=25) as c:
        def on_n(_h, d: bytearray):
            log(f"← {bytes(d).hex()}")
        await c.start_notify(CHAR_DATA, on_n)
        for i, (payload, delay) in enumerate(lines, 1):
            log(f"→ #{i} {len(payload)}B {payload.hex()[:80]}")
            await c.write_gatt_char(CHAR_DATA, payload, response=False)
            await asyncio.sleep(delay or args.interval)


def crc16_modbus(data: bytes) -> bytes:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return bytes([crc & 0xFF, (crc >> 8) & 0xFF])


async def cmd_brute(args):
    """按 Modbus 读保持寄存器(0x03)逐个探测，看设备对哪个地址有响应"""
    from bleak import BleakClient
    dev = await find_device(args.name, args.timeout)
    if not dev:
        return
    async with BleakClient(dev.address, timeout=25) as c:
        got = []
        def on_n(_h, d: bytearray):
            got.append(bytes(d))
        await c.start_notify(CHAR_DATA, on_n)
        for reg in range(args.start, args.end, args.step):
            body = bytes([args.slave, 0x03, (reg >> 8) & 0xFF, reg & 0xFF, 0x00, 0x01])
            frame = body + crc16_modbus(body)
            n_before = len(got)
            try:
                await c.write_gatt_char(CHAR_DATA, frame, response=False)
            except Exception as e:
                log(f"reg {reg} 写入失败 {e}")
                continue
            await asyncio.sleep(args.interval)
            if len(got) > n_before:
                log(f"reg { hex(reg) } 有响应: {got[-1].hex()}  {got[-1]!r}")
            if args.verbose:
                log(f"reg {hex(reg)} 无响应")


def main():
    ap = argparse.ArgumentParser(description="JK-2 用电监控器 BLE 探针")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common(p):
        p.add_argument("--name", default=DEFAULT_NAME)
        p.add_argument("--timeout", type=float, default=10.0)

    s = sub.add_parser("scan"); s.add_argument("--timeout", type=float, default=8.0); s.add_argument("--all", action="store_true")
    i = sub.add_parser("info"); add_common(i)
    l = sub.add_parser("listen"); add_common(l); l.add_argument("--seconds", type=float, default=20)
    sd = sub.add_parser("send"); add_common(sd)
    sd.add_argument("--hex"); sd.add_argument("--ascii")
    sd.add_argument("--no-response", action="store_true"); sd.add_argument("--wait", type=float, default=3.0)
    r = sub.add_parser("replay"); add_common(r); r.add_argument("--file", required=True); r.add_argument("--interval", type=float, default=0.3)
    b = sub.add_parser("brute"); add_common(b)
    b.add_argument("--start", type=lambda x: int(x, 0), default=0)
    b.add_argument("--end", type=lambda x: int(x, 0), default=64)
    b.add_argument("--step", type=int, default=1)
    b.add_argument("--slave", type=lambda x: int(x, 0), default=1)
    b.add_argument("--interval", type=float, default=0.25)
    b.add_argument("--verbose", action="store_true")

    args = ap.parse_args()
    fn = {"scan": cmd_scan, "info": cmd_info, "listen": cmd_listen,
          "send": cmd_send, "replay": cmd_replay, "brute": cmd_brute}[args.cmd]
    try:
        asyncio.run(fn(args))
    except KeyboardInterrupt:
        log("退出")


if __name__ == "__main__":
    main()
