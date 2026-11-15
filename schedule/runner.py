#!/usr/bin/env python3
"""
定时复电调度器 —— 比 launchd 更灵活（可写"每天几点""工作日""随机抖动"）

用法：
  python3 schedule/runner.py add --at 07:00 --room 301
  python3 schedule/runner.py add --at 07:00 --cron weekday
  python3 schedule/runner.py list
  python3 schedule/runner.py remove 1
  python3 schedule/runner.py daemon           # 前台常驻
  python3 schedule/runner.py run-once 1       # 立刻跑一次某条

调度表存 schedule/tasks.json：
  [{ "id":1, "at":"07:00", "days":[1,2,3,4,5], "room":"301", "jitter":600, "lastRun":"..." }]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timedelta, time as dtime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Path(os.environ.get("PRIVATE_DIR", ROOT / "private"))
TASKS = PRIVATE / "schedule" / "tasks.json"
LOG = PRIVATE / "logs" / "schedule.log"
RECOVER = ROOT / "client" / "recover.mjs"

WEEKDAY = [1, 2, 3, 4, 5]
ALLDAYS = [1, 2, 3, 4, 5, 6, 7]


def log(*a):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{datetime.now().isoformat(timespec='seconds')}] " + " ".join(str(x) for x in a)
    print(line, flush=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def load():
    if not TASKS.exists():
        return []
    try:
        return json.loads(TASKS.read_text())
    except Exception:
        return []


def save(tasks):
    TASKS.parent.mkdir(parents=True, exist_ok=True)
    TASKS.write_text(json.dumps(tasks, ensure_ascii=False, indent=2))


def parse_days(s: str):
    s = s.strip().lower()
    if s == "weekday":
        return WEEKDAY
    if s in ("all", "everyday", "每天"):
        return ALLDAYS
    if s == "weekend":
        return [6, 7]
    out = []
    for p in s.split(","):
        p = p.strip()
        if not p:
            continue
        n = int(p)
        if not 1 <= n <= 7:
            raise ValueError(f"星期取值 1-7，收到 {n}")
        out.append(n)
    return out or ALLDAYS


def next_fire(task: dict, now: datetime | None = None) -> datetime:
    now = now or datetime.now()
    hh, mm = (int(x) for x in task["at"].split(":"))
    for delta in range(0, 9):
        d = now.date() + timedelta(days=delta)
        if d.isoweekday() not in task.get("days", ALLDAYS):
            continue
        cand = datetime.combine(d, dtime(hh, mm))
        if cand > now:
            return cand + timedelta(seconds=task.get("jitter", 0) and random.randint(0, task["jitter"]) or 0)
    return now + timedelta(days=1)


def run_task(task: dict):
    log(f"执行任务 #{task['id']} room={task.get('room')} at={task['at']}")
    import os
    env = dict(os.environ)
    env["RECOVER_CFG"] = env.get("RECOVER_CFG", str(PRIVATE / "config" / "config.json"))
    try:
        p = subprocess.run(
            ["node", str(RECOVER), "--room", str(task.get("room", "301"))],
            capture_output=True, text=True, timeout=180, cwd=str(ROOT), env=env,
        )
        tail = ((p.stdout or "") + (p.stderr or "")).strip().splitlines()[-4:]
        for line in tail:
            log("  " + line)
        ok = p.returncode == 0
    except subprocess.TimeoutExpired:
        log("  超时")
        ok = False
    task["lastRun"] = datetime.now().isoformat(timespec="seconds")
    task["lastOk"] = ok
    return ok


def cmd_add(args):
    tasks = load()
    tid = (max([t["id"] for t in tasks], default=0)) + 1
    t = {
        "id": tid,
        "at": args.at,
        "days": parse_days(args.cron),
        "room": args.room,
        "jitter": args.jitter,
        "enabled": True,
        "created": datetime.now().isoformat(timespec="seconds"),
    }
    tasks.append(t)
    save(tasks)
    log(f"已添加 #{tid} {t['at']} days={t['days']} room={t['room']} jitter={t['jitter']}s")
    nxt = next_fire(t)
    log(f"下次执行: {nxt.isoformat(timespec='seconds')}")


def cmd_list(args):
    tasks = load()
    if not tasks:
        print("暂无定时任务。添加：python3 schedule/runner.py add --at 07:00 --room 301")
        return
    print(f"{'ID':>3} {'时间':>6} {'星期':<16} {'房间':>5} {'抖动':>6} {'状态':<6} 下次执行")
    for t in tasks:
        nxt = next_fire(t) if t.get("enabled", True) else "-"
        days = ",".join(str(d) for d in t["days"])
        print(f"{t['id']:>3} {t['at']:>6} {days:<16} {str(t.get('room')):>5} "
              f"{t.get('jitter', 0):>5}s {'启用' if t.get('enabled', True) else '停用':<6} {nxt if nxt == '-' else nxt.strftime('%m-%d %H:%M')}")


def cmd_remove(args):
    tasks = load()
    before = len(tasks)
    tasks = [t for t in tasks if t["id"] != args.id]
    save(tasks)
    log(f"删除 #{args.id}: {'成功' if len(tasks) < before else '未找到'}")


def cmd_toggle(args):
    tasks = load()
    for t in tasks:
        if t["id"] == args.id:
            t["enabled"] = not t.get("enabled", True)
            log(f"#{args.id} → {'启用' if t['enabled'] else '停用'}")
            break
    save(tasks)


def cmd_run_once(args):
    tasks = load()
    for t in tasks:
        if t["id"] == args.id:
            ok = run_task(t)
            save(tasks)
            sys.exit(0 if ok else 2)
    log(f"未找到任务 #{args.id}")
    sys.exit(1)


def cmd_daemon(args):
    log("调度器启动。Ctrl-C 退出。")
    while True:
        tasks = load()
        now = datetime.now()
        nearest = None
        for t in tasks:
            if not t.get("enabled", True):
                continue
            nxt = next_fire(t, now)
            if nearest is None or nxt < nearest[0]:
                nearest = (nxt, t)
        if nearest is None:
            time.sleep(30)
            continue
        nxt, task = nearest
        wait = (nxt - datetime.now()).total_seconds()
        if wait > 0:
            log(f"待执行 #{task['id']} @ {nxt.strftime('%m-%d %H:%M:%S')}（{int(wait)}s 后）")
            time.sleep(min(wait, 60))
            if wait > 60:
                continue
        run_task(task)
        save(tasks)
        time.sleep(2)


def main():
    ap = argparse.ArgumentParser(description="定时复电调度器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add")
    a.add_argument("--at", required=True, help="HH:MM")
    a.add_argument("--room", default="301")
    a.add_argument("--cron", default="all", help="all|weekday|weekend|1,2,3")
    a.add_argument("--jitter", type=int, default=0, help="随机延迟上限秒")

    sub.add_parser("list")

    r = sub.add_parser("remove"); r.add_argument("id", type=int)
    tg = sub.add_parser("toggle"); tg.add_argument("id", type=int)
    ro = sub.add_parser("run-once"); ro.add_argument("id", type=int)
    sub.add_parser("daemon")

    args = ap.parse_args()
    m = {"add": cmd_add, "list": cmd_list, "remove": cmd_remove,
         "toggle": cmd_toggle, "run-once": cmd_run_once, "daemon": cmd_daemon}
    m[args.cmd](args)


if __name__ == "__main__":
    main()
