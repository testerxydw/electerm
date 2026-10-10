#!/bin/bash
# 编译 + 打测试 deb + 清缓存 + 安装 + 重启 electerm
# 用法: ./run-bdebfast.sh [--skip-compile] [--prepare]
#   --skip-compile   跳过 npm run compile (只改了非客户端资源时用)
#   --prepare        强制重建 work/app/node_modules (node-pty 缺失等)
# 历史坑:
#   - work/app 有独立的 node_modules (bdebfast npm i --omit=dev),
#     patch-locales 必须同时 patch 两处
#   - Node 22 PATH 必须显式 export, 否则系统 node(v12/v18) 会抢
#   - pkill 必须转义 [/], 否则 /opt/electerm/electerm 自己会被匹配
#   - dpkg -i 必须 --force-overwrite (测试包版本号相同)
#   - compile 会吞 vite 失败, 必须实查 css 产物

set -euo pipefail

export PATH="$HOME/.config/nvm/versions/node/v22.23.2/bin:$PATH"

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

SKIP_COMPILE=0
FORCE_PREPARE=0
for arg in "$@"; do
  case "$arg" in
    --skip-compile) SKIP_COMPILE=1 ;;
    --prepare)      FORCE_PREPARE=1 ;;
  esac
done

echo "========== [1/5] patch locales =========="
node build/patch-locales.js
# 验证 work/app 里也 patch 到了
PATTERNS=("splitHorizontal" "水平拆分" "splitVertical" "垂直拆分")
for p in "${PATTERNS[@]}"; do
  if [ ! -f "work/app/node_modules/@electerm/electerm-locales/dist/cjs/zh_cn.js" ]; then
    echo "[warn] work/app locales 不存在, 可能 --prepare 前需要重建"
    break
  fi
  if ! grep -q "$p" "work/app/node_modules/@electerm/electerm-locales/dist/cjs/zh_cn.js"; then
    echo "[warn] work/app locales 缺 $p, patch 脚本漏了?"
  fi
done

if [ "$SKIP_COMPILE" -eq 0 ]; then
  echo "========== [2/5] npm run compile =========="
  npm run compile
  # 构建验证铁律: 实查 css 产物 (vite 可能 silently fail)
  CSS=$(ls work/app/assets/css/style-*.css 2>/dev/null | head -1)
  if [ -z "$CSS" ]; then
    echo "[FAIL] compile 后未找到 style-*.css, vite/stylus 可能 silently fail"
    exit 1
  fi
  echo "[ok] css: $CSS"
fi

echo "========== [3/5] bdebfast =========="
if [ "$FORCE_PREPARE" -eq 1 ]; then
  node build/bin/build-deb-fast.js --prepare
else
  npm run bdebfast
fi

# 找最新 deb
DEB=$(ls -t dist/electerm-*-test.*-linux-amd64.deb 2>/dev/null | head -1)
if [ -z "$DEB" ]; then
  echo "[FAIL] 未找到测试包 deb"
  exit 1
fi
echo "[ok] deb: $DEB"

echo "========== [4/5] kill + clean cache =========="
pkill -f "[/]opt/electerm/electerm" 2>/dev/null || true
sleep 1
rm -rf ~/.config/electerm/Cache \
       ~/.config/electerm/GPUCache \
       ~/.config/electerm/Code\ Cache

echo "========== [5/5] install + start =========="
sudo dpkg -i --force-overwrite "$DEB"
nohup /opt/electerm/electerm > /tmp/electerm.log 2>&1 &
echo "[done] 已启动, PID=$!"
echo "       tail -f /tmp/electerm.log"
