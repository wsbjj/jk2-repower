#!/usr/bin/env bash
# 启动本地服务器并打开浏览器（Web Bluetooth 需要 localhost）
set -uo pipefail
cd "$(dirname "$0")" || exit 1

PORT="${1:-8080}"

# 端口占用就用下一个
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  echo "端口 $PORT 被占用，换 $((PORT+1))"
  PORT=$((PORT+1))
done

URL="http://localhost:${PORT}/jk2.html"

echo "════════════════════════════════════════"
echo " JK-2 网页版复电"
echo "────────────────────────────────────────"
echo " 地址: $URL"
echo " 注意: 必须用 Chrome 或 Edge 打开"
echo "       Safari 不支持 Web Bluetooth"
echo "════════════════════════════════════════"

# 后台起服务器
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

sleep 1

# 优先用 Chrome
if [ -d "/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "$URL"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -a "Microsoft Edge" "$URL"
else
  open "$URL"
fi

echo
echo "服务器运行中。关闭本窗口即停止。"
echo "按 Ctrl-C 退出。"
wait $SRV
