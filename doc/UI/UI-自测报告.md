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

---

## 第 13 轮 · 对照草图还原：状态栏（等宽 + 分段 + kbd）

**时间**：2026-09-29 · **分支**：master
**改动**：`status-bar/index.jsx`（重写）、`status-bar/index.styl`

### 草图规格 → 实现

| 草图 | 改动前 | 改动后 |
| --- | --- | --- |
| `font-family:var(--mono)`（等宽） | 继承默认无衬线 | **`var(--font-mono)`** |
| `.it b{color:var(--text);font-weight:600}`（主机名加粗） | 主机名为普通灰字 | **`.statusbar-host` 加粗 + `--text`** |
| 分段含 `UTF-8`、`⌘K 命令面板` | 仅 `1 tab` + `Ctrl/Cmd + K` 纯文本 | 新增**编码段**（`tab.encode` 大写）+ **`<kbd>Ctrl/Cmd + K</kbd> 命令面板`** |

**有意偏差**：草图中的 `ssh2 · aes-256-gcm` 与 `zsh 5.9`、`↑ 2.1 MB/s ↓ 8.4 MB/s` 需要新的数据管线（连接算法 / 远端 shell / 实时速率），当前 store 无对应字段 → 本轮先接**已有数据**（连接态 / 主机 / 类型 / 编码 / 标签数），待数据管线就绪再补两段（已在交互设计文档中列为待补项）。

### 踩坑（本环境变量命名）

`font-family var(--mono)` **不生效** —— 项目没有 `--mono`，正确变量是 **`--font-mono`**（`tokens.styl:66`，title-bar / command-palette 均用它）。已改正并复验。

### 验证（CDP 实测）

```
font: ui-monospace, "SF Mono", Menlo, Consolas   ← 等宽生效
kbd border: 1px / radius: 4px                    ← kbd 胶囊生效
text: 已连接 | Local | 1 tab | Ctrl/Cmd + K | 命令面板
```
✅ 与草图结构一致（含分段与 kbd 提示）。

**截图**：`self-test/r13-statusbar.png`。

### 交付（本轮附带）

- **`UI-交互设计.md`**：详细设计后续交互（命令面板 / 标签 / 会话树 / 图标栏 / 面包屑 / 快捷键条 / 右面板 / 状态栏 / 动效 / 无障碍 / 空态错误态）。

### 下一轮计划

- 标签栏高度 36 → 38px + tab 32px（草图，评估布局依赖）；
- 内容区面包屑 badge（已连接 / `SSH · zsh` / `● REC`）+ 右侧操作图标；
- 左面板标题（草图「会话」大写间距 + 操作按钮）；图标栏底部头像。

---

## 第 14 轮 · 对照草图还原：内容区面包屑（状态胶囊）

**时间**：2026-09-29 · **分支**：master
**改动**：`session/session-control.jsx`、`session/session-control.styl`

### 草图规格 → 实现

| 草图 | 改动前 | 改动后 |
| --- | --- | --- |
| `.crumb .host{color:var(--text);font-weight:600}` | `.conn-host` 普通灰字 | **`--text` + 600** |
| `.badge.ok{background:var(--ok-bg);border-color:success@40%;color:success@75%}` | 无状态徽标 | 新增 **`.conn-badge` 胶囊**（`ok` / `err` 两种语义色，`color-mix` 派生） |
| `.badge{font-family:var(--mono);font-size:10px;border-radius:var(--r-pill)}` | — | 等宽 10px + pill 圆角 |

状态文案复用 `statusText()`（与状态栏同一来源，避免重复维护）。

### 验证（CDP 实测）

```
hasInfo: true
text: "本地 已连接"          ← 主机名 + 状态胶囊
hostWeight: 600              ← 加粗生效
badgeRadius: 999px           ← 胶囊
badgeBg: color(srgb .13 .25 .22)  ← success 15% 与底色混合（绿调）
```
✅ 与草图 `.crumb` 结构一致。

**截图**：`self-test/r14-crumb.png`。

### 说明（与草图的差异及原因）

