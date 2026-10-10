# 快速打测试包 + 安装 + 重启

```bash
cd /media/dp25/DATA/deb/fcitx5-deb/github/electerm
chmod +x run-bdebfast.sh
./run-bdebfast.sh                    # 全流程 (patch locales → compile → bdebfast → install → start)
./run-bdebfast.sh --skip-compile     # 只改了 locales 或 store 逻辑 (客户端 bundle 未变)
./run-bdebfast.sh --prepare          # 强制重建 work/app/node_modules (node-pty 缺失等)
```

## 遇到过的坑 (已在脚本里固化)

| # | 坑 | 脚本里的修 |
|---|---|---|
| 1 | Node 22 PATH 没 export → 系统 node(v12/v18) 抢跑 | 脚本第一行 export |
| 2 | `work/app/node_modules` 独立副本, patch 一处漏一处 | patch-locales.js 两处都 patch |
| 3 | `pkill -f /opt/electerm/electerm` 会自杀 | 转义成 `pkill -f "[/]opt/electerm/electerm"` |
| 4 | 测试包版本号相同 → dpkg -i 拒绝覆盖 | `--force-overwrite` |
| 5 | compile silently fail, 实际无 css 产物 | 脚本里实查 `work/app/assets/css/style-*.css` |
| 6 | Electron 42 缓存 chunk, 换 asar 仍读旧版本 | 清 Cache + GPUCache + Code Cache |
| 7 | postinstall 自动 patch 但 work/app 重建后没跑 | bdebfast 内部 `npm i` 完 postinstall 会触发, 脚本开头主动再跑一次 |

## 清缓存范围

```bash
rm -rf ~/.config/electerm/Cache          # 主进程/渲染层通用 HTTP 缓存
rm -rf ~/.config/electerm/GPUCache       # GPU 渲染缓存
rm -rf ~/.config/electerm/Code\ Cache    # V8 bytecode / 预编译代码缓存
```

## tail 日志

```bash
tail -f /tmp/electerm.log
```
