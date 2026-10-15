# TODO：顶栏 / 显示页统一 执行计划（全项目通盘）

> 依据：`doc/分析-终端与数据库页顶栏与显示页统一方案.md`（A' 方案）+ 2026-10-15 全文档通盘整理
> 汇总来源：统一方案、SSH/SFTP 错位分析、关键字同步方案、数据库设计（阶段1/2）+ 实现审计、分屏空窗格设计、快速命令带设计、上游 issue 分析、表格滚动条方案
> 图例：`[ ]` 未做 · `[x]` 已完成 · ⏸ 暂缓待拍板 · 🔥 高优先
> 顺序即依赖顺序：S0 → S1 → S2 → S3 → S4 →（可选 S5/S6）

## 0. 每条的通用流程（做任何一条都按这个来）

1. 改码 → `npx standard <改动文件>` → `npm run test-unit-ci`（当前 845/845）→ `npm run compile`
2. CDP 实测（**独立端口 9333** + 独立 profile + **DATA_PATH 隔离**，勿写用户真实配置）：
   `DISPLAY=:99 node_modules/.bin/electron src/app/app --no-sandbox --disable-gpu --remote-debugging-port=9333`（dev server `npm start` :5570 + HMR；改 `src/app/**` 需 `cp -r src/app/. work/app/`）
3. 一个点一次提交（只 `git add` 相关文件），推送 origin
4. ⚠️ 改 `.styl` / store 方法**必须**跑 `test-unit-ci`（pre-push 只跑 standard，CSS 契约与单测不在这里）
5. ⚠️ 数据库相关验证：本机无 mysqld/redis —— MySQL 走真实库（192.168.115.67:13306 tgfsom）或 CDP 假数据；Redis 走假 RESP server（~100 行，见 2026-10-15 记忆）

---

## 1. 已完成（勿重做）

- [x] 数据库页自渲染顶栏 `.db-head` + 引擎工具条（`b6a5597d`…`40b33526`）
- [x] 顶栏全屏入口恢复（`f23f1949`）+ 页面内查找：高亮 + `(n)` 计数（`8bffcbe9`）
- [x] 空窗格一键关闭 + `autoCloseEmptyPane` 开关 + 拖走/搬空场景（`6c6d3a3f`…`87f4f98f`）
- [x] 数据库页底部留白修复（`4ab6164a`）；SSH/SFTP 拆分底部错位修复（`2997836a`）
- [x] run-bdebfast Node22 检测 + 依赖预检（`131d0ceb`）；关键字预设「Database & SQL」分组（`4ddf4c87`）
- [x] 数据库阶段1（连接管理）+ 阶段2 S1~S6 + 审计 R1~R6 修复（P0×3、P1-4/5/6/8/9/10/11/18、P2-17/21 均已修）
- [x] **数据库网格横向滚动条统一（DbGridTable，7 处）**：表体 scroll.y 定高 → 横滚条常驻可视区底边 + 表头吸顶；真实库（tgfsom.tgfsom_operation_log 24 万行）验证 data/SQL/表结构三处，假 Redis 验证键列表/hash 详情；顺带修三处布局塌陷（redis-keys basis 0 / struct-area tabpane / sql-result Spin 传高）——**改动未提交，见 §2-0**
- [x] 配套单测 `src/test/unit-ci/db-grid-scroll.spec.js`（13 用例：y 推导真实源码 + 接线契约 + CSS 布局契约）

---

## 2. 待执行（按序）

### 2-0 · 🔥 提交在途（用户复测通过即提交）
- [ ] `fix(database): 数据网格横向滚动条沉底，统一 DbGridTable 定高滚动并吸顶表头`（`db-session.jsx` + `db-session.styl` + `db-grid-scroll.spec.js` + 方案文档）
- [ ] 用户真机 Redis 页复测（选库出键列表 / 点键出详情 / 宽键名横滚条位置）

### S0 · RemoteSessionShell → 通用 SessionShell（**下一步，零行为变化**）
- [ ] `common/remote-session-shell.jsx/.styl` 重命名/导出为 `SessionShell`（保留旧名导出兜底亦可）
- [ ] rdp / vnc / spice 三页改引用
- 验收：三页 CDP 行为与改前逐项一致（控制条位置、浮层、全屏、缩放）
- 提交：`refactor(ui): RemoteSessionShell → 通用 SessionShell`

### S1 · 窗口级动作共享（SessionBarActions）
- [ ] 新建 `common/session-bar-actions.jsx`：`{ searchOpen, onToggleSearch, onFullscreen }`
- [ ] 终端 `SessionControl` 右侧、DB `.db-head-actions` 改用它
- [ ] **telnet**：从"关 bar"名单移出，接入 shell + 动作（补齐查找/全屏）
- [ ] **web**：补全屏入口（现在整类缺失）
- 验收：telnet 有查找/全屏且行为与终端一致；web 出现全屏；三页位置/tooltip 一致

### S2 · 骨架与高度 token 单点化
- [ ] 新增 token `--session-bar-h: 32px`（`css/includes/tokens.styl`）
- [ ] 终端 `.terminal-control` / DB `.db-head` 都改用；DB 侧去掉 `session.jsx` 的 `+ termControlHeight` 补偿
- [ ] 标签栏三个数字收敛：`store.tabsHeight(36)` / `session.styl padding-top 36px` / `tabs.styl height 38px`
- 验收：各页顶栏高度/分隔线一致；DB `gapBelowBox === 0`

### S3 · SearchBar（UI 与引擎分离）
- [ ] 新建 `common/search-bar.jsx`：输入框 + `(i/n)` + 上一个/下一个 + 关闭 + Esc
- [ ] 终端 `TermSearch` 改用它（大小写/整词/正则按钮作为插槽）
- [ ] DB 页查找改用它，注入 DOM provider（`find/clear/count`，`canScroll=false` → 隐藏上下一个）

