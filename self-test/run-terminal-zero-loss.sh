#!/usr/bin/env bash
# 终端输出零丢弃 CDP 实机探针启动器
# 在隔离 HOME 下用 xvfb 起 electerm，等调试端口就绪后跑探针，结束清理。
set -u

PORT="${1:-9333}"
PROBE="${2:-self-test/terminal-output-zero-loss-cdp-probe.js}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

D="$(mktemp -d /tmp/electerm-zl-XXXX)"
mkdir -p "$D/home" "$D/config" "$D/data"
echo "isolated env: $D"

ELECTRON="$HERE/node_modules/electron/dist/electron"
APP_JS="$HERE/work/app/app.js"

cleanup () {
  echo "--- cleaning up ---"
  # 杀掉整个 electerm electron 进程组（主进程 + gpu-process + server.js 等孤儿），
  # 避免重跑时残留进程占端口/资源。模式限定本仓库路径，不会误伤 workbuddy 自身。
  pkill -9 -f "$HERE/node_modules/electron/dist/electron" 2>/dev/null
  pkill -9 -f "Xvfb" 2>/dev/null
  rm -rf "$D" 2>/dev/null
}
trap cleanup EXIT

echo "launching electerm under xvfb (port $PORT)..."
# 关键：workbuddy 沙箱预设了 ELECTRON_RUN_AS_NODE=1，会让 electron 退化成
# 普通 node、主进程拿不到 app 模块（app.getPath 直接崩）。必须在子进程里 unset。
# 同时 unset NODE_OPTIONS（workbuddy 的 node-language-shim 注入）避免干扰 electron 的 node。
HOME="$D/home" XDG_CONFIG_HOME="$D/config" DATA_PATH="$D/data" \
  xvfb-run -a -s "-screen 0 1600x1000x24" \
  env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  "$ELECTRON" "$APP_JS" --no-sandbox --disable-gpu \
  --remote-debugging-port="$PORT" --window-size=1600,1000 >/tmp/electerm-zl.log 2>&1 &
APP_PID=$!

# 等调试端口
echo "waiting for debugging port $PORT ..."
for i in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/json" >/dev/null 2>&1; then
    echo "debugging port ready after ${i}s"
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "ERROR: electerm exited early. tail of log:"
    tail -30 /tmp/electerm-zl.log
    exit 3
  fi
  sleep 1
done

# 再给渲染进程一点时间让 window.store/refs 就绪（探针内部也会 waitFor）
sleep 3

echo "running probe: $PROBE ..."
node "$HERE/$PROBE" "$PORT"
RC=$?
echo "probe exit code: $RC"
exit $RC
