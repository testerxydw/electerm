# electerm UI 自测报告

> 每轮改动后更新。方法：**无头运行真实应用 + 截图**（非设计稿），必要时用 CDP 触发交互态。
> 一键复现：`./self-test/run.sh [前缀]`

## 自测方法（可复现）

| 步骤 | 命令 |
| --- | --- |
| 虚拟显示 | `Xvfb :99 -screen 0 1440x900x24 &` |
| 启动应用（打包源 + CDP） | `DISPLAY=:99 node_modules/.bin/electron work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9222 &` |
| 截图基础态 | `ffmpeg -f x11grab -video_size 1440x900 -i :99 -frames:v 1 -update 1 self-test/xxx-base.png` |
| 触发交互态 | `node self-test/cdp-eval.js <wsUrl> "window.dispatchEvent(new Event('open-command-palette'))"` |
| 截图交互态 | 同上 ffmpeg（输出 `-palette.png`） |

- 前提：`npm run compile` 后 `work/app` 为最新产物；一键脚本 `self-test/run.sh` 已封装以上流程。
- 局限：Xvfb 无窗口管理器，`xdotool` 按键无效 → 交互改用 **CDP**；窗口拖拽/最小化等**系统级行为无法自动验证**，需真人确认。

---

## 第 1 轮 · 结构重构成果验证（标题栏 / 命令面板 / 状态栏 / 连接信息）

**验证时间**：2026-09-29 · **版本**：5.5.35 · **分支**：master（提交 `8663d2f4`）

### 验证项与结果

| # | 项目 | 预期 | 结果 |
| --- | --- | --- | --- |
| 1 | 独立标题栏（38px 横跨全宽） | Logo + 应用名 + 工作区 + 命令入口 + 三键 | ✅ 截图可见 `e electerm default`、搜索框、`− □ ×` |
| 2 | 命令面板（⌘K） | 可唤出、含搜索框与列表 | ✅ 截图：面板居中弹出，含「动作 · 新建连接」 |
| 3 | 底部状态栏（26px） | 连接态 + 主机/类型 + 标签数 | ✅ 截图：`● 已连接 Local ⋯ 1 tab ⋯ Ctrl/Cmd + K` |
| 4 | 连接信息（面包屑） | 控制条左侧状态点 + 主机 | ✅ 截图：终端上方「● 本地」 |
| 5 | 文案优化（上轮修复） | 无英文 key 泄漏 | ✅ 「搜索 / Shortcut」、状态栏「已连接」（无 `Status:` 前缀） |
| 6 | 布局偏移 | 侧栏/内容区下移，无重叠 | ✅ 左图标栏、标签栏、终端、footer 层次正常 |

### 截图

| 文件 | 说明 |
| --- | --- |
| `self-test/r0-base-overview.png` | 完整主界面（标题栏 / 标签栏 / 左图标栏 / 终端 / 状态栏） |
| `self-test/r1-command-palette.png` | **命令面板打开态**（CDP 触发） |

### 结论

- 4 项新增结构（标题栏、命令面板、状态栏、连接信息）**全部生效**，布局无重叠/错位；
- 上轮两处文案问题已修复并在截图中确认；
- 未发现阻断性缺陷。

### 待真人验证（自动化无法覆盖）

1. 标题栏**拖拽移动窗口**、三键点击（最小化/最大化/关闭）；
2. **系统标题栏模式**下自绘标题栏应隐藏（本机 config 无该键，默认 false）；
3. 多标签 / 分屏（c2/r2/c2x2）下标题栏与标签栏不重叠。

### 下一轮计划

- S3 动效补充（`quick-commands` / `bookmark-form` 等自定义 hover 加统一 `transition`）；
- S4 区域精修（按优先级：`sys-menu` 右键菜单 → 会话树 → 终端区）；
- 每轮均产出「自测报告 + 截图」。

---

## 第 2 轮 · S4 区域精修：右键菜单（`sys-menu`）

**时间**：2026-09-29 · **分支**：master · **改动**：`src/client/components/sys-menu/sys-menu.styl`

