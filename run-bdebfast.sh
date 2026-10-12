#!/bin/bash
# 编译 + 打测试 deb + 清缓存 + 安装 + 重启 electerm
# 用法: ./run-bdebfast.sh [--skip-compile] [--prepare] [--ui] [--no-ui] [--limit-cpu N]
#   --skip-compile   跳过 npm run compile (只改了非客户端资源时用)
#   --prepare        强制重建 work/app/node_modules (node-pty 缺失等)
#   --ui             强制 UI 测试包: 版本号带 -ui 后缀 (如 test.82-ui)
#   --no-ui          在 ui-beautification 分支上豁免自动 -ui 标识
#   --limit-cpu N    限核数覆盖 (默认 min(核数*70%, 10); 0=不限)
#   ui-beautification 分支自动使用 -ui 包标识, 与 master 包区分
# 历史坑:
#   - work/app 有独立的 node_modules (bdebfast npm i --omit=dev),
#     patch-locales 必须同时 patch 两处, 且 --prepare 重建后要补 patch
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
UI_MODE=0
NO_UI=0
LIMIT_CPU=''
ORIG_ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-compile) SKIP_COMPILE=1 ;;
    --prepare)      FORCE_PREPARE=1 ;;
    --ui)           UI_MODE=1 ;;
    --no-ui)        NO_UI=1 ;;
    --limit-cpu)
      shift
      LIMIT_CPU="${1:-}"
      ;;
  esac
  shift
done

# CPU 限核: 默认 min(核数*70%, 10), 防 vite/dpkg-deb 压缩吃满 CPU 卡死桌面
# taskset 重执行 + TRAEBUILD_CPU_PINNED 防递归; --limit-cpu 0=不限, 超核数回落不限
# (set -e 下禁用 && 短路写法, 条件不满足时整条命令返回非零会误退脚本)
apply_cpu_limit () {
  if [ "${TRAEBUILD_CPU_PINNED:-0}" = 1 ]; then
    return 0
  fi
  if ! command -v taskset >/dev/null 2>&1; then
    return 0
  fi
  local total cores
  total=$(nproc)
  cores=$(( total * 70 / 100 ))
  if [ "$cores" -gt 10 ]; then
    cores=10
  fi
  if [ "$cores" -lt 1 ]; then
    cores=1
  fi
  if [ -n "$LIMIT_CPU" ]; then
    case "$LIMIT_CPU" in
      ''|*[!0-9]*) echo "[cpu-limit] 非法 --limit-cpu 值: $LIMIT_CPU, 忽略" ;;
      0) return 0 ;;
      *) if [ "$LIMIT_CPU" -lt "$cores" ]; then cores=$LIMIT_CPU; fi ;;
    esac
  fi
  if [ "$cores" -ge "$total" ]; then
    return 0
  fi
  echo "[cpu-limit] 限核 $cores/$total (70% 且 ≤10 核; --limit-cpu 可调, 0=不限)"
  TRAEBUILD_CPU_PINNED=1 exec taskset -c 0-$((cores-1)) bash "$0" "${ORIG_ARGS[@]}"
}
apply_cpu_limit
# UI 分支自动打 UI 包 (--no-ui 可豁免)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$UI_MODE" -eq 0 ] && [ "$NO_UI" -eq 0 ] && [ "$BRANCH" = "ui-beautification" ]; then
  UI_MODE=1
  echo "[auto] 当前分支 ui-beautification, 自动使用 -ui 包标识 (--no-ui 可关闭)"
fi
UI_FLAG=""
if [ "$UI_MODE" -eq 1 ]; then
  UI_FLAG="--ui"
fi

echo "========== [1/5] patch locales =========="
node src/build/patch-locales.js
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
  node src/build/bin/build-deb-fast.js --prepare $UI_FLAG
else
  npm run bdebfast -- $UI_FLAG
fi

# 找最新 deb
DEB=$(ls -t dist/electerm-*-test.*-linux-amd64.deb 2>/dev/null | head -1)
if [ -z "$DEB" ]; then
  echo "[FAIL] 未找到测试包 deb"
  exit 1
fi
# UI 模式校验: 必须拿到 -ui 包, 防止误装 master 包
if [ "$UI_MODE" -eq 1 ] && [[ "$DEB" != *"-ui-linux-amd64.deb" ]]; then
  echo "[FAIL] UI 模式但拿到的不是 UI 包: $DEB"
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
