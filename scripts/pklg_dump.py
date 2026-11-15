#!/usr/bin/env python3
"""
pklg（Apple PacketLogger）解析器 —— 打印记录类型分布与 ACL 概览。

格式（逆向所得）：
    [4 字节] totalLen（含 8 字节时间戳，不含本字段自身）
              → 整条记录占 4 + totalLen 字节
    [8 字节] 时间戳：int32 LE 秒 + int32 LE 小数部分（单位实测像微秒）
              基准未完全确认（按 Unix 秒解释比抓包日期早约 4 周，
              按 CFAbsoluteTime 解释则晚到 2057 年）→ 脚本默认打相对时间
    [totalLen-8 字节] 数据

数据首字节：
    0x01 HCI 命令 / 0x02 ACL 数据 / 0x04 HCI 事件 / 0xfc 文本日志

用法：
    python3 scripts/pklg_dump.py private/captures/jk-2蓝牙包.pklg
    python3 scripts/pklg_dump.py <file.pklg> --hex        # 额外打印 payload 前 32 字节
    python3 scripts/pklg_dump.py <file.pklg> --l2cap      # 做 L2CAP 重组并列出 ATT 写
"""
from __future__ import annotations

import struct
import sys
KIND = {0x01: "HCI_CMD", 0x02: "ACL", 0x04: "HCI_EVT", 0xFC: "LOG"}

ATT_OP = {
    0x08: "ReadByTypeReq", 0x09: "ReadByTypeRsp",
    0x0A: "ReadReq", 0x0B: "ReadRsp",
    0x10: "ReadByGroupReq", 0x11: "ReadByGroupRsp",
    0x12: "WriteReq", 0x13: "WriteRsp",
    0x1B: "Notify", 0x1D: "Indicate", 0x1E: "Confirm",
    0x52: "WriteCmd",
}


def records(path: str):
    """yield (秒, 微秒, payload)。"""
    with open(path, "rb") as f:
        raw = f.read()
    off = 0
    while off + 12 <= len(raw):
        total = int.from_bytes(raw[off:off + 4], "little")
        # total 不含自身 4 字节长度字段：整条记录占 4 + total 字节
        end = off + 4 + total
        if total < 8 or end > len(raw):
            break
        sec = int.from_bytes(raw[off + 4:off + 8], "little", signed=True)
        usec = int.from_bytes(raw[off + 8:off + 12], "little", signed=True)
        yield sec, usec, raw[off + 12:end]
        off = end


def split_acl(payload: bytes):
    """返回 (handle, pb, data)；payload 首字节为 0x02。"""
    body = payload[1:]
    if len(body) < 4:
        return None
    hdr = int.from_bytes(body[0:2], "little")
    handle = hdr & 0x0FFF
    pb = (hdr >> 12) & 0x3
    plen = int.from_bytes(body[2:4], "little")
    return handle, pb, body[4:4 + plen]


def reassemble(frags):
    """[(handle, pb, data)] → [(cid, payload)]，按 L2CAP 长度重组。"""
    out, buf, need, cid = [], bytearray(), 0, None
    for _handle, pb, data in frags:
        if pb in (0b10, 0b00):
            if len(data) < 4:
                continue
            need = int.from_bytes(data[0:2], "little")
            cid = int.from_bytes(data[2:4], "little")
            buf = bytearray(data[4:])
        elif pb == 0b01 and cid is not None:
            buf += data
        else:
            continue
        if need and len(buf) >= need:
            out.append((cid, bytes(buf[:need])))
            buf, need, cid = bytearray(), 0, None
    return out


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    path = argv[1]
    show_hex = "--hex" in argv
    show_l2cap = "--l2cap" in argv

    stat: dict[int, int] = {}
    acl_frags = []
    base = None
    for sec, usec, payload in records(path):
        if not payload:
            continue
        kind = payload[0]
        if kind == 0x02 and base is None:      # 以首个 ACL 为时间零点
            base = (sec, usec)
        stat[kind] = stat.get(kind, 0) + 1
        if kind == 0x02:
            r = split_acl(payload)
            if r:
                rel = (sec - base[0]) + (usec - base[1]) / 1e6
                acl_frags.append(r + (rel,))

    print(f"文件: {path}")
    print("记录类型分布:", {KIND.get(k, hex(k)): v for k, v in sorted(stat.items())})
    print(f"总记录: {sum(stat.values())}  ACL 分片: {len(acl_frags)}")

    if acl_frags:
        print("\nACL 分片（前 40 条）:")
        for handle, pb, data, rel in acl_frags[:40]:
            extra = f"  {data[:32].hex(' ')}{' …' if len(data) > 32 else ''}" if (show_hex or pb in (0b10, 0b00)) else ""
            print(f"  +{rel:8.3f}s handle=0x{handle:04x} pb={pb} len={len(data)}{extra}")

    if show_l2cap:
        pdus = reassemble([(h, pb, d) for h, pb, d, _rel in acl_frags])
        print(f"\nL2CAP PDU: {len(pdus)} 个")
        for cid, body in pdus:
            if cid != 0x0004 or not body:
                print(f"  cid=0x{cid:04x} len={len(body)}")
                continue
            op = body[0]
            name = ATT_OP.get(op, f"0x{op:02x}")
            if op in (0x12, 0x52) and len(body) >= 3:
                handle = int.from_bytes(body[1:3], "little")
                val = body[3:]
                text = val.decode("utf-8", "replace")
                print(f"  ATT {name:15s} handle=0x{handle:04x} len={len(val)}  {text[:60]!r}")
            else:
                print(f"  ATT {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
