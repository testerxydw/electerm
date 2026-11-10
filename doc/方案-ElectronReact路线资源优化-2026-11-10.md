# 方案-Electron+React路线资源优化-2026-11-10

> 定位：**坚持当前 Electron+React 架构**的资源优化整合方案。全部结论有源码/实测依据。
> 多端范围：Win/macOS/Linux × x64/arm64；`web-app/` Web 版形态同套代码。
> 换框架/换壳/自绘等对比评估（Tauri / Rust / 自绘 / Flutter vs Qt）已完成使命，
> **归档于 git 历史**（commit `ef42ec50` 及此前版本），本文档不再维护对比内容。

## 0. 结论速览

| 议题 | 结论 | 依据 |
|---|---|---|
| 最大内存项 | **自建「每 tab 一子进程」策略**（实测 65MB/会话），非 Electron 本体 | §2 |
| P0 优化 | 会话进程池化 / 窗口加载与后端并行 / show 时序 | §3 |
| P1 优化 | sqlite 适配器挪 worker（D1）· antd6 cssVar | §4.2、§6 |
| 打包瘦身 | **已执行，-5MB** | §5 |
| 懒加载 | 架构已达标，无高收益收口点 | §7 |
| 数据库功能 | 工程质量全仓最高，无资源级问题 | §4 |
| 总预期 | P0 全做完：10 tab 场景 600MB→200MB 级，冷启动 -300~600ms，约 3-4 人周 | §3、§8 |

## 1. 资源占用实测构成

| 占用项 | 实测 | 说明 |
|---|---|---|
| Electron 本体 | node_modules 284MB；运行时空载基线 **230MB PSS**（Xvfb 实测，6 进程） | 框架固有，优化空间不在此 |
| **会话子进程** | 空 node 44MB；载会话栈 **65MB RSS**；N tab = N × 50-70MB | **全应用最大项，见 §2** |
| 渲染层 JS | 产物 24MB（磁盘）；主 bundle 仅 636KB | 内存小头 |
| antd 运行时 | cssinjs 引擎 1MB、CSS 产物 216KB | 小头 |
| node_modules 进包 | 70MB → **65MB**（§5 瘦身后） | — |
| xterm 多实例 | 每实例数 MB（scrollback 默认 3000，已有设置项） | 不动 |

## 2. 进程模型实测——全局最大内存项

真实进程架构（`create-app.js` → `init-server.js` → `session-process.js`）：

```
electron main
 ├─ fork → server.js          后端 express 全量（15.5k 行），启动即驻留
 └─ 每开一个会话 tab → fork → session-server.js   ★ 按 uid 每会话一进程
      （该子进程内载 express + 会话类型栈 + zmodem/trzsz/xmodem）
```

**实测数据（本机，node 22）**：空 node 子进程 44MB；加载完整会话栈（express+ssh2+sftp+ftp+zmodem+trzsz）**65MB**。

**推论**：10 个 SSH tab ≈ **600MB 级子进程内存**，超过 Electron 本体基线。此前对 Electron 的内存劣势评估，相当一部分来自这个自建策略，而非 Chromium 本身；渲染层（React/xterm）反而是小头。

设计意图（须保留的正当性）：会话级隔离——单个会话 crash 不拖垮其它 tab；`session-process.js` 已有 orphan 追踪（`firstWsConnected`）。

## 3. P0 优化项矩阵（按收益/成本排序）

### P0-1 会话进程池化（最大单项收益）

| 子方案 | 10 tab 内存 | 隔离性 | 成本 |
|---|---|---|---|
| 现状：每 tab 一子进程 | ~600MB | 最强 | — |
| 按类型池化（ssh 一进程、sftp 一进程…） | ~150MB | 类型内互染 | 1-2 人周 |
| 全局单池 + crash 自动重启该会话 | **~100MB（-83%）** | 弱（依赖重启补偿） | 2-3 人周 |
| **双模式：默认池 + 设置项「高隔离模式」回退（推荐）** | 按选择 | 可选 | 3 人周 |

关键改动点：`session-process.js` 的 `activeTerminals`（pid→child 映射）与 ws 路由（现按子进程独立端口分发）→ 池内改按 uid 多路复用；`remote-common.js` 的全局 Map 天然支持同进程多会话。风险集中点：zmodem/trzsz 传输中的会话 crash 补偿。

### P0-2 窗口加载与后端启动并行（启动时间）

