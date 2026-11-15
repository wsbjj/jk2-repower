#!/usr/bin/env bash
# 一次性依赖安装：iOS 抓包 + 小程序包解包 + BLE 控制
set -euo pipefail

echo "== 1/4 Homebrew 基础工具 =="
for f in libimobiledevice ideviceinstaller mitmproxy; do
  brew list "$f" >/dev/null 2>&1 || brew install "$f"
done

echo "== 2/4 Python 侧（BLE + 抓包插件） =="
python3 -m pip install --upgrade --user bleak mitmproxy >/dev/null
echo "bleak: $(python3 -c 'import bleak;print(bleak.__version__)' 2>/dev/null || echo FAIL)"

echo "== 3/4 frida（越狱设备才需要，非越狱可跳过） =="
if [[ "${WITH_FRIDA:-0}" == "1" ]]; then
  python3 -m pip install --upgrade --user frida frida-tools
  echo "提示: 设备需已越狱并在 Cydia/Sileo 安装 frida-server"
fi

echo "== 4/4 证书（mitmproxy，iPhone 抓包用） =="
ls -l ~/.mitmproxy/mitmproxy-ca-cert.pem 2>/dev/null || echo "首次运行 mitmproxy 后会在 ~/.mitmproxy 生成 CA"

echo
echo "完成。下一步：bash scripts/pull_wxapkg.sh"
