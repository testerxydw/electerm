# PR 描述（贴到 GitHub PR 表单）

> 目标仓库：`electerm/electerm`（upstream）← `testerxydw/electerm:ui-beautification`
> 一键创建链接：
> https://github.com/electerm/electerm/compare/master...testerxydw:electerm:ui-beautification?expand=1
> 标题：feat(ui): unified design tokens, accessibility & CSS contract tests

---

## 概述

基于 5.5.26，在**不重命名类名、不增删 DOM、默认零布局位移**的前提下，为全部页面建立统一的「色阶 / 圆角 / 阴影 / 动效 / 焦点」token 体系，并逐区域精修。

**46 commits · 57 files · +2109 / −853**（每步一个独立提交，可单独 revert）

## 实现功能

- **Layer 1 · 设计 token**（新增 `css/includes/tokens.styl`）：18 个变量全部 `color-mix` 从既有 12 个主题色派生——浸染色阶 4 级、`--hover-bg`、`--border`、阴影三档、时长/缓动、光晕、状态色底芯片、等宽字体栈。310 个 iTerm 主题（含浅色）自动适配，主题保存白名单 `requiredThemeProps` **零触碰**
- **Layer 2 · 统一收敛**：px 圆角 12 种 → 5 档（45 处）；阴影 22 种 → 3 档 + 功能白名单（17 处）；硬编码颜色 33 处 → **0**；transition 覆盖 8 → 20 文件（统一 120ms）；antd 桥接修复（圆角 3→8、恢复动效、surface/边框映射）
- **无障碍**：全局 `:focus-visible` 描边环（鼠标点击不出环）；`prefers-reduced-motion` 全局兜底；CJK 字体回退；**9 处 3.89:1 对比度整改**（→≈11.3:1）；修复 `darker()` 无边界钳制导致深浅主题共 55 处声明静默失效的 bug
- **区域精修（v4 四要素）**：标签栏浸染+渐变强调线、无会话首页品牌光晕、SFTP 斑马纹+左色条、右键菜单描边环、消息/传输状态芯片、侧栏/底栏/树列表/设置/AI/快捷键条等 26 区域
- **修复**：恢复态窗口图标不可辨（无效颜色 `solid text`）+「回」字叠线几何修正；系统标题栏模式下隐藏原生菜单栏（role 快捷键保留）；表单标签全面左对齐（用户授权的布局调整）；`build-deb-fast.js --prepare` 连带删除渲染层产物的顺序缺陷
- **测试**：新增 4 个 CSS 契约守卫单测（变量引用一致性 / 主题 key 契约 / 零硬编码色 / 圆角阴影白名单，均含反向验证）；修复 db-migrate 并行竞态（NeDB 双实例 compaction ENOENT）与 ESM 加载

## 修改文件

| 分组 | 文件 |
| --- | --- |
| token 与全局 | `css/includes/tokens.styl`（新）、`index.styl`、`theme.styl`、`basic.styl`、`css/mobile.styl` |
| 组件样式（39） | tabs、sidebar、footer、sftp、session、terminal、sys-menu、quick-commands、common、setting-panel、theme、bookmark-form、tree-list、ai、rdp/vnc/spice、shortcut-bar 等 |
| JS 逻辑（5） | `store/store.js`（antd token）、`main/ui-theme.jsx`（darker 修复 + theme-light）、`common/form-layout.js`（表单左对齐）、`app/lib/create-window.js`（菜单栏隐藏）、`build/bin/build-deb-fast.js` |
| 测试（5） | `unit-ci/css-tokens` / `theme-props` / `css-hardcoded-colors` / `css-radius-shadow`（新增）、`db-migrate`（竞态修复）、`package.json`（test 脚本） |
| 文档（3） | UI-美化设计规范（v4）、上游升级差异审计、七维度审计报告 |

## 验证

- `npm run lint` ✅ · `npm run compile` ✅ · **`npm run test-unit-ci` 460/460** ✅
- CSS 产物 78.4 → 83.5 KB（+6.6%）；`color-mix` 压缩后存活；新增 `display:none` = 0（e2e 可见性断言零风险）
- 深浅主题（默认 + 3024 Day）目视通过；打包 deb 全链路验证

## 兼容性与遗留

- 主题系统契约（33 key 白名单、310 iTerm 主题、空配置回落）零改动，有单测守卫
- 遗留（范围外）：浅色主题 `--success` 对比度 1.61:1（改色牵连主题语义，建议后续 issue）；RDP/VNC/SPICE 会话内目视待补