### 改动内容

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | **子菜单底色与主菜单不一致**：主菜单 `--surface-2`，子菜单却用 `--main` | 子菜单改 `background var(--surface-2)`，视觉统一 |
| 2 | 子菜单**无圆角、无描边**（只有 `--shadow-2`），与主菜单语言不符 | 加 `border-radius var(--radius)` + `box-shadow 0 0 0 1px var(--border), var(--shadow-2)`（与主菜单一致） |
| 3 | `.menu-control` hover 加动效；顺带清理重复的 `color` 声明 | 加 `transition color/background var(--dur-1) var(--ease)` + `&:hover { background var(--hover-bg) }` |
| 4 | `.menu-logo` hover 变色但无过渡 | 加 `transition color var(--dur-1) var(--ease)` |

### 验证

**① 产物 CSS 校验**（编译后 `work/app/assets/css/*.css`）：

```css
.sub-context-menu{background:var(--surface-2);border-radius:var(--radius);
  box-shadow:0 0 0 1px var(--border), var(--shadow-2);...}
.menu-control{...;transition:color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);...}
```
✅ 新规则已生效（`--main` → `--surface-2`、圆角/描边已加、transition 已加）。

**② 基础态截图**：`self-test/r2-base.png`（主界面无回归——本轮改动仅作用于菜单内部，主界面外观不变，符合预期）。

**③ 局限（需真人验证）**：右键菜单**打开态**的自动截图未成功——`sys-menu` 是 antd `ContextMenu`（由 `Dropdown trigger=['contextMenu']` 挂载），CDP 合成事件与 `store` 直调均未触发。真人验证步骤：在任意标签/会话上右键 → 观察主菜单与**子菜单**（如「布局」）底色是否一致、圆角与描边是否统一。

### 下一轮计划

- 会话树（`tree-list`）精修（选中态 / 分组 / 密度）；
- 终端区细节（搜索条 `term-search`、快捷键条 `shortcut-bar`）；
- 继续 S3 动效补充（自定义 hover 元素）。

---

## 第 3 轮 · S4 区域精修：会话树（`tree-list`）

**时间**：2026-09-29 · **分支**：master · **改动**：`src/client/components/tree-list/tree-list.styl`

### 发现的问题与修复

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | **选中态与 hover 态完全同款**（都是 `background var(--surface-0)`）→ 无法分辨当前选中项 | hover 改 `var(--hover-bg)`；选中改 `var(--active-bg)` + 左侧 2px 品牌色条（`::before`） |
| 2 | 行内操作图标（`.tree-item-op-wrap`）hover 显隐**无过渡**（opacity 突变） | 加 `transition opacity var(--dur-1) var(--ease)` |
| 3 | `.tree-sort-trigger` hover 变色无过渡 | 加 `transition color var(--dur-1) var(--ease)` |
| 4 | `.tree-sort-popover-item` hover 换底无过渡 | 加 `transition background/color var(--dur-1) var(--ease)` |

### 验证（截图）

**`self-test/r3-tree-list.png`**（CDP 展开左侧书签面板后截图）：

- 会话树正常渲染（`default` → 主机分组 → `root@…` 子项 + `ssh configs`）；
- **选中项 `128_112` 显示品牌着色高亮 + 左侧竖条** ✅（改动前与 hover 无区别）；
- 其余项无背景，层次清晰；
- 左侧图标栏 / 标签栏 / 终端 / footer / 状态栏均正常，无回归。

### 下一轮计划

- 终端区细节：搜索条 `term-search`、快捷键条 `shortcut-bar`（密度 / 圆角 / 动效）；
- `setting-panel`（设置面板）控件统一；
- 继续 S3 动效补充。

---

## 第 4 轮 · S4 区域精修：终端搜索浮层（`term-search`）

**时间**：2026-09-29 · **分支**：master · **改动**：`src/client/components/terminal/term-search.styl`

### 问题与修复

该文件仅 17 行，浮层**裸用 `background var(--main)`**，无圆角、无描边、无内边距——与其它浮层（菜单/弹窗）语言不一致。

| # | 修复 |
| --- | --- |
| 1 | `.term-search-wrap` 底色 `--main` → `--surface-2`，加 `border-radius var(--radius)` + `box-shadow 0 0 0 1px var(--border), var(--shadow-2)` + `padding 6px` |
| 2 | `.term-search-opt-icon` 补 `cursor pointer` + `border-radius var(--radius-xs)` + `transition color/background`（hover/激活态此前无过渡） |

