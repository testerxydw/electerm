# electerm 上游 Issues 分析与修复方案

> 数据：electerm/electerm 当前 open issues 前 100 个（截至 2026-09-24，#3998–#4549）
> 方法：全部 100 个初筛分类 → 35 个 bug 嫌疑取 body 详情 → 3 组并行子代理对照**本地 5.5.26 源码**逐个代码级验证
> 结论：**14 个确认真实 BUG**（含代码级证据与修复方案）· 5 个旧版报告已修 · 4 个属功能需求非 BUG · 6 个需特定环境复现

---

## 一、分类统计

| 类别 | 数量 | 代表 |
| --- | --- | --- |
| ✅ 确认真实 BUG（代码级） | **14** | #4539、#4378、#4251、#4520、#4004… |
| 📦 旧版报告，当前已修 | 5 | #4121、#4161、#4496、#4434、#4446 |
| 🔧 功能需求（非 BUG） | 4 + 约 36 | #4549 分屏拖拽（未实现）、#4467 VNC 传文件（协议边界） |
| 🖥 需特定环境复现 | 6 | #4398 树莓派 VNC、#4273 mac、#4386 rsync 吞吐 |
| ⚡ 性能/资源类（非崩溃） | 4 | #4462、#4386、#4490、#4144 |

---

## 二、确认的真实 BUG 与修复方案（按优先级）

### P0 · 崩溃与数据丢失

#### 1. #4378 `Cannot destructure property 'conn' of 'terminalInst'`（崩溃，高置信）
- **根因**：`src/app/server/session-sftp.js:56-59` 直接解构 `getSession(initOptions.terminalId)` 的返回值；终端会话已销毁/重连后 terminalId 失效（代理书签场景更易触发）时返回 undefined → 整进程崩溃。
- **修复**：加守卫 `if (!terminalInst?.conn) throw new Error('terminal session not found: ' + initOptions.terminalId)`，让上层走既有的 sftp 初始化失败通知，而非崩溃。

#### 2. #4520 Mac Intel 书签重启丢失（数据丢失，中置信）
- **根因**：bookmarks 为加密表（`sqlite.js:13`），解密走 macOS Keychain（`safe-storage.js:53-66`）。`safeDecrypt` 失败时**静默返回密文原串** → `sqlite.js:104-108` JSON.parse 抛错被 catch → `toDoc` 只返回 `{_id}`，**整行字段全丢且无任何报错**。Keychain 拒访/应用换签名后即复现。
- **修复**：`sqlite.js:104` 解析失败保留原始 data 并上报错误；`safe-storage.js:62` 解密失败 `log.error` 带上下文，禁止静默吞掉。

#### 3. #4251 上传超过 5 个文件卡死（死锁，高置信）
- **根因**：并发上限 5（`constants.js:42`）；第 6 个的启动依赖全局串行队列（`transfer-queue.jsx:25-38`），单条 op 未 resolve 则**整队列永久阻塞**（无 try/finally、无超时）；`inited` 完成判定依赖 autoRun 反应链，任一环不触发即死锁；队列全局驻留，重连不恢复 → "必须重启"。
- **修复**：① executeOperation 加 try/finally + 兜底超时；② inited 类 update 改同步 applyChanges 后直接 resolve；③ control() 在 delete 路径直接调用，不依赖 `fileTransferChanged` 的 JSON 差异比较。

### P1 · 高频体验缺陷

#### 4. #4539 终端主题 `terminal:background` 不生效（高置信）★
- **根因**：`terminal-color-query.mjs:178-184` `createRendererThemeConfig` **无条件**把 xterm background 置为 `'rgba(0,0,0,0)'`，可见背景由 CSS 承担（`terminal.styl:2,21` 固定 `var(--main)`）；`term-theme.js:80-93` 取可见背景时优先 uiThemeConfig.main，themeConfig.background 仅末位回退。即 background 键被**设计性丢弃**，与 issue 完全吻合（其余键正常）。
- **修复**：未配置终端背景图时（`terminalBackgroundImagePath` 为空），改用 `themeConfig.background` 作为可见背景并在 term 容器加内联 backgroundColor 覆盖 `var(--main)`；有背景图时维持现状。

