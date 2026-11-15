#!/usr/bin/env bash
# 从 iPhone / iTunes 备份 / 越狱设备 提取小程序 wxapkg
#
# 小程序包在 iPhone 上的位置（越狱或 iBackup 可见）：
#   /var/mobile/Containers/Data/Application/<微信>/Documents/
#       appbrand/pkg/*.wxapkg                       ← 主包
#       appbrand/pkg/*.wxapkg 下的 __APP__.wxapkg
#   Mac 微信：~/Library/Containers/com.tencent.xinWeChat/Data/.../appbrand/pkg/
#
# 用法：
#   bash scripts/pull_wxapkg.sh                 # 自动扫所有已知位置
#   bash scripts/pull_wxapkg.sh --backup <dir>  # 从 iTunes 备份目录找
#   bash scripts/pull_wxapkg.sh --device        # 从已连接 iPhone 拉（需 libimobiledevice+越狱）
set -uo pipefail

OUT="pkg"; mkdir -p "$OUT"
FOUND=0

scan_dir() {
  local d="$1" label="$2"
  [[ -d "$d" ]] || return 0
  while IFS= read -r -d '' f; do
    local sz; sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
    # 过滤太小的（配置碎片）
    [[ "$sz" -lt 2000 ]] && continue
    local base; base=$(basename "$f")
    local dest="$OUT/$(echo "$label" | tr '/' '_')__$base"
    [[ -f "$dest" ]] && continue
    cp "$f" "$dest" && echo "  [+] $dest  ($((sz/1024))KB)  ← $f"
    FOUND=$((FOUND+1))
  done < <(find "$d" -type f -name '*.wxapkg' -print0 2>/dev/null)
}

echo "== 1. Mac 微信小程序缓存 =="
scan_dir "$HOME/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9" "macwx"
scan_dir "$HOME/Library/Containers/com.tencent.xinWeChat/Data" "macwx2"
scan_dir "$HOME/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat" "macwx3"

echo "== 2. iOS 备份（未加密备份也能看到部分） =="
for b in "$HOME/Library/Application Support/MobileSync/Backup"/*; do
  [[ -d "$b" ]] || continue
  # 备份里文件名是 hash，只能靠内容头判断
  while IFS= read -r -d '' f; do
    if [[ "$(head -c 2 "$f" 2>/dev/null | xxd -p)" == "be"* ]] || [[ "$(head -c 6 "$f" 2>/dev/null)" == "V1MMWX" ]]; then
      local_sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
      [[ "$local_sz" -lt 5000 ]] && continue
      dest="$OUT/iosbak__$(basename "$b")__$(basename "$f").wxapkg"
      [[ -f "$dest" ]] || { cp "$f" "$dest" && echo "  [+] $dest ($((local_sz/1024))KB)"; FOUND=$((FOUND+1)); }
    fi
  done < <(find "$b" -type f -size +5k -print0 2>/dev/null)
done

echo "== 3. 已连接 iPhone（需 libimobiledevice + 越狱） =="
if command -v idevice_id >/dev/null && [[ "$(idevice_id -l 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ]]; then
  UDID=$(idevice_id -l 2>/dev/null | head -1)
  echo "  设备 UDID: $UDID"
  if command -v ifuse >/dev/null; then
    MNT=$(mktemp -d)
    if ifuse "$MNT" -u "$UDID" 2>/dev/null; then
      scan_dir "$MNT" "iphone"
      umount "$MNT" 2>/dev/null || fusermount -u "$MNT" 2>/dev/null || true
      rmdir "$MNT" 2>/dev/null || true
    else
      echo "  ifuse 挂载失败（非越狱设备无法直接挂载，走 iTunes 备份方案）"
    fi
  fi
else
  echo "  未检测到设备或无 libimobiledevice（brew install libimobiledevice）"
fi

echo
if [[ "$FOUND" -eq 0 ]]; then
  cat <<'EOF'
没找到 wxapkg。三条可靠替代路径：

  A) Mac 微信打开一次该小程序 → 再跑本脚本
     （Mac 微信 4.x 缓存路径已变，脚本已覆盖主路径；仍缺就手动找：
      find ~/Library/Containers/com.tencent.xinWeChat -name '*.wxapkg' 2>/dev/null）

  B) iPhone 用「iMazing / 爱思助手」导出微信 Documents 目录
     把 appbrand/pkg 整个文件夹拖到 ./pkg/ 下再跑：
     node scripts/unpack.mjs pkg out

  C) 直接抓包，跳过反编译（最省事，推荐先做这个）
     bash scripts/capture.sh      # 起 mitmproxy
     然后用 iPhone 点一次复电 → captures/suggested-config.json
EOF
else
  echo "共 $FOUND 个包。下一步："
  echo "  node scripts/unpack.mjs pkg out --appid <小程序appid>"
  echo "  node scripts/analyze.mjs out/app-service.js"
fi