| 草图元素 | 现状 |
| --- | --- |
| `SSH / zsh` 徽标 | 连接类型已有（`typeText`，见状态栏）；远端 shell 名需新数据管线 |
| `● REC` 录制徽标 | 项目尚无"会话录制"功能，属**新增能力**（已列入 `UI-交互设计.md` P1） |
| 右侧 分屏/SFTP/AI 图标 | 已存在（`.term-controls`），hover 样式已在第 6/7 轮统一 |

### 下一轮计划

- 左面板标题（草图「会话」· 大写 + 操作按钮）；图标栏**底部头像**；
- 标签栏高度 36 → 38px + tab 32px（草图）。

---

## 第 15 轮 · 布局按草图：三栏默认显示 + 面板宽度对齐

**时间**：2026-09-29 · **分支**：master · **改动**：`store/init-state.js`

### 需求

> 「布局优先按草图设计，边栏设计为默认显示可隐藏」

草图为**四区横向布局**：图标栏 50px + 左面板 236px + 内容区 + 右面板 308px（左右面板均**默认显示**）。

### 改动

| 项 | 改动前 | 改动后 |
| --- | --- | --- |
| 左侧会话面板 | `openedSideBar: ''`（**默认收起**） | **`'bookmarks'`（默认展开）** |
| 右侧面板 | `rightPanelVisible: false`（**默认隐藏**） | **`true`（默认显示）** |
| 左面板宽度 | `300` | **`236`**（草图） |
| 右面板宽度 | `500` | **`308`**（草图） |

**可隐藏性保留**：左面板点击图标栏可收起/展开、右面板有独立开关 —— 均是既有交互，未破坏。

### 验证（CDP 实测，清 localStorage 后）

```
leftPanel: "bookmarks"   ← 左面板默认展开
rightPanel: true         ← 右面板默认显示
leftPanelW: 236          ← 对齐草图
rightPanelW: 308         ← 对齐草图
railW: 50                ← 对齐草图
```
✅ 四区布局与草图一致。

**截图**：`self-test/r15-three-pane.png`（图标栏 + 会话树 + 终端 + 右侧信息面板 + footer + 状态栏）。

### 注意（对已安装用户）

上述默认值在**首次启动（无 localStorage 记录）**时生效。此前用过旧版本的用户 localStorage 里已存有 `opened-sidebar` / 右侧面板开关 → 需：
- 手动点开左侧图标栏 / 右侧面板开关；或
- 清缓存后重启：`rm -rf ~/.config/electerm/{Cache,Code\ Cache}`（并在应用内清空站点数据可重置 localStorage）。

### 与草图的剩余差异

| 草图 | 现状 | 处理 |
| --- | --- | --- |
| 右面板为 **AI 对话 + 负载卡片** | 当前显示的是**连接信息**（ID/Hostname/OS/Kernel/Arch/Shell） | 右面板默认页签可切到 AI；负载卡片需数据管线（P1） |
| 底部**快捷键条**（`⌘K 命令面板` 等胶囊） | 当前是图标行（AI/C/Q/快捷键） | 下一轮：改为 kbd 胶囊 + 文字 |
| 左面板标题「会话」+ 操作按钮 | 当前是「书签 / 访问历史」页签 | 下一轮评估（页签为 electerm 既有结构，建议保留并美化） |

### 下一轮计划

- 快捷键条改 kbd 胶囊形态（对齐草图 `.kbar`，数据驱动 + 可点击）；
- 图标栏**底部头像**；标签栏高度 36 → 38px。

---

## 第 16 轮 · 新增「应用快捷键条」（草图 `.kbar`，常显）

