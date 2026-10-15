# TODO：顶栏 / 显示页统一 执行计划

> 依据：`doc/分析-终端与数据库页顶栏与显示页统一方案.md`（A' 方案，§十一起）
> 图例：`[ ]` 未做 · `[x]` 已完成 · ⏸ 暂缓待拍板
> 顺序即依赖顺序：S0 → S1 → S2 → S3 → S4 →（可选 S5/S6）

## 0. 每条的通用流程（做任何一条都按这个来）

1. 改码 → `npx standard <改动文件>` → `npm run test-unit-ci`（当前 832/832）→ `npm run compile`
2. CDP 实测（**独立端口** + 独立 profile）：
   `DISPLAY=:99 node_modules/.bin/electron work/app/app.js --no-sandbox --disable-gpu --user-data-dir=/tmp/electerm-todo --remote-debugging-port=9333`
3. 一个点一次提交（只 `git add` 相关文件），推送 origin
4. ⚠️ 改 `.styl` / store 方法**必须**跑 `test-unit-ci`（pre-push 只跑 standard，CSS 契约与单测不在这里）

---

## 1. 已完成（勿重做）

- [x] 数据库页自渲染顶栏 `.db-head` + 引擎工具条（`b6a5597d`…`40b33526`）
- [x] 顶栏全屏入口恢复（`f23f1949`）
- [x] 页面内查找：高亮 + `(n)` 计数（`8bffcbe9`）
- [x] 空窗格一键关闭 + `autoCloseEmptyPane` 开关（`6c6d3a3f`/`e9757bb8`/`7bdde3d9`/`87f4f98f`）
- [x] 数据库页底部留白修复（`4ab6164a`）
- [x] SSH/SFTP 拆分底部错位修复（`2997836a`）
- [x] run-bdebfast Node22 检测 + 依赖预检（`131d0ceb`）
- [x] 关键字预设「Database & SQL」分组（`4ddf4c87`）

---

## 2. 待执行（按序）

### S0 · RemoteSessionShell → 通用 SessionShell（**下一步，零行为变化**）
- [ ] `common/remote-session-shell.jsx/.styl` 重命名/导出为 `SessionShell`（保留旧名导出兜底亦可）
- [ ] rdp / vnc / spice 三页改引用
- 验收：三页 CDP 行为与改前逐项一致（控制条位置、浮层、全屏、缩放）
- 提交：`refactor(ui): RemoteSessionShell → 通用 SessionShell`

### S1 · 窗口级动作共享（SessionBarActions）
- [ ] 新建 `common/session-bar-actions.jsx`：`{ searchOpen, onToggleSearch, onFullscreen }`
- [ ] 终端 `SessionControl` 右侧、DB `.db-head-actions` 改用它
- [ ] **telnet**：从 `isNotTerminalType` 的"关 bar"名单移出，接入 shell + 动作（补齐查找/全屏）
- [ ] **web**：补全屏入口（现在整类缺失）
- 验收：telnet 有查找/全屏且行为与终端一致；web 出现全屏；三页位置/tooltip 一致
- 提交：`refactor(ui): 抽 SessionBarActions + telnet/web 接入`

### S2 · 骨架与高度 token 单点化
- [ ] 新增 token `--session-bar-h: 32px`（`css/includes/tokens.styl`）
- [ ] 终端 `.terminal-control` / DB `.db-head` 都改用；DB 侧去掉 `session.jsx:241` 的 `+ termControlHeight` 补偿
- [ ] 标签栏三个数字收敛：`store.tabsHeight(36)` / `session.styl padding-top 36px` / `tabs.styl height 38px`
- 验收：各页顶栏高度/分隔线一致；DB `gapBelowBox === 0`；`test-unit-ci` 通过
- 提交：`refactor(ui): 顶栏骨架与高度 token 单点化`

### S3 · SearchBar（UI 与引擎分离）
- [ ] 新建 `common/search-bar.jsx`：输入框 + `(i/n)` + 上一个/下一个 + 关闭 + Esc
- [ ] 终端 `TermSearch` 改用它（大小写/整词/正则按钮作为插槽）
- [ ] DB 页查找改用它，注入 DOM provider（`find/clear/count`，`canScroll=false` → 隐藏上下一个）
- 验收：终端全部行为不变；DB 现有行为不变
- 提交：`refactor(ui): 抽 SearchBar（UI 与引擎分离）`

### S4 · DB 查找补「上下一个 + 当前命中两色」
- [ ] provider 实现 next/prev（命中位置数组 + `scrollIntoView`）
- [ ] 当前命中用 `--primary` + 外描边，其余命中弱化色
- 验收：`n/m` 计数正确、两色区分、循环导航
- 提交：`feat(database): 查找支持上下一个与当前命中`

### S5 ⏸ · 内容区全量 flex 列模型（可选，单独立项）
- [ ] `.session-wrap` 改 flex 列（去 `padding-top 36px` 抵消）；内容区 `flex:1 1 0; min-height:0`
- [ ] 删除 `computeHeight` 的 32 扣减与 DB 补偿
- ⚠️ 风险：xterm `fit()` 时机、**隐藏标签守卫 `isElementVisible()` 必须保留**、分栏/全屏/web/rdp 六项回归
- 建议先做终端侧验证，再让 DB/web 复用

### S6 · 数据库字体与终端统一（§十 方案 1）
- [ ] `DbSession` 根部注入 `--db-code-font`（`tab.fontFamily || config.fontFamily` + `--font-mono` 兜底）
- [ ] 网格单元格 / 键列表 / SQL 编辑器 / 值预览 / 原始错误改用；`font-variant-ligatures: none`
- [ ] `css-tokens.spec.js` 白名单加入 `--db-code-font`（运行时注入变量，否则 CI 红）
- [ ] 树里的对象名（库/表/键名）是否一并使用 → 待拍板（建议一并，便于整体回退）
- ⏸ 字号跟随终端：**暂不做**（要做需独立配置项 + clamp + 行高联动）
- 验收：CDP 截图对比列对齐/中文混排；`test-unit-ci` 通过

---

## 3. 待拍板（不阻塞 S0~S4）

| 项 | 问题 | 现状/建议 |
| --- | --- | --- |
| 1 | `autoCloseEmptyPane` 默认开还是关 | 现在关；建议保持关 |
| 2 | 字体统一范围（S6） | 建议方案 1（只字体族） |
| 3 | 树对象名是否算数据面 | 建议算 |
| 4 | 是否向上游提 PR | `SearchBar`/`SessionShell` 稳定后；另有 `fix/window-control-icons` 分支未提 |

## 4. 已知限制（记录，不排期）

- 查找无法高亮 textarea（SQL 编辑器、Redis 原始 JSON）
- `splitTab` 刻意不触发空窗格自动收起（否则撤掉分屏）
- 等宽字体的 CJK 混排列宽不齐（DOM 无法像 xterm 那样统一 cell 宽度）
- MySQL 侧功能（单元格编辑/树过滤/字体效果）需真实库验证（本机无 mysqld）

## 5. 一句话

**先 S0（零风险地基），再 S1/S2 拿到"动作不丢 + 口径单点"的核心收益，S3/S4 补齐查找体验，S6/S5 视情况再做。**