### 验证（截图）

**`self-test/r4-term-search.png`**（CDP 置 `store.termSearchOpen = true` 后截图）：

- 终端搜索浮层显示为**圆角 + 描边 + 阴影**的统一浮层（改动前为无圆角的裸底块）✅；
- 浮层内查找选项图标（Aa / 大小写 / 正则 / 上下 / 关闭）排列正常；
- 主界面（标题栏/标签栏/会话树/终端/状态栏）无回归。

### 下一轮计划

- `shortcut-bar`（快捷键条）按钮态与密度精修；
- `setting-panel` 控件（输入/开关/列表）统一；
- S3 动效补充收尾。

---

## 第 5 轮 · S4 区域精修：快捷键条 + 设置面板列表

**时间**：2026-09-29 · **分支**：master
**改动**：`terminal/shortcut-bar.styl`、`setting-panel/setting.styl`

### 问题与修复

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | `.shortcut-bar-icon-btn` | hover 只变文字色、**无背景反馈**（可点击感弱） | `&:hover` 补 `background var(--hover-bg)` |
| 2 | `.shortcut-bar-btn` | 同上 | `&:hover` 补 `background var(--hover-bg)` |
| 3 | `.shortcut-candidate-item` | hover 无背景**且无任何过渡** | 补 `transition background/color/opacity` + hover 背景 |
| 4 | `.setting-passwords-item` | 列表行无 hover 反馈 | 补 `transition background` + `&:hover { background var(--hover-bg) }` |

### 验证

**① 产物 CSS 校验**（编译产物 `work/app/assets/css/*.css`）：

```css
.shortcut-bar-btn:hover{color:var(--text-light);background:var(--hover-bg)}
```
✅ 新规则已编译进产物（与打包使用同一来源，可确保安装后生效）。

**② 截图**：`self-test/r5-shortcut-bar.png`
- 本次会话中快捷键条（`shortcut-bar`）在**当前视图/配置下未展开**（底部为 footer「AI/C/Q/快捷键」+ 快捷命令面板 + 状态栏），故 hover 效果无法在截图中体现；
- 截图用于确认主界面**无回归**（标题栏/标签栏/会话树/终端/footer/状态栏层次正常）。

**③ 需真人验证**：把鼠标移到快捷键条按钮 / 候选命令项 / 设置页密码列表行上，确认出现淡色背景反馈（`--hover-bg`）。

### 下一轮计划

- `setting-panel` 其余控件（输入框/开关/选择器）与卡片统一；
- `sidebar` 面板头（书签/访问历史页签）细节；
- S5 亮色主题全量校验（收尾）。

---

## 第 6 轮 · S4 区域精修：侧栏图标栏与文字按钮

**时间**：2026-09-29 · **分支**：master · **改动**：`src/client/components/sidebar/sidebar.styl`

### 问题与修复

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | `.control-icon`（左图标栏按钮） | hover 只变文字色、**无背景**；选中态已有品牌色条（保留） | `&:hover` 补 `background var(--hover-bg)` |
| 2 | `.control-icon-text` | hover 变 `--success` 但**无过渡** | 补 `transition color var(--dur-1) var(--ease)` |
| 3 | `.history-clear-icon` | hover 变 `--error` 但**无过渡** | 补 `transition color var(--dur-1) var(--ease)` |

### 验证

**① 产物 CSS 校验**（编译产物）：

```css
.control-icon:hover{color:var(--text-light);background:var(--hover-bg)}   ← 本轮新增 background
.control-icon-text{color:var(--text);transition:color var(--dur-1) var(--ease)}
```
✅ 两处均已编译进产物（与打包同源）。

**② 截图**：`self-test/r6-sidebar.png`（展开侧栏 + 模拟悬停尝试）——
- 主界面无回归：左图标栏（图标 + 选中色条）、会话树、标签栏、终端、footer、状态栏均正常；
- **hover 状态无法在截图中体现**：Xvfb 下 CDP `Input.dispatchMouseEvent`（mouseMoved）**不移动系统指针**，CSS `:hover` 不触发（已实测）。故 hover 类改动统一以产物 CSS 校验为证据。
- 需真人验证：鼠标移到左图标栏按钮 / 历史的"清除"图标，确认出现淡色背景与颜色过渡。

