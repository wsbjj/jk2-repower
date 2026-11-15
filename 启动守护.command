#!/usr/bin/env bash
# 守护模式：常驻检测，断电自动复电
# 用法：双击本文件，或在终端执行  bash 启动守护.command
set -uo pipefail
cd "$(dirname "$0")" || exit 1

# 私有配置（真实令牌/域名），不进仓库
if [ -f private/local.env ]; then set +u; set -a; . private/local.env; set +a; set -u; fi
export PRIVATE_DIR="${PRIVATE_DIR:-$PWD/private}"
mkdir -p "$PRIVATE_DIR/logs"

TOKEN="${DEV_TOKEN:-}"
[ -n "$TOKEN" ] || { echo "[!] 缺少设备令牌：把 DEV_TOKEN 写进 private/local.env"; read -r -p "回车退出" _; exit 1; }

echo "════════════════════════════════════════════════"
echo "  JK-2 宿舍复电守护"
echo "  设备：$TOKEN"
echo "════════════════════════════════════════════════"
echo

# 依赖自检
python3 -c "import bleak" 2>/dev/null || {
  echo "缺少 bleak，正在安装 …"
  python3 -m pip install --user bleak || { echo "安装失败"; read -r; exit 1; }
}

cat <<'WARN'

╔══════════════════════════════════════════════════════════════╗
║  ⚠  风险提示 —— 请先读完                                    ║
╠══════════════════════════════════════════════════════════════╣
║  守护模式会周期性向监控器写指令。                            ║
║  写入过频可能导致设备 RTC 异常（故障码 24）：                ║
║    电压/电流/电量全部读 0，继电器锁死断开，房间直接没电。     ║
║                                                              ║
║  而且软件修不好，只能：                                      ║
║    · 拔掉 JK-2 电源等 10 秒再插上，或                         ║
║    · 等 30 分钟                                                ║
║                                                              ║
║  默认间隔已设 600 秒（每天约 144 次写入）。                   ║
║  手动扫码一次 = 1 次写入。                                   ║
║                                                              ║
║  如果只是想复电，建议直接跑：./run.sh jk-recover             ║
╚══════════════════════════════════════════════════════════════╝

WARN
read -r -p "确认继续？输入 yes 回车，其他任意键退出: " ans
if [ "$ans" != "yes" ]; then
  echo "已取消。"
  exit 0
fi
echo
echo "开始守护。断电会自动复电，按 Ctrl-C 退出。"
echo "日志：private/logs/jk2.log"
echo

python3 ble/jk2.py watch --token "$TOKEN" --interval "${INTERVAL:-600}" --yes \
  2>&1 | tee -a "$PRIVATE_DIR/logs/jk2.log"
