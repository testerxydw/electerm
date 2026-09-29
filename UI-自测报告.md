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