### 下一轮计划

- `setting-panel` 输入框 / 开关 / 选择器控件统一；
- 侧栏面板头页签（书签 / 访问历史）细节；
- S5 亮色主题全量校验（收尾）。

---

## 第 7 轮 · S3 动效批量收尾（6 文件 9 处）

**时间**：2026-09-29 · **分支**：master

### 方法

普查全项目「含 `:hover` 但整个文件无 `transition`」的样式文件（11 个），逐一分析并补齐：

| 文件 | 改动 |
| --- | --- |
| `common/responsive-tabs` | 页签 hover 加 `transition color/border-color` |
| `common/item-filter` | 两处：图标 hover 加 `transition color`；筛选项 hover 改 `--hover-bg` + `transition background` |
| `quick-commands/qm` | `.qm-move-icon` hover 加 `transition color` |
| `file-transfer/transfer` | **修复 `font-weight bold` 抖动**（见下）；`.transfer-control-icon` 加 transition |
| `session/session-control` | hover 加 `transition color` |
| `setting-panel/setting-wrap` | 两处：关闭图标 / 移动端返回按钮加 `transition` |

### 发现并修复的真问题

`.sftp-transport:hover { font-weight bold }` —— **加粗会改变文字宽度**，导致该行内容在 hover 时**左右抖动**（行内重排）。改为 `background var(--hover-bg)` 背景反馈（无重排）。

### 验证

**① 量化指标**：

| 指标 | 前 | 后 |
| --- | --- | --- |
| 含 `transition` 的样式文件数 | 22 | **30** |
| 「有 hover 却无任何过渡」的文件 | 11 | 5 |

剩余 5 个：`notification` / `message`（antd 通知，样式由 antd 主导）、`bookmark-form`（hover 是 `display` 切换，不可过渡）、`upgrade`、`mobile`（移动端 `!important` 覆盖场景）。

**② 截图**：`self-test/r7-animations.png` —— 主界面无回归（左图标栏 / 会话树 / 标签栏 / 终端 / 快捷命令 / footer / 状态栏正常）。

**③ 需真人验证**：hover 类效果的动感（过渡时长/缓动）需真机手感确认。

### 下一轮计划

- `setting-panel` 输入框 / 开关 / 选择器控件统一；
- S5 亮色主题全量校验（收尾）。

---

## 第 8 轮 · 全量打包 + 安装包内改动核验（关键）

**时间**：2026-09-29 · **产物**：`dist/electerm-5.5.35-test.46-linux-amd64.deb`（98,581,724 B，15:09）

### 目的

前 7 轮改动需要**确认真的进了安装包**（此前出现过「deb 名 5.5.35 但包内是旧 app.asar」的问题）。本轮不只看编译日志，而是**从 deb 内部提取 CSS 逐条核验**。

### 核验方法

```bash
dpkg-deb -x dist/electerm-5.5.35-test.46-linux-amd64.deb /tmp/deb8
npx asar extract-file /tmp/deb8/opt/electerm/resources/app.asar assets/css/style-5.5.35.css
grep -o '<选择器>{[^}]*}' style-5.5.35.css
```

### 核验结果（deb 内 CSS 实测）

| 轮次 | 选择器 | 包内实测 |
| --- | --- | --- |
| 2 | `.sub-context-menu` | `{background:var(--surface-2);border-radius:var(--radius);box-shadow:0 0 0 1px var(--border), var(--shadow-2);…}` ✅ |
| 3 | `.tree-item.selected` | `{background:var(--active-bg);color:var(--text)}` + `::before{width:2px;background:var(--primary);…}` ✅ |
| 4 | `.term-search-wrap` | `{background:var(--surface-2);border-radius:var(--radius);box-shadow:0 0 0 1px var(--border)…;padding:6px}` ✅ |
| 6 | `.control-icon:hover` | `{color:var(--text-light);background:var(--hover-bg)}` ✅ |
| 7 | `.sftp-transport:hover` | `{background:var(--hover-bg)}`（`font-weight:bold` 已移除）✅ |