#### 5. #4499 + #4501 + #4065 长时使用/长命令渲染错乱（根因：xterm beta）
- **根因**：`package.json:74` 锁定 `@xterm/xterm 6.1.0-beta.292`（非稳定版）；beta 的 reflow 重写（xterm.js#5321）导致回绕重排错乱；reload 恢复（`term-socket.js:419-432`）把已污染 buffer 原样重放，无法自愈。
- **修复**：① 升级 xterm 至 6.1 稳定版（根治）；② reload 时先 `term.reset()` 再重放；③ 临时规避：rendererType 切 webgl（`term-theme.js:19-36` 已支持）。

#### 6. #4252 + #4154 + #4090 TUI 应用（claude code / opencode / neovim）错行（高置信）
- **根因**：`attach-addon-custom.js:196-204` 注释自认：TUI 用 `ESC[nA` 回退重绘，触发 2M 字符丢帧（`:562-575`）即损坏屏幕；`:56-82` 幸存帧头部光标操作又被 `stripLeadingCursorOps` 剥离 → 重绘落错行。
- **修复**：`buffer.active.type === 'alternate'` 时**跳过合并/丢弃/剥离**（TUI 流必须无损直写）；右键菜单在 alternate 下仅走 xterm（`terminal.jsx:371` 双处理叠加一并修）。

#### 7. #4004 打开 SFTP 后"选中即复制"失效（高置信）
- **根因**：`term-context-menu.jsx:131-137` 在 `window.store.onOperation` 为真时跳过自动复制；而 `store.js:256-264` 的 onOperation **包含 `showFileModal`**——SFTP 文件面板打开即置真，选词复制被静默禁用。
- **修复**：onSelection 判断中排除 showFileModal（或仅当模态真正遮挡终端时禁用）。

#### 8. #4055 SFTP 切到 / 目录多出几个目录、点击错位（高置信）
- **根因**：`sftp-entry.jsx:690-708` 首次列表对软链接项 `isDirectory:false` 先渲染成文件；`:837-875` 再逐链接 `getRemoteFileInfo`（每链接一次 stat 往返）二次 setState，链接目录"跳"进目录区，行位置变动破坏点击。
- **修复**：对 isSymbol 项并行 stat、一次性合并后再 setState；或渲染用稳定 key 保持行位置仅改图标。

#### 9. #4535 Windows 远端书签"开始目录：远程"无法跳转（高置信）
- **根因**：`startup-queue.js:159-161` 对 SSH 远端一律按 posix 生成 `cd -- 'C:/'`；仅本地 Windows 走 `cd /d`。
- **修复**：startFolder 匹配 `/^[a-zA-Z]:/` 或含 `\` 时改发 `cd /d "..."`（正斜杠转反斜杠），或连接后探测远端平台再下发。

#### 10. #4216 最小化一段时间后恢复界面无文本（高置信）
- **根因**：全库无终端 repaint 的 visibilitychange 处理；最小化→恢复不触发 resize/onResize，DOM renderer 不重绘（选中触发重绘恰好解释症状）。
- **修复**：terminal.jsx 注册 `document.visibilitychange` + `window.focus` → 调用现成的 `fitAndRefresh()`（term-resize.js:25），卸载注销。一行级修复。

### P2 · 中低频

#### 11. #4481 输出内容间大量空行（中置信）
- **根因**：`attach-addon-custom.js:562-575` 超 2M 字符丢旧数据 + 丢处插入 `\r\n` 标记 + 头部光标操作剥离，PowerShell/PSReadLine 重绘流被丢帧后留下空行带。
- **修复**：丢帧标记改不占行（OSC 通知而非写入终端）；提高 PowerShell 类输出阈值。

#### 12. #4464 AI 代理设置不生效（中置信）
- **根因**：链路完整，但 `proxy-agent.js:2-8`：代理串不含 `http`/`socks` 前缀（裸填 `127.0.0.1:7890`）时**静默返回 undefined**，请求直连无提示——最可能的用户踩坑点。
- **修复**：createProxyAgent 对无 scheme 输入自动补 `http://` 或向 UI 返回明确错误。

