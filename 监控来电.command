#!/usr/bin/env bash
# 盯着 4997 的电压，来电了就提示（并自动复电）
set -uo pipefail
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ -f private/local.env ]; then set +u; set -a; . private/local.env; set +a; set -u; fi
export PRIVATE_DIR="${PRIVATE_DIR:-$PWD/private}"

echo "════════════════════════════════════════"
echo " 监控设备电压（${DEV_TOKEN:-未配置}）"
echo " 来电后会自动复电，按 Ctrl-C 退出"
echo "════════════════════════════════════════"
echo

exec python3 ble/wait_power.py --interval 600 --recover