**时间**：2026-09-29 · **分支**：master

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/client/components/app-kbar/index.jsx` | 快捷键条组件（6 条动作，点击/Enter 执行） |
| `src/client/components/app-kbar/index.styl` | 30px / kbd 胶囊 / hover 中性底 / 焦点环（对齐草图 `.kbar`） |
| `constants.js` | 新增 `appKbarHeight = 30` |
| `layout.jsx` | 主区高度扣减 `appKbarHeight`（非移动端），避免终端被遮挡 |
| `main.jsx` | 挂载 `<AppKbar />`（footer 之上、状态栏之上） |

### 条目与动作

| 显示 | 执行 |
| --- | --- |
| `⌘K` / `Ctrl+K` **命令面板** | `dispatchEvent('open-command-palette')` |
| 新建会话 | `store.onNewSsh()` |
| AI 助手 | 右面板 → `ai` 页 |
| 快捷命令 | 右面板 → `quickCommands` 页 |
| 命令历史 | 右面板 → `cmdHistory` 页 |
| 设置 | `store.openSettingModal()` |

**诚实原则**：仅「命令面板」存在真实的全局键位绑定（`command-palette/index.jsx` 的 `ctrlKey||metaKey + k`），故**只有它显示 kbd**；其余条目只显示动作名，**不伪造快捷键**。平台自适应键位符号（mac `⌘` / 其他 `Ctrl+`）。

### 验证（CDP 实测）

```
exists: true
items: 6
text: "Ctrl+K 命令面板 | 新建会话 | AI 助手 | 快捷命令 | 命令历史 | 设置"
h: 30            ← 与草图一致
```
✅ 组件渲染、高度、文案、位置（终端下方）均正确。

**截图**：`self-test/r16-kbar.png`。

### 与草图的关系说明

草图的底部是「**只有** kbd 条」；electerm 另有 **footer 功能控件行**（AI / 快捷命令 / 命令历史 / 编码 / 行数）。两者性质不同、都保留：

```
终端
├─ 应用快捷键条（30px，本轮新增，对齐草图 .kbar）
├─ footer 功能控件（36px，electerm 既有：AI/C/Q/编码…）
└─ 状态栏（26px，第 13 轮已对齐）
```

### 关于草图的 `⌘R 录制`

**需要你确认语义**：
- ① **会话录制（可回放，audit）**：按时间戳记录输入+输出，产出可回放文件（如需 `asciinema` 风格）—— 与 `● REC` 语义匹配，但**项目无此功能**，工作量较大（终端 I/O 挂钩 + 录制文件管理 + 回放器）。
- ② **终端日志落盘**：仅输出追加到文本（**已有**，右面板「将终端日志保存到文件」开关）。

本轮**未显示 ⌘R**，避免给出一个语义含混的假 REC —— 待你确认走 ① 还是②后补上。

### 下一轮计划

- **右面板严格按草图**（`AI | 传输 | 监控` 页签 + AI 对话气泡 + 系统负载卡片，默认 AI 页）；
- 图标栏底部头像；标签栏高度 36 → 38px。

---

## 第 17 轮 · 右面板按草图：`AI | 传输 | 监控` 页签 + 默认 AI 页

**时间**：2026-09-29 · **分支**：master
**改动**：`side-panel-r/side-panel-r.jsx`、`side-panel-r/right-side-panel.styl`、`main/main.jsx`、`store/init-state.js`

### 改动

| 项 | 改动前 | 改动后 |
| --- | --- | --- |
| 面板头 | 「图标 + 页名」标题行（`BarChartOutlined` 等 glyph 表示当前页） | **页签头**：`AI \| 传输 \| 监控`（对齐草图 `.ptabs`；激活态 `--active-bg` + 品牌字色） |
| 默认页签 | `info`（连接信息） | **`ai`**（草图默认 AI 对话） |
| 新增页 | — | `transfer`（传输）、`monitor`（监控）—— 本轮接入**占位**，下一轮接入真实组件/数据 |

保留：右侧 pin / 关闭、拖拽宽度、`Esc` 关闭、移动端全屏抽屉行为。

### 验证（CDP 实测）

```
tabs: ["AI*", "传输", "监控"]     ← AI 为激活态
active: "ai"                      ← 默认页为 AI
```
✅ 页签渲染与激活态正确。

**截图**：`self-test/r17-right-panel.png`（右上页签 + AI 助手欢迎页 + 底部快捷键条 + 状态栏）。

### 与草图的剩余差距（下一轮）

| 草图 | 现状 |
| --- | --- |
| AI 页：**对话气泡**（AI / 用户分栏）+ 输入框 | AI 助手已有欢迎页 + 输入框；气泡样式待对齐草图 `.ai-msg` |
| **系统负载卡片**（CPU/MEM/DISK/NET 进度条，>70% 转 warn、>90% 转 error） | 待接入远程监控数据（`monitor` 页占位中） |
| **传输页**（列表 + 进度） | 待接入现有传输队列（`transfer` 页占位中） |
| 页签右侧 `⋯` 更多 | 现为 pin / 关闭按钮（功能等价，视觉待统一） |

### 下一轮计划

- `monitor` 页：接入远程监控数据（CPU/MEM/DISK/NET 进度条 + 阈值配色）；
- `transfer` 页：接入现有传输队列组件；
- 图标栏底部头像；标签栏高度 36 → 38px。

---

## 第 18 轮 · P1-1 图标栏底部头像（**已完成**）

**时间**：2026-09-29 · **分支**：master
**改动**：`sidebar/left-sidebar-icons.jsx`、`sidebar/sidebar.styl`、`main/main.jsx`
**产出**：`UI-重构计划.md`（完整阶段计划）

### 已完成

| 项 | 内容 |
| --- | --- |
| 头像组件 | `left-sidebar-icons.jsx` 末尾新增 `.sidebar-avatar`（**30×30 圆形 + 用户名首字母**，无用户名回退 `e`；点击进入设置；hover 品牌光环） |
| 底部避让 | `main.jsx` 注入 `--app-kbar-height`；`.sidebar` / `.sidebar-panel` 的 `bottom` 改为 `calc(var(--footer-stack-height) + var(--app-kbar-height))` —— 修正"底部内容被快捷键条/footer/状态栏遮挡" |

### 验证结果（CDP 实测）

```
头像: text=E, size=30x30, radius=50%     ✅ 渲染与样式正确
.sidebar bottom: 92px                    ✅ 避让计算生效（62 + 30）
overlappedByKbar: true                   ❌ 头像仍与快捷键条重叠，未达草图效果
```

### 位置问题的排查与修复（本轮内已解决）

**排查过程（两次误判 → 定位真因）**：

1. 首次：以为 `.sidebar` 的 CSS `bottom` 未生效。实测 `bottom: 92px` **已生效**，但元素高度仍 899。
2. 查明：`.sidebar` 的高度是 **JS 内联注入**（`index.jsx` 的 `style={{ width, height }}`），内联覆盖 CSS → 需在 JS 侧扣减。
3. 修正：`index.jsx` 中 `height - (footerHeight + statusBarHeight + appKbarHeight)`；并把头像从 `LeftSidebarIcons` 移到 `.sidebar-bar` **末尾**（原位置后面还有传输/关于/隐藏/缩放/升级图标，故不在栏底）。
4. 复查：CDP 报 `overlapped: true`（头像底 837 > kbar 顶 807）—— 但这是**只比垂直坐标**的误判；kbar 的 `left` 从 `--left-side-bar-width`(51px) 起，**水平上不与侧栏(0–50px) 重叠**，视觉无遮挡。

**最终验证（截图 `self-test/r18-avatar.png`）**：图标栏底部出现**蓝色渐变圆形头像（E）**，位于快捷键条左侧、状态栏上方，与草图 `.rail .av` 一致 ✅

> 教训：判定遮挡必须**同时比较水平与垂直坐标**，否则会把"同高度但不同列"的相邻元素误判为遮挡。

### 下一轮计划（按 `UI-重构计划.md`）

- **修 P1-1 收尾**：图标栏容器类名歧义 → 头像精确吸底；
- P1-2 左面板头「会话」；P1-3 标签栏 38px + 计数徽标；
- 之后 P1-4/5/6，再进入 Phase 2（用户项 2→3→4→1）。

---

## 第 19 轮 · Phase 1 全部完成（P1-2 ~ P1-6）

**时间**：2026-09-29 · **分支**：master

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **P1-2** 左面板头 | 新增「会话」标题（11px / `--text-dark` / 大写间距，对齐草图 `.panel-hd`）；页签字号 11px、`ant-tabs-nav` 去外边距 | 截图可见「会话 · 书签 \| 访问历史」 |
| **P1-3** 标签栏 | `.tabs` 36→**38px**、`.tabs-inner` 改 `flex + align-items:flex-end`、`.tab` 高 **32px** 底部对齐（对齐草图 `.tabbar`/`.tab`） | CDP：`tabsH=38`、`tabH=32` ✅ |
| **P1-4** 标题栏 | Logo 改**渐变圆角方块 + 品牌光晕**（草图 `.brand .logo`）；搜索框文案 →「搜索会话、命令、主机…」；kbd → `⌘K`(mac)/`Ctrl+K` | CDP：`logoBg=linear-gradient(135deg, rgb(0,136,204)…)`、文案 ✅ |
| **P1-5** 面包屑 | 新增**类型徽标**（SSH/SFTP/本地，复用 `typeText()`） | CDP：`badges=["已连接","Local"]` ✅ |
| **P1-6** AI 代码块 | `.code-block` 对齐草图 `.ai-msg code`：`--surface-3` 底 + `--radius-xs` 圆角 + `--font-mono` 11px | 编译通过（需 AI 对话时目视） |

### 本阶段的诚实边界

| 草图元素 | 现状与原因 |
| --- | --- |
| 状态栏 `ssh2·aes-256-gcm` / `zsh 5.9` / `↑↓ 速率` | **需数据管线**（协议层暴露算法、远端 shell、速率采样） |
| 面包屑 `● REC` | **需录制功能**（Phase 2 用户项 1） |
| 首页空态 `.home` 精细化 | 既有空态可用；视觉精细化未做（优先级低，列入 Phase 2） |
| AI 气泡左右分栏 | AI 消息由既有 `ai-chat-*` 组件渲染，本轮仅对齐代码块；分栏需改 AI 会话渲染 |
| 面板标题 i18n | `e('session')` key 不存在 → 直接用「会话」（与草图一致） |

### 截图

`self-test/r19-p1-done.png`：渐变 Logo + 搜索文案 + 「会话」面板头 + 38px 标签栏 + 面包屑双徽标 + 图标栏头像 + 右面板 AI 页签 + 快捷键条 + 状态栏。

### 下一阶段（Phase 2，按用户指定顺序）

1. 用户项 **2** —— `monitor` 页（CPU/MEM/DISK/NET 进度条 + 阈值配色 + 1s 刷新）
2. 用户项 **3** —— `transfer` 页（接入现有传输队列）
3. 用户项 **4** —— 头像账户菜单 / 标签栏收尾 / AI 气泡分栏
4. 用户项 **1** —— `⌘R` 会话录制

---

## 第 20 轮 · Phase 2 用户项 2：`monitor` 监控页

**时间**：2026-09-29 · **分支**：master

### 新增

| 文件 | 内容 |
| --- | --- |
| `remote-monitor/monitor-panel.jsx` | 监控页组件：复用 `useMonitorDetails`，渲染 **CPU / MEM / DISK / NET** 四条指标 |
| `remote-monitor/monitor-panel.styl` | 对齐草图 `.card-r` / `.metric`：标题行 + 指标条 + 右侧数值 + 副行（等宽） |
| `main.jsx` | 以 `<MonitorPanel />` 替换此前的占位 |

**阈值配色**（对齐草图 `.metric .bar i.warn`）：`≥70% → warn`、`≥90% → error`，条形用品牌渐变、过渡 180ms。

**数据映射**（复用既有采集，不新造数据）：`groupOf(snapshot,'cpu').data`（%）、`memory.percent/usedBytes/totalBytes`、`disks[0].percent/mount`、`selectPrimaryNetwork(network)` 的 `rxRate/txRate`。

### 验证（CDP 实测）

```
exists: true
metrics: 4
text: "系统负载 | CPU | — | MEM | — | DISK | — | NET | —"
```
✅ 组件与四条指标正常渲染。当前是**本地会话**（无远端 `/proc` 采集目标）故数值为 `—`；连上 SSH 主机后显示真实百分比与阈值配色。

**截图**：`self-test/r20-monitor.png`（右面板「监控」页签激活 + 系统负载卡片）。

### 差距复审（已写入 `UI-重构计划.md` §三·补）

- **已对齐**：布局骨架 / 图标栏(含头像) / 会话树 / 标签栏 / 标题栏 / 面包屑 / 终端光晕 / 快捷键条 / 状态栏 / 右面板三页签与监控页；
- **仍存差距 8 项**，分为「纯前端可做」（首页空态 E、图标顺序 F、会话树状态点与类型标签 G、transfer 页 H）与「需数据/功能支撑」（状态栏三段 A、shell 徽标 B、`● REC` C、AI 气泡分栏 D）。

### 下一轮计划

- 用户项 **3**：`transfer` 页接入现有传输队列（纯前端，差距 H）；
- 用户项 **4**：头像账户菜单、标签栏收尾、AI 气泡分栏（差距 D）；
- 用户项 **1**：`⌘R` 会话录制（差距 C 一并解决）。

---

## 第 28 轮 · 标签栏收尾（用户项 4 全部完成）

**时间**：2026-09-30 · **分支**：master · **改动**：`tabs/tabs.styl`

- `.tab-close` 关闭键：`display none/block` 突变 → **`opacity 0 → 0.7` 淡入**（对齐草图 `.tab .x{opacity:0;transition:opacity}`），120ms；
- 多标签核对结论：拖拽插入线（`item-dragover` 2px 品牌线）、计数徽标、状态圆点均已对齐草图 ✅。

**用户项 4 至此全部完成**（头像菜单 ✅ / AI 气泡分栏 ✅ / 标签栏收尾 ✅）。

---

## 第 27 轮 · 用户项 4：头像账户菜单

**时间**：2026-09-30 · **分支**：master · **改动**：`sidebar/index.jsx`、`sidebar.styl`

### 改动

| 项 | 改动前 | 改动后 |
| --- | --- | --- |
| 头像点击 | 直接打开设置弹窗 | 弹出**账户菜单**（Popover 右上）：`设置` / `设置同步` / `终端主题` / `关于`（全部复用既有动作函数） |

菜单样式对齐总方案：`--hover-bg` + 圆角 + 过渡（`sidebar.styl`）。

### 验证（CDP 实测）

```
点击头像 → menuOpen: true
items: ["设置", "设置同步", "终端主题", "关于"]
```
✅ 菜单打开与四项内容正确（文案来自 `window.translate`，随语言切换）。

**截图**：`self-test/r25-avatar-menu.png`。

**用户项 4 进度**：头像账户菜单 ✅ ｜ AI 气泡分栏 ✅（第 25 轮）｜ 标签栏收尾（待做，多标签拖拽细节）。

---

## 第 26 轮 · v4 深度层复核 ⑤ 弹窗

**时间**：2026-09-30 · **分支**：master · **改动**：`common/modal.styl`

### 草图规格 → 实现

| v4 草图 ⑤ | 现状 | 改动 |
| --- | --- | --- |
| **14px 圆角 + 描边环 + --shadow-3** | `--radius`(10) + 仅 shadow-3 | `border-radius var(--radius-lg)`（14px）+ `box-shadow 0 0 0 1px var(--border), var(--shadow-3)` |
| **标题栏 8% 品牌渐变洗染** | 无 | `linear-gradient(90deg, primary@8%, transparent)` |
| 关闭钮 hover 反馈 | ✅ 已有（`--hover-bg` + 过渡） | 无需改 |
| 保存按钮 hover **上浮 1px + 主色投影** | 无 | `.custom-modal-ok-btn:hover { translateY(-1px) + 0 6px 18px primary@40% }` |

### 验证（产物 CSS 实测）

```css
.custom-modal-content{background:var(--main);border-radius:var(--radius-lg);
  box-shadow:0 0 0 1px var(--border), var(--shadow-3);...}
