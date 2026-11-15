#!/usr/bin/env bash
# 统一入口
#   ./run.sh test          跑自测（26 项断言）
#   ./run.sh mock          起本地 mock 服务端
#   ./run.sh recover       真机复电一次
#   ./run.sh check         只查当前状态
#   ./run.sh dry           打印将调用的接口与签名（不发请求）
#   ./run.sh capture       iPhone 抓包
#   ./run.sh pull          提取小程序包
#   ./run.sh unpack        解包
#   ./run.sh analyze       沙箱分析接口
#   ./run.sh ble           扫蓝牙设备
#   ./run.sh presence      蓝牙靠近自动复电
#   ./run.sh install       装 launchd 定时任务
#
#  ── ThingsBoard 直连（推荐，不走蓝牙、不扫码）──
#   ./run.sh tb-login USER PASS    登录（账号密码见小程序安装二维码）
#   ./run.sh tb-dev                列出名下设备
#   ./run.sh tb-status 301         读状态
#   ./run.sh tb-on 301             复电
#   ./run.sh tb-off 301            断电
#   ./run.sh tb-forever 301        关闭所有自动断电（一劳永逸）
#   ./run.sh tb-timer 301 06:00 23:00   改供电时段
#   ./run.sh tb-mock               起本地 ThingsBoard mock
#
#  ── 蓝牙探针（真机）──
#   ./run.sh dev-info              枚举 GATT
#   ./run.sh dev-listen 20         监听通知
#   ./run.sh dev-send 0103...      发一帧(hex)
#   ./run.sh dev-replay frames.txt 重放帧序列
#   ./run.sh dev-state             用设备令牌外网读状态
#
#  ── JK-2 复电（协议已破解，实测可用）──
#   ./run.sh jk-rooms              列出已配置的宿舍
#   ./run.sh jk-add B03-XXXX 三号床  添加宿舍
#   ./run.sh jk-discover           扫描周边所有 JK-2
#   ./run.sh jk-status             读状态（默认第一台）
#   ./run.sh jk-status-all         读所有宿舍状态
#   ./run.sh jk-recover            复电（单台）
#   ./run.sh jk-recover-all        全部复电
#   ./run.sh jk-watch              守护第一台
#   ./run.sh jk-watch-all          守护所有宿舍
#
#  ── 网页版（单文件 HTML，浏览器直连蓝牙）──
#   ./run.sh web                   起本地服务并打开网页
#
#  ── 故障监控 ──
#   ./run.sh wait-power            盯电压，来电自动复电
#
#  ── 定点复电（推荐，最安全）──
#   ./run.sh install-daily         装 launchd：每天 06:00 / 22:00 各复电一次
#   ./run.sh uninstall-daily       卸载
set -uo pipefail
cd "$(dirname "$0")" || exit 1

# ── 私有配置（真实域名/设备令牌/PRIVATE_DIR），不进仓库 ──
if [ -f private/local.env ]; then
  set +u; set -a; . private/local.env; set +a; set -u
fi
export PRIVATE_DIR="${PRIVATE_DIR:-$PWD/private}"
BASE_URL="${JK2_BASE:-https://www.myneepu.com:8080}"

# 把 launchd 模板渲染成本机真实 plist（含真实路径与令牌），落在 private/launchd/
render_plist() {
  local name="$1" tpl="launchd.example/$1"
  [ -f "$tpl" ] || { echo "[!] 缺少模板 $tpl" >&2; return 1; }
  [ -n "${DEV_TOKEN:-}" ] || { echo "[!] 未设置 DEV_TOKEN（写到 private/local.env）" >&2; return 1; }
  mkdir -p private/launchd private/logs
  sed -e "s|__PROJECT_DIR__|$PWD|g" \
      -e "s|__DEV_TOKEN__|$DEV_TOKEN|g" \
      -e "s|__PYTHON__|$(command -v python3 || echo /usr/bin/python3)|g" \
      "$tpl" > "private/launchd/$name"
  chmod 600 "private/launchd/$name"
  if [ "$name" = "com.dorm.jk2-daily.plist" ]; then
    JK2_RENDER_BASE="$BASE_URL" python3 - "private/launchd/$name" <<'PY' || return 1
import os, plistlib, sys
with open(sys.argv[1], "rb") as f:
    plist = plistlib.load(f)
plist["EnvironmentVariables"]["JK2_BASE"] = os.environ["JK2_RENDER_BASE"]
with open(sys.argv[1], "wb") as f:
    plistlib.dump(plist, f)
PY
  fi
  printf '%s\n' "private/launchd/$name"
}

