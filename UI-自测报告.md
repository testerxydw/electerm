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
