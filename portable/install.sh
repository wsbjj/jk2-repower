#!/usr/bin/env bash
# 一键安装（macOS / Linux / 树莓派通用）
set -euo pipefail
cd "$(dirname "$0")" || exit 1

echo "== 检查 Python =="
python3 -V || { echo "缺少 python3"; exit 1; }

echo "== 安装 bleak =="
python3 -m pip install --user -r requirements.txt || \
  python3 -m pip install --user --break-system-packages -r requirements.txt

echo
echo "== 自检 =="
python3 -c "import bleak; print('bleak OK')"

echo
echo "== 下一步 =="
echo "设置 JK2_BASE 后执行: python3 jk2.py status --token 你的设备令牌"