**结论：7 轮改动全部编译进 test.46 安装包**（与截图所用 `work/app` 同源）。

### 安装验证

```bash
sudo dpkg -i dist/electerm-5.5.35-test.46-linux-amd64.deb
```

安装后可见的变化：
1. **侧栏会话树**：选中项有品牌色背景 + **左侧 2px 色条**（最直观）；
2. **右键菜单**：子菜单与主菜单底色/圆角/描边一致；
3. **终端搜索**（Ctrl/Cmd+F）：浮层为圆角 + 描边 + 阴影；
4. **悬停反馈**：左图标栏、快捷键条、传输列表、设置列表等出现淡色背景 + 过渡；
5. 传输列表 hover **不再左右抖动**。

> 若安装后仍无变化，排查顺序：① 确认装的是 `test.46`（`dpkg -l electerm`）；② 完全退出旧进程（托盘退出，非关窗口）再启动；③ `~/.config/electerm` 下若有旧缓存不影响 UI（UI 样式在 app.asar 内）——最可能是启动到了旧进程。

### 下一轮计划

- `setting-panel` 输入框 / 开关 / 选择器统一；
- S5 亮色主题全量校验（收尾）。

---

## 第 9 轮 · 对照草图还原：左图标栏（rail）+ 修复宽度错位 bug

**时间**：2026-09-29 · **分支**：master

### 草图的 rail 规格（`UI-重设计草图.html`）

```css
.rail{width:50px; padding:10px 0; gap:4px}
.rail .ri{width:36px;height:36px;border-radius:var(--r)  /* 10px */}
.rail .ri:hover{background:var(--hov)}
.rail .ri.on{background:var(--act)}
.rail .ri.on::before{left:-7px;width:3px;border-radius:0 3px 3px 0;background:var(--primary)}
```

### 发现的问题（含一个真 bug）

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | **宽度不一致（bug）**：常量 `sidebarWidth = 43`，但 `.sidebar` 硬编码 `width: 36px` → 依赖 `--left-side-bar-width`(43) 的 **footer / 状态栏 / 快捷命令 / 设置 / 抽屉** 位置**多偏 7px** | 常量统一为 **50**；`.sidebar` 改 `width var(--left-side-bar-width, 50px)`，三处一致 |
| 2 | 图标按钮无方块感：`.control-icon-wrap{padding:14px 0}`，背景/圆角贴在**图标本体**上 | 在 `.sidebar-bar` 内新增规则：按钮 **36×36**、`border-radius var(--radius)`、`margin 2px auto`、hover 背景用容器承载 |
| 3 | 选中态色条为 `inset 2px` 且贴图标 | 改 `::before` **3px 圆头色条**（`left:-7px; top/bottom:9px`），对齐草图 `.ri.on` |
| 4 | 限定作用域 | 全部限定在 `.sidebar-bar` 内，**不影响** transfer / upgrade 等其它 `.control-icon-wrap` 用法 |

### 验证

**① 运行时实测（CDP）**：

```
storeWidth: 50   inline: "width: 50px"   railComputed: "50px"   btnCount: 10
```
✅ 栏宽、内联宽度、计算宽度全部为 50px（改动前为 43px）。

**② 截图**：`self-test/r9-rail.png` —— 图标栏明显加宽、按钮间距舒展；footer「AI/C/Q/快捷键」与状态栏「● 已连接 Local」左边界与栏宽对齐（错位已消除）。

### ⚠️ 本轮暴露的重要机制：「看不到变化」的真正原因

调试中发现**我的调试实例反复显示旧值 43**，根因是：

- `pkill -f "work/app/app.js"` **只杀掉主进程**，而 **`work/app/server/server.js` 子进程会存活**，继续占用端口（9222 与内部 30975）；
- 新实例因此**无法接管端口**，CDP 一直连到**旧实例**（旧 bundle）。

**这对你桌面版本的启动同理**：若旧 electerm **未完全退出**（关窗口 ≠ 退出，或残留子进程），再启动时会连到/复用到旧进程，表现为"装了新包但界面没变"。