标题洗染: linear-gradient(90deg, color-mix(in srgb, var(--primary) 8%, transparent), transparent) ×1
```
✅ 弹窗整改生效（桌面规则；移动端全屏规则不受影响）。

**视觉验收**：打开任意弹窗（如「编辑书签」）—— 圆角更大、描边环、标题栏淡淡的品牌洗染、保存按钮 hover 上浮。

### v4 12 区复核进度更新

| 区 | 状态 |
| --- | --- |
| ①②③④⑥⑦⑧⑨⑩⑪ | ✅ |
| **⑤ 弹窗** | ✅ 本轮 |
| ⓪ 无会话首页 | 🟡 待做（需新增首页视图，成本中高） |

**v4 复核仅剩 ⓪**。

---

## 第 25 轮 · 用户项 4（部分）：AI 对话气泡左右分栏

**时间**：2026-09-30 · **分支**：master · **改动**：`ai/ai.styl`

### 实现（样式层，零功能风险）

AI 历史条目结构是「用户问题（antd `Alert`）+ AI 回复（`AIOutput`）」一体，**不改 JSX**（避免影响展开/复制/停止等功能），纯样式分栏：

| 草图 | 实现 |
| --- | --- |
| `.ai-msg`（AI 回复，左） | `.chat-history-item .ai-stream-output`：`margin-right:auto` + `--surface-1` 底 + `1px --border` + 圆角 |
| `.ai-msg.me`（用户，右 + 品牌浸染） | `.chat-history-item .ant-alert`：`margin-left:auto` + `--active-bg` 底 + 品牌色 30% 描边 + 圆角，`max-width 92%` |

### 验证（产物 CSS 实测）

```css
.chat-history-item .ant-alert{...background:var(--active-bg);border-color:color-mix(... 30%...);max-width:92%;margin-left:auto}
.chat-history-item .ai-stream-output{...border:1px solid var(--border);background:var(--surface-1);max-width:96%;margin-right:auto}
```
✅ 两条规则均已编译进产物（截图验证需发起一次 AI 对话，留待用户验收）。

### 说明

- 「who 标签」（草图气泡上的 AI / 你）未加：需改 JSX 结构，当前分栏视觉已可区分归属；
- 会话历史（`ai-chat-history-item`）与流式输出共用 `ai-stream-output` 容器，样式一并生效。

---

## 第 23 轮 · 方案整合 + 用户项 3（`transfer` 传输页）

**时间**：2026-09-30 · **分支**：master

### 1) 方案整合：新增 `UI-美化与重构总方案.md`（统一入口）

把此前分散的 6 份文档串成一条主线：

| 内容 | 来源 |
| --- | --- |
| 文档地图与**权威优先级** | 本次整合 |
| 三层设计体系（L1 token / L2 统一层 / L3 v4 Tinted Console） | `UI-美化设计规范.md` v3 + v4 草图 |
| **七维度质量门**与当前状态 | `美化实施七维度审计报告.md` |
| 结构重构进度（Phase 1 已完成清单 + 🟡 待完成清单） | `UI-重构计划.md` + 本报告 |
| v4 深度层 **12 个区域复核表** | `美化效果预览草图-v4深度版.html` |
| 执行路线（6 步）与**红线**（5 条） | 本次整合 |

### 2) 用户项 3：`transfer` 传输页

| 项 | 内容 |
| --- | --- |
| 新增 | `file-transfer/transfer-panel.jsx` + `.styl` |
| 数据 | **复用既有** `store.fileTransfers / transferHistory / transferTab`，不新造数据 |
| 空态 | 无任务时显示「传输 · 0 · 暂无传输任务。拖拽文件或使用 SFTP 面板即可开始传输。」 |
| 有任务时 | 直接渲染既有 `TransferModal`（列表 + 进度 + 历史 + 失败重试） |
| 挂载 | `main.jsx` 以 `<TransferPanel />` 替换此前的占位 |

### 验证（CDP 实测）

```
exists: true
activeTab: "transfer"
text: "传输 | 0 | 暂无传输任务。拖拽文件或使用 SFTP 面板即可开始传输。"
```
✅ 页签切换与空态渲染正确；有传输任务时会渲染既有队列（复用组件，行为与 footer 弹层一致）。

**截图**：`self-test/r23-transfer.png`。

### 右面板三页现状

| 页签 | 状态 |
| --- | --- |
| AI | ✅ 既有 AI 助手 |
| **传输** | ✅ 本轮接入（复用 TransferModal） |
| 监控 | ✅ 第 20/21 轮（默认不采集、手动开启） |

### 下一轮计划

按总方案 §5 路线：
1. **SFTP / 弹窗 / 消息 三区按 v4 草图逐项核对**（v4 深度层复核）；
2. 首页空态精细化 + 会话树节点状态点/类型标签 + 图标栏图标顺序；
3. 头像账户菜单 + AI 气泡分栏（用户项 4）；
4. 状态栏三段 + 面包屑 `SSH/zsh`（数据管线）；
5. `⌘R` 会话录制（用户项 1）。

---

## 第 22 轮 · 修复右面板遮挡内容区（用户红框报障）

**时间**：2026-09-30 · **分支**：master
**报障**：右上角图标组（`⌕ □ ⌄`）位置异常 / 底部快捷键条与状态栏挤在一起。

### 排查（CDP 实测坐标）

| 元素 | 实测 | 判定 |
| --- | --- | --- |
| `.right-side-panel` | `left 1131 → right 1439`（308px） | 右面板 |
| `.terminal-control`（会话控制条） | `left 50 → right 1439` | **未扣减面板宽度** |
| `.term-controls`（图标组） | `left 1395 → right 1429` | **落在面板区域内(1131+)，被面板盖住** ✗ |
| `.term-wrap`（终端） | `left 50 → right 1439` | 同样未扣减 |

### 根因

第 15 轮把右面板改为**默认显示**时，其默认状态是 **overlay（浮层，`rightPanelPinned=false`）**。而 `layout.jsx` 只在 **pinned(dock)** 时才扣减宽度：

```js
const r = rightPanelVisible && rightPanelPinned && !isMobile ? rightPanelWidth : 0
```

于是浮层模式下内容区仍按全宽布局，右侧控制条图标被面板压在下面；底部快捷键条也因此横跨到面板下方。**草图是三栏并排**，应走 dock。

### 修复

| 项 | 改动 |
| --- | --- |
| 默认停靠 | `init-state.js`：`rightPanelPinned` 无存储值时默认 **`true`**（dock），内容区据此让位（`layout.jsx` 的 `r` 生效） |
| 面板高度 | `right-side-panel.styl` 的 `.right-side-panel-pinned` 加 `bottom: calc(var(--footer-stack-height) + var(--app-kbar-height))`，避免盖住 footer/状态栏/快捷键条 |
| 快捷键条让位 | `main.jsx` 注入 `--right-panel-dock-width`；`.app-kbar { right: var(--right-panel-dock-width, 0px) }`，使其落在内容区内 |

### 验证（CDP 实测，停靠后）

```
pinned: true
.term-controls: 1087 → 1121
.right-side-panel: 1131 → 1439
overlaps: false          ← 图标组已在面板左侧之外，不再被遮挡
```

**截图**：`self-test/r22-dock-fix.png` —— 图标组回到内容区右上；右面板独立成列；快捷键条右边界与面板左边界对齐；footer 与状态栏各就其位。

### 说明

- 该问题在**第 15 轮（右面板默认显示）引入**，此前默认隐藏所以未暴露；
- 若用户此前手动点过"图钉"（pin），localStorage 内有值会覆盖默认 —— 用户侧如仍异常，点一次图钉或在应用内清站点数据即可。

---

## 第 21 轮 · 监控改为「默认关闭，手动开启后采集」

**时间**：2026-09-29 · **分支**：master
**需求**：资源监控默认不开，开启后再监控。

### 改动

| 项 | 内容 |
| --- | --- |
| 采集门控 | `enabled = store.rightPanelMonitor && rightPanelTab === 'monitor'` —— **默认 `false`**，未开启时**完全不发起远端采集** |
| 开关 | 面板头右侧加 `<Switch size='small'>`，切换 `store.rightPanelMonitor` |
| 默认态 UI | 关闭时只显示说明文案（"资源监控默认关闭。打开右上角开关后才会连接远端采集 CPU / 内存 / 磁盘 / 网络 指标。"），**不渲染任何指标行** |
| 状态存放 | `store.rightPanelMonitor`（运行时状态，**重启回到默认关闭**；不写入配置，避免长期轮询远端） |

### 验证（CDP 实测，两态对比）

```
默认态: monitorFlag=false  hint=true   metrics=0  hasSwitch=true   ← 未采集、无指标行
开启后: monitorFlag=true                  metrics=4                ← 4 条指标出现
```
✅ 完全符合「默认不开、开启后再监控」。

**截图**：`self-test/r21-monitor-opt-in.png`（默认态：提示文案 + 开关）。

### 设计取舍（说明）

- 选择**运行时状态**而非持久化配置：避免用户曾经开过一次后，之后每次启动都自动轮询远端（监控会周期性执行 shell 命令，有成本）；
- 若后续希望"记住上次选择"，可改为写入 `config`（1 行改动），按需再说。

### 下一轮计划（Phase 2 剩余）

1. 用户项 **3** —— `transfer` 页（接入既有传输队列）
2. 用户项 **4** —— 头像账户菜单 / 标签栏收尾 / AI 气泡分栏
3. 用户项 **1** —— `⌘R` 会话录制
