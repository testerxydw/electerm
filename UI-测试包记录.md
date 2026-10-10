# electerm 测试包记录

> 每打一个测试包必须在本文件追加一节：**版本号 / 对应提交 / 修改点 / 验证点（含已知问题）**。
> 一键打包：`npm run bdebfast`；产物在 `dist/`。

---

## test.60（2026-09-30 14:11）· **master 回退版**
- **提交**：master 重置到 `d3855c68`（「建立统一设计 token 体系并优化可访问性与视觉体验」）
- **背景**：用户要求把未推送的 38 个提交（UI 美化/重构全部成果）备份到 `ui-beautification` 分支（`ee10ecb3`，含调研文档修改），master 回到 token 体系落地点
- **修改点**：无新增（回退）—— 包内**不含** title-bar / app-kbar / status-bar / 命令面板等新 UI 组件
- **验证点**：从 deb 提取 CSS，`app-kbar / main-statusbar / titlebar-logo` 均为 **0** ✅（确认是纯 d3855c68 版本）
- **已安装** ✅
- **注**：`reset --hard` 曾删除已跟踪的 UI 文档，已从备份分支恢复（本提交含恢复）

## test.59（2026-09-30 11:46）
- **提交**：`5feebbfb`（标签栏收尾）
- **修改点**：`.tab-close` 由 display 突变改为 **opacity 0→0.7 淡入**（对齐草图 `.tab .x`）；核对多标签拖拽插入线/计数徽标/状态圆点均已对齐
- **验证点**：编译通过；hover 标签 → 关闭键淡入（120ms）
- **已安装** ✅

## test.58（2026-09-30 11:35）
- **提交**：`3664b75f`（头像账户菜单）
- **修改点**：图标栏头像点击改为 Popover 账户菜单（设置/设置同步/终端主题/关于）；菜单样式 `--hover-bg`+圆角+过渡
- **验证点**：CDP 点击头像 `menuOpen=true`、`items=[设置,设置同步,终端主题,关于]`；截图 `r25-avatar-menu.png`
- **已安装** ✅

## test.57（2026-09-30 11:20）
- **提交**：`862b4704`（v4 复核 ⑤ 弹窗）+ `ff4b9c03`（AI 气泡分栏）
- **修改点**：`.custom-modal-content` 14px 圆角 + 描边环 + shadow-3；`.custom-modal-header` 8% 品牌洗染；`.custom-modal-ok-btn` hover 上浮+投影；AI 气泡左右分栏（用户提问靠右品牌浸染 / AI 回复靠左卡片）
- **验证点**：产物 CSS `.custom-modal-content{border-radius:var(--radius-lg);box-shadow:0 0 0 1px var(--border), var(--shadow-3)}`、洗染渐变 ×1、气泡两条规则
- **验收**：打开「编辑书签」弹窗看圆角/描边/标题洗染/保存按钮 hover；发起一次 AI 对话看气泡分栏
- **已安装** ✅

## test.56（2026-09-30 10:56）
- **提交**：`ff4b9c03`（AI 气泡分栏）
- **说明**：同 test.57 的气泡部分（独立提交）；已安装 ✅

## test.55（2026-09-30 10:05）
- **提交**：`25582d6d`（v4 复核 ③SFTP 面板化 + ⑨通知过渡）
- **修改点**：`.file-list` 面板化（`--surface-1` + 1px 描边 + 圆角）；SFTP 大小列等宽 11px；通知图标补 color 过渡
- **验证点**：产物 CSS `.file-list{background:var(--surface-1)...box-shadow:0 0 0 1px var(--border)}`；standard 通过
- **已安装**：`sudo -n dpkg -i` 成功

## test.54（2026-09-30 09:44）
- **提交**：`ac9a859d`（总方案整合 + 用户项 3 传输页）
- **修改点**：新增 `UI-美化与重构总方案.md`（统一入口）；右面板「传输」页（复用 TransferModal，空态提示）
- **验证点**：CDP `activeTab=transfer`、`transfer-panel` 存在、空态文案正确
- **已安装** ✅

## test.53（2026-09-30 09:19）
- **提交**：`1bb74b2d`（修复右面板浮层遮挡内容区）
- **修改点**：`rightPanelPinned` 无存储值时默认 **true**（dock）；`.right-side-panel-pinned` bottom 避让底部三条；`.app-kbar` right 让位
- **验证点**：CDP `pinned=true`、`.term-controls 1087-1121` 与面板(1131-1439) `overlaps=false`；截图 `r22-dock-fix.png`
- **背景**：用户红框报障（右上图标组被面板盖 / 底部条挤）
- **已安装** ✅

## test.52（2026-09-29 18:10）
- **提交**：`e9fdcdf7`（监控默认关闭）
- **修改点**：`store.rightPanelMonitor`（默认 false）；采集门控 `enabled = rightPanelMonitor && tab==='monitor'`；面板头加 Switch
- **验证点**：默认态 `metrics=0/hint=true`；开启后 `metrics=4`
- **已安装** ✅

