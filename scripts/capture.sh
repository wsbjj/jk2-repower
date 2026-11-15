#!/usr/bin/env bash
# 一键启动 iPhone 抓包环境
#   bash scripts/capture.sh             # 默认 8080
#   bash scripts/capture.sh 9090
set -uo pipefail
PORT="${1:-8080}"
cd "$(dirname "$0")/.." || exit 1
PRIVATE_DIR="${PRIVATE_DIR:-$PWD/private}"
mkdir -p "$PRIVATE_DIR/captures" "$PRIVATE_DIR/logs"

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "未取到")
echo "════════════════════════════════════════════════"
echo " mitmproxy 抓包已启动，端口 $PORT"
echo "════════════════════════════════════════════════"
cat <<EOF
【iPhone 设置 —— 按顺序做】
 1. 确认 iPhone 和 Mac 同一 WiFi
 2. WiFi → 当前网络 → 配置代理 → 手动
      服务器: ${LAN_IP}
      端口:   ${PORT}
 3. iPhone Safari 打开 http://mitm.it   → 下载 Apple 证书 → 允许
 4. 设置 → 通用 → 关于本机 → 证书信任设置
      → 打开 "mitmproxy" 开关（这步不做会全是证书报错）
 5. 打开微信 → 该小程序 → 点一次「扫码复电」

【Mac 这边会实时打印】每条请求的 method/path/auth header
【抓完 Ctrl-C】自动生成：
   private/captures/summary.json            接口全清单 + 凭证
   private/captures/suggested-config.json   可直接用的 config 初稿

提示：微信有 SSL Pinning 的话（部分版本），需配合越狱 + frida 解 pin，
      脚本在 capture/frida_unpin.js，用法见 README。
EOF
echo "════════════════════════════════════════════════"
echo

if ! command -v mitmdump >/dev/null; then
  echo "[!] 未安装 mitmproxy，先执行: brew install mitmproxy"
  exit 1
fi

PRIVATE_DIR="${PRIVATE_DIR:-$PWD/private}"
mkdir -p "$PRIVATE_DIR/captures" "$PRIVATE_DIR/logs"
export CAPTURE_DIR="$PRIVATE_DIR/captures"
mitmdump -s capture/mitm_addon.py --set dump_dir="$CAPTURE_DIR" -p "$PORT" --set block_global=false \
  2>&1 | tee "$PRIVATE_DIR/logs/mitm-$(date +%H%M%S).log"
