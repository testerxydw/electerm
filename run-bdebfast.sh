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
#   - build.js 不清理旧产物 (clean 已注释) → 编译前必须清 assets/{js,css,chunk,assets},
#     否则新旧 hash chunk 并存, 打包可能带上旧 chunk 造成"改了没效果"
#   - 本脚本已编译并实查 css, 故 bdebfast 阶段透传 --skip-compile 避免白跑一次 vite;
#     prepare/首次运行例外 (work/app 会重建, 必须由 bdebfast 在 prepare 之后再编译)

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

DEBFAST_ARGS=()
if [ "$SKIP_COMPILE" -eq 0 ]; then
  echo "========== [2/5] npm run compile =========="
  # build.js 自身不清理旧产物, 这里与 build-deb-fast 内部保持一致地清理,
  # 否则新旧 chunk 并存 → deb 里可能带旧 chunk (本项目踩过此坑)
  rm -rf work/app/assets/js work/app/assets/css \
         work/app/assets/chunk work/app/assets/assets
  npm run compile
  # 构建验证铁律: 实查 css 产物 (vite 可能 silently fail)
  CSS=$(ls work/app/assets/css/style-*.css 2>/dev/null | head -1)
  if [ -z "$CSS" ]; then
    echo "[FAIL] compile 后未找到 style-*.css, vite/stylus 可能 silently fail"
    exit 1
  fi
  echo "[ok] css: $CSS"
  # 上面已编译且校验过产物: 若让 bdebfast 再编译, 它会先清空目录再重编译,
  # 校验就失去意义, 且白跑一次 vite → 非 prepare 路径透传 --skip-compile
  if [ "$FORCE_PREPARE" -eq 0 ] && [ -d work/app/node_modules ]; then
    DEBFAST_ARGS+=(--skip-compile)
  fi
fi
if [ "$FORCE_PREPARE" -eq 1 ]; then
  DEBFAST_ARGS+=(--prepare)
fi
if [ -n "$UI_FLAG" ]; then
  DEBFAST_ARGS+=("$UI_FLAG")
fi

echo "========== [3/5] bdebfast =========="
if [ "${#DEBFAST_ARGS[@]}" -gt 0 ]; then
  echo "[bdebfast] 参数: ${DEBFAST_ARGS[*]}"
else
  echo "[bdebfast] 参数: <无>"
fi
# 记录打包前时间戳: 用于后面校验"本次确实产出了新 deb", 防静默失败后装旧包
BUILD_MARK=$(mktemp)
node src/build/bin/build-deb-fast.js "${DEBFAST_ARGS[@]}"

# 找最新 deb
DEB=$(ls -t dist/electerm-*-test.*-linux-amd64.deb 2>/dev/null | head -1)
if [ -z "$DEB" ]; then
  echo "[FAIL] 未找到测试包 deb"
  rm -f "$BUILD_MARK"
  exit 1
fi
# 新鲜度校验: 本次运行之前就已存在的 deb 说明打包没产出新包 (build 静默失败等)
if [ -e "$BUILD_MARK" ] && [ ! "$DEB" -nt "$BUILD_MARK" ]; then
  echo "[FAIL] 最新 deb 早于本次运行, 打包未产出新包: $DEB"
  rm -f "$BUILD_MARK"
  exit 1
fi
rm -f "$BUILD_MARK"
# UI 模式校验: 必须拿到 -ui 包, 防止误装 master 包
if [ "$UI_MODE" -eq 1 ] && [[ "$DEB" != *"-ui-linux-amd64.deb" ]]; then
  echo "[FAIL] UI 模式但拿到的不是 UI 包: $DEB"
  exit 1
fi
echo "[ok] deb: $DEB (version $(dpkg-deb -f "$DEB" Version 2>/dev/null || echo '?'))"

echo "========== [4/5] kill + clean cache =========="
pkill -f "[/]opt/electerm/electerm" 2>/dev/null || true
sleep 1
rm -rf ~/.config/electerm/Cache \
       ~/.config/electerm/GPUCache \
       ~/.config/electerm/Code\ Cache

echo "========== [5/5] install + start =========="
# 无 TTY 且 sudo 需要密码时会永久阻塞 (自动化/CI 场景), 提前提示而不是干等
if [ ! -t 0 ] && ! sudo -n true 2>/dev/null; then
  echo "[warn] 当前非交互且 sudo 需要密码, dpkg 安装会失败; 请手动执行:"
  echo "       sudo dpkg -i --force-overwrite $DEB"
fi
sudo dpkg -i --force-overwrite "$DEB"
# 安装后校验: dpkg 记录里的版本应与刚构建的一致 (防装了别的包)
INSTALLED=$(dpkg-query -W -f='${Version}' electerm 2>/dev/null || echo '?')
echo "[ok] 已安装版本: $INSTALLED"
nohup /opt/electerm/electerm > /tmp/electerm.log 2>&1 &
echo "[done] 已启动, PID=$!"
echo "       tail -f /tmp/electerm.log"