case "${1:-help}" in
  test)     node test/selftest.mjs ;;

  # ── 路径：ThingsBoard 直连（推荐，不需要蓝牙）──
  tb-login)   node client/tb.mjs login --user "${2:?账号}" --pass "${3:?密码}" ;;
  tb-dev)     node client/tb.mjs devices ;;
  tb-status)  node client/tb.mjs status --device "${2:-301}" ;;
  tb-on)      node client/tb.mjs on --device "${2:-301}" ;;
  tb-off)     node client/tb.mjs off --device "${2:-301}" ;;
  tb-forever) node client/tb.mjs forever --device "${2:-301}" ;;
  tb-timer)   node client/tb.mjs timer --device "${2:-301}" --on "${3:-06:00}" --off "${4:-23:00}" ;;
  tb-mock)    node mock/tb_server.mjs --port "${2:-8099}" ;;
  dev-info)   python3 ble/probe.py info ;;
  dev-listen) python3 ble/probe.py listen --seconds "${2:-20}" ;;
  dev-send)   python3 ble/probe.py send --hex "${2:?hex}" ;;
  dev-replay) python3 ble/probe.py replay --file "${2:?files}" ;;
  dev-state)  curl -s "${BASE_URL}/api/v1/${DEV_TOKEN:?请先设置 DEV_TOKEN}/attributes" | python3 -m json.tool ;;
  jk-rooms)      python3 ble/jk2.py rooms ;;
  jk-add)        python3 ble/jk2.py add "${2:?令牌 B03-xxxx}" "${3:-}" ;;
  jk-remove)     python3 ble/jk2.py remove "${2:?令牌}" ;;
  jk-discover)   python3 ble/jk2.py discover --timeout "${2:-10}" ;;
  jk-status)     python3 ble/jk2.py status ${DEV_TOKEN:+--token $DEV_TOKEN} ;;
  jk-status-all) python3 ble/jk2.py status --all ;;
  jk-recover)    python3 ble/jk2.py recover ${DEV_TOKEN:+--token $DEV_TOKEN} ;;
  jk-recover-all) python3 ble/jk2.py recover --all ;;
  jk-watch)      python3 ble/jk2.py watch --interval "${2:-600}" ;;
  jk-watch-all)  python3 ble/jk2.py watch --all --interval "${2:-600}" ;;
  web)           bash 打开网页版.command "${2:-8080}" ;;
  wait-power)    python3 ble/wait_power.py --interval "${2:-600}" --recover ;;
  install-daily)
    PLIST="$(render_plist com.dorm.jk2-daily.plist)" || exit 1
    cp "$PLIST" ~/Library/LaunchAgents/
    launchctl unload ~/Library/LaunchAgents/com.dorm.jk2-daily.plist 2>/dev/null
    launchctl load ~/Library/LaunchAgents/com.dorm.jk2-daily.plist
    echo "已安装：每天 06:00 / 22:00 各复电一次（每次 4 个写包）"
    echo "查看: launchctl list | grep jk2daily"
    ;;
  uninstall-daily)
    launchctl unload ~/Library/LaunchAgents/com.dorm.jk2-daily.plist 2>/dev/null
    rm -f ~/Library/LaunchAgents/com.dorm.jk2-daily.plist
    echo "已卸载"
    ;;
  mock)     node mock/server.mjs --port "${2:-8787}" ;;
  recover)  node client/recover.mjs --room "${2:-${ROOM_NO:-301}}" ;;
  check)    node client/recover.mjs --room "${2:-${ROOM_NO:-301}}" --check ;;
  dry)      node client/recover.mjs --room "${2:-${ROOM_NO:-301}}" --dry-run ;;
  capture)  bash scripts/capture.sh "${2:-8080}" ;;
  pull)     bash scripts/pull_wxapkg.sh ;;
  unpack)   node scripts/unpack.mjs pkg out --appid "${2:-${WX_APPID:-}}" ;;
  analyze)  node scripts/analyze.mjs "${2:-out/app-service.js}" ;;
  ble)      python3 ble/trigger.py scan --timeout "${2:-8}" ;;
  presence) python3 ble/trigger.py presence --name "${2:-iPhone}" --rssi "${3:--65}" ;;
  beacon)   python3 ble/trigger.py beacon --uuid "${2:?需要 UUID}" ;;
  schedule) python3 schedule/runner.py "${@:2}" ;;
  install)
    PLIST="$(render_plist com.dorm.recover.plist)" || exit 1
    cp "$PLIST" ~/Library/LaunchAgents/
    launchctl unload ~/Library/LaunchAgents/com.dorm.recover.plist 2>/dev/null
    launchctl load ~/Library/LaunchAgents/com.dorm.recover.plist
    echo "已安装。查看: launchctl list | grep dorm"
    ;;
  uninstall)
    launchctl unload ~/Library/LaunchAgents/com.dorm.recover.plist 2>/dev/null
    rm -f ~/Library/LaunchAgents/com.dorm.recover.plist
    echo "已卸载"
    ;;
  *)
    sed -n '2,67p' "$0" | sed -n 's/^# \{0,1\}//p'
    ;;
esac
