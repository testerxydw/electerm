#!/usr/bin/env bash
# electerm-mem.sh —— 精确排查 electerm 各进程 / 会话的内存占用
#
# 用法:
#   ./electerm-mem.sh            # 默认按 PSS(真实物理占用) 降序输出
#   ./electerm-mem.sh --rss      # 改按 RSS 排序
#   ./electerm-mem.sh --help     # 帮助
#
# 说明:
#   - PSS(比例占用) = 去重共享内存后的真实物理占用，最能反映"实际吃了多少内存"，推荐看这个。
#   - RSS = 含共享库、会在多进程间重复计数，因此会高估总量（仅作参考）。
#   - 每个 session-server.js 子进程 = 一个活跃会话；脚本读取其外连地址反查会话身份
#     (22→SSH / 3389→RDP / 5900→VNC / 23→Telnet …)；无外连且带 bash 子进程 = 本地终端；
#     无外连且无子进程 = 可能已被 remote-suspend 挂起或本地会话。
#   - 渲染进程(renderer) 的 484MB 级别占用里含所有标签 DOM 及 VNC/RDP 解码后的帧缓冲，
#     所以隐藏远程标签(用 remote-suspend 短挂起)能直接回收这部分。
#
# 依赖: bash / procfs (Linux)。无需 root，只看自己拥有的进程。

set -u

PAGESIZE=$(getconf PAGESIZE 2>/dev/null || echo 4096)

# ---------- 小工具 ----------

proto_of_port () {
  case "$1" in
    22)   echo "SSH" ;;
    23)   echo "Telnet" ;;
    3389) echo "RDP" ;;
    5900|5901|5902|5903|5904|5905) echo "VNC" ;;
    5985|5986) echo "WinRM" ;;
    *)    echo "端口$1" ;;
  esac
}

# 进程角色判定（依据 cmdline）
role_of () {
  local cmd=$1
  case "$cmd" in
    *"--type=renderer"*)  echo renderer; return ;;
    *"--type=gpu-process"*) echo gpu; return ;;
    *"--type=utility"*)   echo utility; return ;;
    *"--type=zygote"*|*"--type=broker"*) echo zygote; return ;;
    *"session-server.js"*) echo session; return ;;
    *"server/server.js"*) echo server; return ;;
  esac
  if [[ "$cmd" == *"--type="* ]]; then echo other; return; fi
  if [[ "$cmd" == *"electerm"* ]]; then echo main; return; fi
  echo other
}

# 取某进程的第一个外连(非 localhost)远端地址 ip:port；无则返回空
ext_peer_of () {
  local pid=$1 f sl localaddr remaddr st ra rp port ip
  for f in /proc/$pid/net/tcp /proc/$pid/net/tcp6; do
    [[ -r "$f" ]] || continue
    while read -r sl localaddr remaddr st _; do
      [[ "$st" == "01" ]] || continue          # 01 = ESTABLISHED
      ra=${remaddr%%:*}; rp=${remaddr##*:}
      port=$((16#$rp))
      if [[ ${#ra} -eq 8 ]]; then              # IPv4
        ip="$((16#${ra:6:2})).$((16#${ra:4:2})).$((16#${ra:2:2})).$((16#${ra:0:2}))"
      else                                      # IPv6（粗略处理）
        case "$ra" in
          00000000000000000000000000000000) continue ;;   # ::
          *) ip="IPv6" ;;
        esac
      fi
      [[ "$ip" == 127.* ]] && continue
      [[ "$ip" == "::1" ]] && continue
      echo "$ip:$port"
      return 0
    done < "$f"
  done
  return 1
}

# 会话进程身份标签
session_label () {
  local pid=$1 peer ip port
  if peer=$(ext_peer_of "$pid"); then
    ip=${peer%:*}; port=${peer##*:}
    echo "$(proto_of_port "$port") → $peer"
    return
  fi
  # 无外连：看是否有 bash/sh 子进程 → 本地终端
  local k kcmd
  for k in $(pgrep -P "$pid" 2>/dev/null); do
    kcmd=$(tr '\0' ' ' < /proc/$k/cmdline 2>/dev/null)
    if [[ "$kcmd" == *"bash"* ]] || [[ "$kcmd" == *"/sh"* ]]; then
      echo "本地终端(bash)"
      return
    fi
  done
  echo "无外连(可能已挂起/本地)"
}

# ---------- 参数 ----------
SORT_FIELD=4   # 默认按 PSS 降序
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rss)  SORT_FIELD=5 ;;
    --help|-h) echo "用法: $0 [--rss]  详见脚本头部注释"; exit 0 ;;
    *) echo "未知参数: $1 (用 --help 查看)"; exit 1 ;;
  esac
  shift
done

# ---------- 采集 ----------
pids=$(pgrep -x electerm)
if [[ -z "$pids" ]]; then
  echo "未检测到运行中的 electerm 进程。"
  exit 0
fi

declare -a ROWS
total_pss=0; total_rss=0; n=0

for pid in $pids; do
  [[ -d /proc/$pid ]] || continue
  pss=$(awk '/^Pss:/{s+=$2} END{print s+0}' /proc/$pid/smaps 2>/dev/null)
  rss=$(( $(awk '{print $2}' /proc/$pid/statm 2>/dev/null) * PAGESIZE / 1024 ))
  cmd=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)
  role=$(role_of "$cmd")
  case "$role" in
    renderer) label="主UI渲染(标签DOM+远程帧缓冲)" ;;
    main)     label="主进程(Electron shell)" ;;
    gpu)      label="GPU进程" ;;
    utility)  label="网络服务utility" ;;
    zygote)   label="zygote/broker" ;;
    server)   label="后端server.js" ;;
    session)  label=$(session_label "$pid") ;;
    *)        label="$role" ;;
  esac
  ROWS+=("$pid|$role|$label|$pss|$rss")
  total_pss=$((total_pss + pss))
  total_rss=$((total_rss + rss))
  n=$((n + 1))
done

# ---------- 输出 ----------
printf "\n%-8s %-9s %-34s %9s %9s\n" "PID" "角色" "会话/说明" "PSS(MB)" "RSS(MB)"
printf "%s\n" "--------------------------------------------------------------------------------"
printf "%s\n" "${ROWS[@]}" \
  | sort -t'|' -k"$SORT_FIELD" -nr \
  | while IFS='|' read -r pid role label pss rss; do
      printf "%-8s %-9s %-34s %8.0f %8.0f\n" \
        "$pid" "$role" "$label" "$((pss/1024))" "$((rss/1024))"
    done
printf "%s\n" "--------------------------------------------------------------------------------"
printf "合计: %d 个进程 | PSS(真实)= %.0f MB | RSS(含共享,高估)= %.0f MB\n" \
  "$n" "$((total_pss/1024))" "$((total_rss/1024))"
echo "提示: PSS 才是最准的'实际吃了多少内存'；RSS 在 Chromium 多进程间重复计共享库会偏大。"
