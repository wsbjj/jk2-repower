#!/usr/bin/env bash
# 查看当前状态（双击即可）
set -uo pipefail
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -f private/local.env ]; then set +u; set -a; . private/local.env; set +a; set -u; fi
export PRIVATE_DIR="${PRIVATE_DIR:-$PWD/private}"
TOKEN="${DEV_TOKEN:-}"
BASE_URL="${JK2_BASE:-https://www.myneepu.com:8080}"
[ -n "$TOKEN" ] || { echo "[!] 缺少设备令牌：把 DEV_TOKEN 写进 private/local.env"; read -r -p "回车退出" _; exit 1; }

echo "查询 $TOKEN 状态 …"
echo
python3 ble/jk2.py status --token "$TOKEN"
echo
echo "────────────────────────────────"
# 顺带查一下云端登记的属性
curl -s --max-time 10 "${BASE_URL}/api/v1/${TOKEN}/attributes?sharedKeys=ElectricControlSwitch,TimeControlSwitch,RoomStaticControlSwitch,TimerOneOn,TimerOneOff" \
  | python3 -m json.tool 2>/dev/null || echo "（云端查询失败，可能是网络问题）"
echo
read -r -p "按回车关闭窗口" _