另外，electerm 渲染进程通过**本地 HTTP 服务**（`http://127.0.0.1:<port>/index.html`）加载页面，而产物文件名固定（`electerm-5.5.35.js`，**不含内容 hash**）→ **HTTP 缓存也可能命中旧文件**。

**排查/规避（按顺序）**：
1. 完全退出：托盘 → 退出；确认 `pgrep -af electerm` 无残留（尤其 `server.js`）；
2. 清缓存：`rm -rf ~/.config/electerm/Cache ~/.config/electerm/'Code Cache'`；
3. 重装后首次启动若仍异常，重启一次应用（缓存已在首次启动时刷新）。

### 下一轮计划

- 会话树节点舒展（草图 `.node`：`padding 6px 8px`、`border-radius 8px`、分组字号 11px）；
- 标签栏状态圆点 + 顶部渐变条（草图 `.tab`）；
- 终端区径向光晕；状态栏信息扩充。

---

## 第 10 轮 · 对照草图还原：会话树节点与分组标题

**时间**：2026-09-29 · **分支**：master
**改动**：`tree-list/tree-list.styl`、`tree-list/tree-list-layout.js`（同步虚拟滚动常量）

### 草图规格 → 实现

| 草图 | 改动前 | 改动后 |
| --- | --- | --- |
| `.node{padding:6px 8px 6px 10px}`（约 30px 行高） | `line-height: 26px`、`padding-left: 5px` | **`line-height: 30px`**、`padding-left: 8px` |
| `.node{border-radius:var(--r-sm)}`（8px） | `var(--radius-xs)`（4px） | **`var(--radius-sm)`** |
| `.grp{font-size:11px;color:var(--text-dark)}`（轻量小字） | `font-weight:bold; font-size:14px`（视觉过重） | **`font-weight:600; font-size:12px; color:var(--text-dark)`** |
| `.node.on::before{top:7px;bottom:7px}` | `top/bottom: 4px` | **7px** |

### 同步修改（关键，否则虚拟滚动错位）

```js
// tree-list-layout.js
export const treeRowHeight = 30      // 原 26：与 .tree-item line-height 必须一致
export const treeEditorRowHeight = 34 // 原 32（跟随行高上调）
```
同时把 `.tree-control-btn` 的 `height: 26px` 改为 `30px`（行内按钮跟随行高）。

### 验证

**① CDP 实测（真实 DOM）**：

```
rowH: 30   itemH: 30   items: 8
```
✅ 行高 / 项高均为 30px（改动前 26px），8 个会话项渲染正常（虚拟滚动无错位）。

**② 截图**：`self-test/r10-tree.png`
- 分组标题 `default` 变为**轻量小灰字**（原为 14px 粗体白字）；
- 会话项行距明显舒展（26 → 30px）；
- 图标栏（50px）与底部状态栏对齐正常，无回归。

### 下一轮计划

- 标签栏：状态圆点 7px + active 顶部 2px 渐变条；
- 终端区径向光晕；状态栏信息扩充（算法 / shell / 编码 / 速率）。

---

## 第 11 轮 · 对照草图还原：标签栏（状态圆点 + active 描边）

**时间**：2026-09-29 · **分支**：master
**改动**：`tabs/tab.jsx`（DOM 顺序）、`tabs/tabs.styl`

### 草图规格 → 实现

| 草图 | 改动前 | 改动后 |
| --- | --- | --- |
| `.tab{display:flex;align-items:center;gap:7px}` | `display:inline-block` + `text-align:center` | **`inline-flex` + `align-items:center` + `gap:5px`** |
| `.tab .dot{width:7px;height:7px;border-radius:50%;box-shadow:0 0 6px …}`（圆点**在标题前**） | `.tab-status`：`absolute; left:2px; top:2px; 5px; border-radius:8px`（左上角小方块） | **`position:static` + 7px 圆 + 光晕**；JSX 中移到 `.tab-title` 之前 |
| `.tab.active{box-shadow:inset 0 0 0 1px primary@26%}` | `inset 0 2px 0 0 var(--primary)`（2px 实顶边） | **`inset 0 0 0 1px` + `color-mix` 26%** |

（active 的**顶部 2px 渐变条**原本已实现，予以保留。）

### ⚠️ 本轮踩坑（重要，值得记入规范）