## test.51（2026-09-29 18:05）
- **提交**：`42302a7b`（用户项 2 监控页）+ `UI-重构计划.md` 差距复审
- **修改点**：新增 `remote-monitor/monitor-panel.jsx`（CPU/MEM/DISK/NET，阈值 ≥70% warn / ≥90% error）
- **验证点**：CDP `metrics=4`；本地会话数值为 `—`（SSH 后有真实值）
- **已安装** ✅

## test.50（2026-09-29 17:59）
- **提交**：`e8d8ef3a`（**Phase 1 全部完成** P1-2~P1-6）
- **修改点**：面板头「会话」标题；标签栏 36→38px / tab 32px；标题栏 Logo 渐变方块 + 搜索文案；面包屑类型徽标；AI `.code-block` 对齐
- **验证点**：CDP `logoBg=linear-gradient(...)`、`tabsH=38`、`tabH=32`、`badges=[已连接,Local]`
- **已知**：面板标题 `e('session')` key 不存在 → 已改「会话」

## test.49（2026-09-29 17:14）
- **提交**：`eea8784e`（应用快捷键条）+ `43f8ae07`（右面板页签）
- **修改点**：新增 `app-kbar`（30px 常显，6 条动作）；右面板改 `AI|传输|监控` 页签，默认 AI；`transfer/monitor` 占位
- **验证点**：CDP `items=6/h=30`、`tabs=[AI*,传输,监控]`
- **已安装** ✅

## test.48（2026-09-29 15:45）
- **提交**：`c202ad83`（三栏默认显示 + 面板宽度对齐草图）
- **修改点**：`openedSideBar` 默认 `'bookmarks'`、`rightPanelVisible` 默认 `true`、左面板 236 / 右面板 308
- **验证点**：CDP 四值全部对齐
- **已知**：默认值仅在无 localStorage 记录时生效

## test.47（2026-09-29 15:19）
- **提交**：`46491e3d`（图标栏 50px + dock 修复 + 头像组件前身）
- **修改点**：`sidebarWidth` 43→50；`.sidebar` 用 `var(--left-side-bar-width)`（修 7px 错位）；按钮 36×36
- **验证点**：CDP `railW=50`；截图 `r9-rail.png`

## test.46（2026-09-29 15:09）
- **提交**：`a47a72b1`（第 8 轮：全量打包 + **从 deb 内核验**）
- **修改点**：无代码（打包 + 核验第 1-7 轮改动全部进包）
- **验证点**：从 deb 提取 CSS 逐条 grep（`.tree-item.selected`、`.sub-context-menu`、`.term-search-wrap`、`.control-icon:hover`、`.sftp-transport:hover`）
- **说明**：test.46 为「包内核验」里程碑

## test.45（2026-09-29 14:19）
- **提交**：`5c0e5716`（S1.5 独立标题栏）
- **修改点**：新增 `title-bar/`（横跨全宽 38px：Logo/工作区/命令入口/三键）；三键从标签栏迁移；sidebar top 偏移
- **验证点**：截图（标题栏出现、三键迁移）
- **⚠️ 风险提示**：真机需验证窗口拖拽/三键/系统标题栏模式

## test.44（2026-09-29 14:0x）
- **提交**：`9ff450c7`(S1.1 命令面板) + `a4df3fc5`(S1.2 标签入口) + `236c0b5a`(S1.4 状态栏) + `85e8d903`(S1.3 连接信息)
- **修改点**：命令面板组件 + 标签栏入口 + 底部状态栏 + 会话连接信息
- **验证点**：单测 + compile；截图

## test.41（2026-09-29 11:56）
- **提交**：PR 分支 `fix/window-control-icons`（三键修复）构建（上游原版 UI + 修复）
- **修改点**：仅 PR 分支的 `tabs.styl`（图标几何 + currentColor）
- **验证点**：产物 CSS `.icon-maximize.is-max:before{...width:10px;height:7px;top:3px;left:3px}`（无 `solid text`）
- **说明**：用于向官方提 PR 前的验证（`git push github` → PR）

## test.39（2026-09-29 10:39）
- **提交**：`edc81fd7`（脚本合并：`build-deb-fast.js` 内置同步 src/app 与版本号 + shell rm 避让 safe-delete）
- **验证点**：日志出现「同步 src/app 与版本号」；产物版本正确

## test.38（2026-09-29 10:36）
- **提交**：`ac9a859d` 之前的临时脚本 `build-deb-test.js`（**已被合并删除**）
- **说明**：验证一键同步流程；产物 `test.38` 正常

## test.37（2026-09-29 10:19）
- **提交**：无（修复过程产物）
- **说明**：修复「deb 名 5.5.35 但应用内显示 5.5.26」——`work/app` 陈旧；手动同步 `src/app` + 重建 `work/app/package.json`；同时发现根 `package.json` 被污染（`git checkout` 恢复）

## test.36（2026-09-29 10:14）
- **说明**：首次 bdebfast 打包；**产物有问题**（app.asar 内是旧版 5.5.26）→ 已由 test.37 修复，**弃用**