`create-window.js:108` `await initAppServer()` 阻塞 `loadURL`——首窗要等后端 fork + require 完。后端图实测冷 require 量级：express 143ms + transfer/ssh2-scp ~50ms + Electron-as-node 启动 ~100ms ≈ **300-600ms 纯串行等待**。改为 `initAppServer()` 不 await、与 `loadURL` 并行（renderer 的首个请求自带服务就绪语义/重试），冷启动省这整段。成本 1-2 天，风险低。

### P0-3 首帧白屏消除

BrowserWindow 未设 `show:false` + `ready-to-show`，窗口先以 backgroundColor 上屏再等渲染完成。加 `show:false` + `once('ready-to-show', () => win.show())`，半天。

### P1 与微项

- **P1-1 sqlite 适配器挪 worker（D1，详见 §4.2）**。
- **P1-2 antd6 `cssVar: true`**（§6）：切主题零重注入 + 省运行时 style 标签，`main.jsx:377` ConfigProvider 一行；与暗色切换卡顿优化合并做。
- **P2 后端 require 进一步懒加载**：`session.js:11` 已按类型动态 require（好评）；`server.js → dispatch-center → transfer.js` 顶层的 ssh2-scp 全图可下沉到首次 sftp 请求。收益仅 ~50-100ms，优先级低。
- **P2 死字段**：`src/build/vite/conf.js:64` `codeSplitting:false`——Vite/Rollup 均无此选项，删除即可。
- 已达标不动：xterm WebGL 熔断器 + DOM 回退；scrollback 设置项；pug 不在运行路径。

## 4. 数据库功能专项分析

### 4.1 架构事实（实测源码链路）

- DB 连接全部驻留 **Electron 主进程**：`ipc.js:462-467` ipcMain handlers → `db-client/index.js` per-tab instances Map（含 ssh tunnel，`db-tunnel.js` 用 @electerm/ssh2 forwardOut）。
- 驱动懒加载到位：mysql2/pg/ioredis 全部函数体内 require，首连才付成本。
- 取数纪律：分页 `LIMIT pageSize+1 OFFSET`；二进制 64KB inline 上限 + 4KB 预览；redis 大 hash HSCAN 游标分页（不 hgetall）。
- 缓存与生命周期：列/结构缓存 LRU 淘汰；tab 关闭 `pool.end()`；mysql 池 `connectionLimit: 4`。
- 导入/导出：insert 按字节量切批（`insert-batch.js`）；导出流式 `writeChunk` 带背压检查。
- 渲染层：`DbGridTable` 统一虚拟滚动（`virtual={y>0}`）；db-session 是 lazy chunk；零处大对象深拷贝。

### 4.2 实质优化项（唯二）

- **D1（P1，1-3 天）sqlite 适配器挪出主进程**：`sqlite.js` 用 node:sqlite `DatabaseSync`——同步 API 直接阻塞主进程，现靠行数上限兜底（分页 1000 / executeSql 10000），大查询/导入期间**所有 tab 包括终端**都会卡。代码头注释自认欠账「彻底解决需挪 worker」；对外接口已是 async 门面，改内部 worker_threads 通信即可。
- **D2（P2，中期）db-client 迁往后端子进程**：DB 池与 CPU 密集后处理（structure-v2 结构对比、CSV 构建、import parsers）在 main 事件循环，大 schema 对比/大文件解析的同步段拖全应用输入延迟。迁到 `server.js` 后端子进程（协议层驻地）后主进程只剩路由。需梳理 tunnel 生命周期与 ipc→ws 通道改造，收益是「更稳」而非「救火」。

### 4.3 确认无动作清单

DB 板块工程质量全仓最高：驱动懒加载 ✓、LRU 缓存 ✓、分页+虚拟滚动 ✓、大 hash HSCAN ✓、导入批量切分 ✓、导出流式+背压 ✓、二进制截断 ✓、tab 关闭释放连接 ✓。多 tab 全挂载属 sessions.jsx 统一 keep-alive 策略（tab 冻结已否决，不在 DB 板块单独开刀）。

## 5. 已执行：打包瘦身（-5MB）

**根因**：`build-deb-fast` 增量路径不重跑 `prepare.js`，依赖更新后 `npm i` 把浏览器构建冗余重新带进产物（axios/dist 残留即证）。

**方案**：`src/build/bin/prune-node-modules.js` 幂等清理模块，`prepare.js` 与 `build-deb-fast.js`（asar 打包前第 5.5 步）共用同一清单。