#### 13. #4397 下载到 Windows 根盘符报错（中置信）
- **根因**：`file-read.js:89-98` 把 `C:\` 解析为 `{path:'/',name:'C:'}`；盘根时 `resolve(base,'..')` 返回 `'/'`，上级项经拖放可产出 `//name` UNC 非法路径。5.5.x 已加特判但仍有漏洞。
- **修复**：本地路径匹配盘根模式时 resolve 返回盘根且不渲染上级项；transfer 前校验 toPath 合法否则回退当前目录。

#### 14. #4319 串口洪流滚动锁定后无法选中（中置信，需部分环境验证）
- **根因**：16ms 合并写入（`attach-addon-custom.js:515-548`）使 xterm 选区锚定随滚动失效。
- **修复**：检测 `hasSelection()` 时暂缓 `_flushWrites`（≤500ms）再恢复。

---

## 三、旧版报告，当前已修（建议回复 issue 请报告人确认）

| # | 问题 | 当前状态 |
| --- | --- | --- |
| #4121 | 复制换行断截 | 隐藏标签 fit 出 0 列致 pty 硬换行——已由 term-init/term-resize/terminal.jsx 四处可见性守卫修复（2.3.113 旧版报告） |
| #4161 | Tab 补全显示问题 | 同上根因，`term-socket.js:244` 已保证 pty 尺寸同步 |
| #4496 | Telnet 日志丢失 | `session-base.js:126-140` 已做 `\r→\r\n` 归一化；进度条类原地重写仅记录终态属 VT 固有 |
| #4434 | 时间戳前缀缺失 | 同 #4496 修复；流式分片延迟为固有 |
| #4446 | 窗口拖出屏幕无法恢复 | `window-restore.js:77-93` + `create-window.js:69` 已有 safety net（报告版本 1.34.39 过时）；可选：运行期 move 事件钳制 |

## 四、非 BUG（功能需求 / 协议边界）

| # | 内容 | 定性 |
| --- | --- | --- |
| #4549 | 分屏后不能拖动调大小 | **未实现功能**（全库无 split 分隔条实现），需新增拖拽组件 |
| #4542 | 终端背景图不铺满 | 弱缺陷：`.xterm-screen::before` 无 `background-size`——加 `cover` 一行即改善 |
| #4117 | 分屏背景图重复 | 每个分屏各自挂背景层；修复需把背景层上移到 `.terms-box` 父容器（结构调整） |
| #4467 | VNC 不能传文件 | RFB 协议本身不传文件，功能边界 |

## 五、需特定环境复现（本地无法证伪）

#4273（mac Ctrl+C：疑选区劫持+transfer isActive 卡死两嫌疑，已有代码线索）、#4398（树莓派 RealVNC RA2 加密，noVNC 不支持，需服务端换 TigerVNC 验证）、#4276/#4467（麒麟 VNC 剪贴板：客户端双向同步代码已完备 `vnc-session.jsx:425-473`，疑服务端不回发 CutText）、#4477（大文件断连：无断点续传+固定 64×32KB 参数，建议加可配+续传）、#4386（rsync 慢：PTY 链路吞吐需 profile）、#4387（aarch64 崩溃需设备）。

## 六、其余 60+ 个：功能请求与体验建议

侧栏宽度/串口增强/sz 默认路径/会话钉住/托盘最小化/expect 自动化/keepalive/MCP 配置编辑/批量输入优化等——均为 enhancement，不属本报告 BUG 修复范围，已归类存档于 issue 清单。

---

## 七、修复优先级路线图

| 批次 | 内容 | 理由 |
| --- | --- | --- |
| P0 | #4378 崩溃守卫、#4520 解密失败不静默、#4251 队列 try/finally | 崩溃/数据丢失，改动小 |
| P1 | #4539 背景色（1 处改动）、#4004 排除 showFileModal、#4535 cd /d、#4055 并行 stat、#4216 visibilitychange、xterm 升稳定版 | 高频，多数是小改动；xterm 升级需回归测试单列 |
| P2 | TUI alternate 直写、#4481 丢帧标记、#4464 补 scheme、#4397 盘根、#4319 选区暂停 | 涉及传输核心逻辑，需单测配套 |
| 上游 | xterm 6.1.0-beta → 稳定版依赖升级 | 根治 #4499/#4501/#4065/#4252/#4154/#4090 六个渲染错乱类 |