### S4 · DB 查找补「上下一个 + 当前命中两色」
- [ ] provider 实现 next/prev（命中位置数组 + `scrollIntoView`）
- [ ] 当前命中用 `--primary` + 外描边，其余命中弱化色

### S5 ⏸ · 内容区全量 flex 列模型（可选，单独立项）
- [ ] `.session-wrap` 改 flex 列（去 `padding-top 36px` 抵消）；删除 `computeHeight` 的 32 扣减与 DB 补偿
- ⚠️ 风险：xterm `fit()` 时机、**隐藏标签守卫 `isElementVisible()` 必须保留**、分栏/全屏/web/rdp 六项回归

### S6 · 数据库字体与终端统一（§十 方案 1）
- [ ] `DbSession` 根部注入 `--db-code-font`（`tab.fontFamily || config.fontFamily` + `--font-mono` 兜底）
- [ ] 网格单元格 / 键列表 / SQL 编辑器 / 值预览 / 原始错误改用；`font-variant-ligatures: none`
- [ ] `css-tokens.spec.js` 白名单加入 `--db-code-font`
- ⏸ 字号跟随终端：暂不做；树对象名是否一并使用待拍板（建议一并）

### DB · 数据库功能遗留缺口（来自实现审计，均为已修后的剩余项）
- [ ] 🔥 P1-7：MySQL 元数据 N+1 串行 + 单库失败整体失败 + 系统库入树（每库 try/catch 降级 + 可选过滤 information_schema/mysql/performance_schema）
- [ ] P2-12：db-client 零单测（testConnection / 只读白名单 / SCAN 游标 / normalizeResults 均可提纯函数或模块级单测）
- [ ] 阶段1 遗留：书签树 database 类型专属图标（全项目无映射）
- [ ] P2-13 剩余：空态文案 i18n（`no metadata` / `select a db node` 硬编码英文）
- [ ] P2-14：AI/MCP 书签 schema（`bookmark-schemas.js`）未含 database → AI 无法建数据库书签
- [ ] P2-15：`on-close.js` 未 await `closeAllDbTabs()`
- [ ] P2-16：`hasMore` 边界误判（恰好整页时多一次空页）
- [ ] P2-19：全局 15s 超时无区分（大表 SQL 被中断且报错统一）
- [ ] 树筛选/搜索：已实现，待真实库验证（本机无 mysqld）
- [ ] ⏸ 阶段3：数据增删改 / 导出 CSV / 执行历史（未立项）；quick-connect URI（二期）

### 同步与底栏（独立小项）
- [ ] 关键字高亮同步（方案 A，待拍板见 §5）：`configSyncKeys` 加 `keywords`（1 行，无历史同步数据、无兼容负担）→ 可选升级方案 B（按 keyword 合并）
- [ ] 底栏快速命令带（`doc/设计-底栏快速命令带分组切换.md`，**设计定稿用户已拍板，未实施**）：`footer/quick-cmd-strip.jsx` 常显 + `‹ 组名 ›` 箭头循环切换 + 胶囊横滚；`filterQuickCommands` 可提单测

### 上游跟踪（`doc/上游issue分析-2026-10-13.md`）
- [ ] 🔥 xterm 6.1.0-beta reflow 回归（#4499，与我们内部结论互证）：升级稳定版 + alternate buffer 直写，可一并消掉 4501/4481/4439 一类渲染错乱
- [ ] 提上游 PR：`fix/window-control-icons`、`style/window-controls-seamless` 分支已 push github 未提 PR；SearchBar/SessionShell 稳定后跟进
- [ ] #4539（背景色被强制同步主色）：实测一次确认本分支是否复现
- [ ] 合并上游注意：#4581 标签栏三键与 `.tabs-corner` 并行，冲突面在 `tabs.styl`/`tabs/index.jsx`

---

## 3. 待拍板（不阻塞主线）

| 项 | 问题 | 现状/建议 |
| --- | --- | --- |
| 1 | `autoCloseEmptyPane` 默认开还是关 | 现在关；建议保持关 |
| 2 | 字体统一范围（S6） | 建议方案 1（只字体族） |
| 3 | 树对象名是否算数据面 | 建议算 |
| 4 | 是否向上游提 PR | 见上游跟踪节 |
| 5 | 关键字同步方案 A 是否实施 | 建议 1 行改动先上；B 视多设备覆盖困扰再叠加 |
| 6 | 快速命令带排期 | 设计已定稿，可作 S 系列间隙的独立小项 |

## 4. 已知限制（记录，不排期）

- 查找无法高亮 textarea（SQL 编辑器、Redis 原始 JSON）
- `splitTab` 刻意不触发空窗格自动收起（否则撤掉分屏）
- 等宽字体的 CJK 混排列宽不齐（DOM 无法像 xterm 那样统一 cell 宽度）
- `.terminal-control` tabed 形态固有 1px 漂移（`.type-tab` 行盒，用户已接受）
- 只读白名单保守双检会误拦 `EXPLAIN DELETE` 类语句（安全侧优先）
- MySQL 侧功能最终以真实库复测为准（当前已验证：data/SQL/表结构/横滚条；待验证：单元格编辑/树过滤/字体效果）

## 5. 一句话

**先提交在途的网格滚动改动，然后 S0（零风险地基）→ S1/S2（动作不丢 + 口径单点）→ S3/S4（查找体验）→ 间隙穿插 DB 遗留 P1-7 / 关键字同步 A / 快速命令带三个独立小项；xterm 稳定版升级是上游侧收益最大的一项，S6/S5 视情况再做。**
