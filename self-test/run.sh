#!/bin/bash
# electerm UI 无头自测：启动应用 → 截图 → 通过 CDP 触发交互 → 再截图
#
# 用法:
#   ./self-test/run.sh                 # 输出 self-test/shot-base.png / shot-palette.png
#   ./self-test/run.sh self-test/r2    # 自定义前缀 → self-test/r2-base.png ...
#
# 依赖: Xvfb, ffmpeg, node(项目 node_modules 含 ws), electron(work/app)
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PREFIX="${1:-self-test/shot}"
DISP=":99"
PORT=9222
NODE_BIN="$HOME/.config/nvm/versions/node/v22.23.2/bin"
export PATH="$NODE_BIN:$PATH"

echo "[self-test] 1/5 准备虚拟显示 $DISP"
if ! xdpyinfo -display "$DISP" >/dev/null 2>&1; then
  nohup Xvfb "$DISP" -screen 0 1440x900x24 >/tmp/xvfb.log 2>&1 &
  sleep 2
fi

echo "[self-test] 2/5 关闭旧实例"
pids=$(ps -eo pid,args | grep -E "node_modules/(\.bin/)?electron" | grep -v grep | awk '{print $1}' || true)
if [ -n "${pids:-}" ]; then kill $pids 2>/dev/null || true; fi
sleep 2

echo "[self-test] 3/5 启动应用（含 CDP :$PORT）"
DISPLAY="$DISP" nohup node_modules/.bin/electron work/app/app.js \
  --no-sandbox --disable-gpu --remote-debugging-port="$PORT" \
  >/tmp/electerm-selftest.log 2>&1 &
sleep 22

echo "[self-test] 4/5 截图（基础态）"
ffmpeg -y -f x11grab -video_size 1440x900 -i "$DISP" -frames:v 1 -update 1 "${PREFIX}-base.png" >/dev/null 2>&1

echo "[self-test] 5/5 交互态：打开命令面板"
wsurl=$(curl -s -m 5 "http://127.0.0.1:$PORT/json" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const t=JSON.parse(d).find(x=>x.type==='page');if(t)console.log(t.webSocketDebuggerUrl)}catch(e){}})")
if [ -n "${wsurl:-}" ]; then
  NODE_PATH="$ROOT/node_modules" node "$ROOT/self-test/cdp-eval.js" "$wsurl" "window.dispatchEvent(new Event('open-command-palette')); 'ok'" || true
  sleep 2
  ffmpeg -y -f x11grab -video_size 1440x900 -i "$DISP" -frames:v 1 -update 1 "${PREFIX}-palette.png" >/dev/null 2>&1
else
  echo "[self-test] 警告：未取得 CDP webSocketDebuggerUrl，跳过交互截图"
fi

echo "[self-test] 完成 → ${PREFIX}-base.png / ${PREFIX}-palette.png"