**编译静默失败**：本次改动首次编译后，页面仍是旧样式（CDP 实测 `position:absolute; 5px; inline-block`）。排查发现：

```
✗ Build failed in 1.11s
Error: [stylus] tabs.styl:66 … color-mix(in srgb, var(--primary) 26%, transparent)
```

- **原因**：Stylus 解析 `color-mix(in srgb, …)`（含 `in` 与逗号）会报错 —— 项目 `tokens.styl:11` 早已注明：**含 `in` 的 `color-mix(...)` 必须用 `unquote()` 包裹**。
- **陷阱**：`vite build` 失败时**不会删除已有产物**，`work/app/assets` 仍是上一次成功版本 → 表面"编译完成"，实际样式未更新。

**教训（已形成检查习惯）**：
1. styl 中写 `color-mix(in …)` 一律 `unquote('color-mix(in …)')`；
2. 编译后**必须显式检查**：`grep -q "Build failed" <log> && echo 失败 || echo 成功`，不能只看 `tail`（`done build in N s` 在失败时**也会打印**）；
3. 验证要查**产物 CSS** 或**运行时计算样式**，而非只看截图。

### 验证（CDP 实测真实 DOM）

```
statusPos: static      (原 absolute)
statusSize: 7px        (原 5px)
statusRadius: 50%      (原 8px 方块)
tabDisplay: inline-flex (原 inline-block)
activeShadow: color(srgb 0 0.533 0.8 / 0.26) 0 0 0 1px inset   ← color-mix 已生效
```
✅ 全部符合草图。

**截图**：`self-test/r11-tab.png` —— 「新连接」标签前可见**绿色状态圆点**（带光晕），active 标签有 1px 品牌描边 + 顶部渐变条。

### 下一轮计划

- 终端区径向光晕（草图 `.term` 的 `radial-gradient`）；
- 状态栏信息扩充（ssh 算法 / shell / 编码 / 速率）；
- 标签栏高度 36 → 38px（草图 38px，tab 高 32px）需评估布局依赖。

---

## 第 12 轮 · 对照草图还原：终端区径向光晕

**时间**：2026-09-29 · **分支**：master · **改动**：`terminal/terminal.styl`

### 草图规格 → 实现

```css
/* 草图 */
.term{background: radial-gradient(600px 240px at 78% -60px,
        color-mix(in srgb, var(--primary) 8%, transparent), transparent 70%), var(--s1)}
```

前置条件已具备：`.xterm` 与 `.xterm-viewport` 背景本就为 `transparent`（`terminal.styl:33-36`），故容器底色可见。

**实现**（`.term-wrap`）：

```styl
background unquote('radial-gradient(600px 240px at 78% -60px, color-mix(in srgb, var(--primary) 12%, transparent), transparent 70%), var(--main)')
```

**偏差说明（有意）**：草图取 **8%**，实测在真实终端底色（比草图更暗）下**肉眼不可见**；提高到 **12%** 以保住"氛围光"的可感知度。

### 验证（像素量化，非主观判断）

| 采样点 | RGB | 判读 |
| --- | --- | --- |
| 终端右上 (880,160) | **(0, 5, 8)** | 偏蓝 |
| 终端右中 (880,260) | **(36, 43, 47)** | 蓝通道较红 +11 → **品牌蓝光晕** |
| 终端左下 (500,400) | (38, 38, 38) | 中性灰（无光晕） |
| 终端右下 (880,430) | (38, 38, 38) | 中性灰（无光晕） |

✅ 右侧上部呈品牌蓝偏移、左侧/下部为中性底色 → 光晕按预期只出现在右上（`at 78% -60px`）。

**截图**：`self-test/r12-term-glow.png`（光晕为克制的氛围效果，放大后可见右侧上部的冷色偏移）。

### 备注

- Stylus 中该值**必须整体 `unquote()`**（含 `in`/逗号的 `color-mix` + 多层 background 无法直接解析）——见第 11 轮的踩坑记录。

### 下一轮计划

- 状态栏信息扩充（ssh 算法 / shell / 编码 / 速率）；
- 标签栏高度 36 → 38px（评估布局依赖后实施）；
- 内容区面包屑（`.crumb`）与草图对齐（badge 样式）。