| 清理项 | 体积 | 入口依据（只删 require 解析不可达） |
|---|---|---|
| `node-forge/dist` | 604K | main=lib/index.js，包无 exports 字段 |
| `pako/dist` | 484K | exports["."].require=index.js |
| `trzsz2/dist/browser` | 180K | exports["."].require=dist/cjs-full/index.cjs |
| `sm-crypto-v2/miniprogram_dist` | 172K+ | 小程序构建 |
| `axios/dist/{esm,browser,...}` 等 | ~400K | main=dist/node/axios.cjs |
| node-pty 对端平台文件/测试文件 | — | electron-rebuild 只构建本平台 |

**保留**：`@electerm/electerm-themes/dist`（main 即指向）、`aws-ssl-profiles` CA 表（mysql2 运行时用）。

**实现要点**：删除走 `rmForce`（fs.rmSync → 原生 `/bin/rm` 兜底）——node 安全 shim 会拦 shelljs rm（实测踩中）；失败只警告不中断打包；node-pty 清理按 `process.platform` 判定对端，多架构同逻辑。

**验证**：五包入口 require 全 OK；node_modules 70MB→65MB；lint 0。

## 6. antd6 cssinjs：cssVar 模式可选

- 现状（`store.js:344-370`）：`uiThemeConfig` token 全部来自用户主题运行时取值，`algorithm` 按 `isColorDark(themeConf.main)` 动态切换亮/暗。
- **完全静态化（编译期提取）不可行**——会砍掉「用户自定义主题 + 亮暗动态切换」的产品能力。
- **cssVar 模式可选**（`ConfigProvider theme={{ cssVar: true }}`）：token 转 CSS 变量，组件样式只注入一次、切主题只改变量值。兼容性无虞（Chrome 49+；legacy 分支 Electron 22 = Chrome 108）。收益是切主题流畅度 + 少量 style 标签内存，非资源刚需。
- 重要事实（纠正过一次误判）：antd6 默认 `hashPriority:'low'`，hashId 注入为 `:where(.css-hash)`，`:where()` 特异性为 0——SSOT 的 `!important` 覆盖**不受压制**（`@ant-design/cssinjs/es/util/index.js:145`，全局探针 74/74 佐证）。

## 7. 懒加载：已达标

- 主 bundle 636KB；`db-session`/`web-session`/`spice-session`/`SqlCodeEditor`（codemirror 376K）全部已是 React.lazy 按需 chunk；24MB 是全量 chunk 磁盘体积，非内存。
- `db-session.jsx` 4826 行可再按低频子功能（ER 图、结构对比、SQL AI）拆动态 import，收益仅几十 ms 量级，优先级低。
- 结论：架构已良好，无高收益收口点。

## 8. 明确不做

- tab 冻结（用户已否）· scrollback 调优（已有设置项）
- 换 UI 框架 / 换组件库 / cssinjs 静态化（换框架对比评估已归档 git 历史，结论均为「不做」）
- V8 `--max-old-space-size` 收紧（收益微小、OOM 风险不成比例）
- HTTP loopback 改自定义协议（web-app 同构是资产，不动）

## 9. 总判定

Electron+React 路线**没有结构性死穴**：渲染层（React 19/antd6/xterm WebGL）与后端分层已是良好形态；内存与启动的真实杠杆全部在**自建进程模型**手里。

| 项 | 收益 | 成本 | 建议 |
|---|---|---|---|
| P0-2 加载并行 + P0-3 show 时序 | 冷启动 -300~600ms、无白屏 | 2-3 天，低风险 | **先行落地** |
| P0-1 会话池化（双模式） | 10 tab 600MB→按选择 ~100-150MB | 3 人周 | 第二步，保隔离回退 |
| D1 sqlite 挪 worker | 大查询/导入不再卡全应用 | 1-3 天 | **尽快做**，消全局隐患 |
| P1-2 antd cssVar | 切主题流畅 | 半天-1 天 | 与暗色切换优化合并 |

## 附：redis 命令控制台双滚动条（已修复）

根因：suggest 浮层 `position:absolute` 溢出后代计入 `.ant-modal-body` scrollHeight，撑出假溢出滚动条（`.ant-modal-body` 修复前 sh309>ch210 → 修复后 sh432=ch432）。修复为文档流化 + spec 反向锁定，定向探针 9/9 PASS。详见 commit `a3219412` 与 `self-test/db-redis-console-scroll-probe.js`。**该范式适用于一切弹层内浮层：浮层一律文档流化，不修样式遮盖。**
