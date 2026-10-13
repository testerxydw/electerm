# 分析报告：上游 SSH/SFTP 拆分视图底部错位

> 性质：仅分析与修复建议，不动手修改（按用户要求）
> 日期：2026-10-13
> 结论速览：Splitter 容器与 SFTP 面板内容使用了**未扣减顶部占位**的原始高度（session.jsx 两处），底部超出 .session-wrap 裁切线约 69px；终端一侧因用 computeHeight 正确扣减而贴线，两侧底缘不对齐即用户可见的"底部错位"。

---

## 1. 现象

- SSH/SFTP 拆分视图（`tab.sshSftpSplitView`）下，SFTP 面板底部越过底部栏上缘
- CDP 实测（窗口 innerHeight=1439）：
  - footer 上缘 y=1409
  - `.session-wrap`（overflow:hidden）裁切线 y=1410
  - Splitter 容器底缘 y=1479 → **超出裁切线约 69px**
- 终端一侧（term-wrap）恰好贴合裁切线，掩盖了 Splitter 容器超高；仅 SFTP 一侧内容暴露错位

## 2. 根因链（含代码位置）

布局纵向占位（已实测核实）：

```
session-wrap (inset:0, padding-top:36px 标签栏)
  ├─ SessionControl 条 33px（.terminal-control line-height:32 无显式 height，被内容撑高 1px）
  └─ 内容区：顶部共占 68~69px，可用高 = H - 68
```

1. [sessions.jsx computeHeight](file:///media/dp25/DATA/deb/fcitx5-deb/github/electerm/src/client/components/session/sessions.jsx)：`computeHeight(H) = H - tabsHeight(36) - termControlHeight(32)`（常量在 [common/constants.js](file:///media/dp25/DATA/deb/fcitx5-deb/github/electerm/src/client/common/constants.js)）——term-wrap 使用它，**正确**贴合裁切线
2. [session.jsx L555-564](file:///media/dp25/DATA/deb/fcitx5-deb/github/electerm/src/client/components/session/session.jsx#L555-L564)：`splitterProps.style.height = this.props.height + 'px'`——使用**原始高度**（未扣 68 顶部占位）→ Splitter 自 y≈69 起铺原始高 ≈1410，底缘达 ≈1479，超出裁切线 69px
3. [session.jsx L367-386 calcSftpWidthHeight](file:///media/dp25/DATA/deb/fcitx5-deb/github/electerm/src/client/components/session/session.jsx#L367-L386)：SFTP 面板内容高同样以原始 `height` 为基准（leftRight: `h=height`；topDown: `h=size2%×height`）→ SFTP 内容按超高分配，底部 69px 被 overflow hidden 裁切
4. [session.jsx L388+ calcTermWidthHeight](file:///media/dp25/DATA/deb/fcitx5-deb/github/electerm/src/client/components/session/session.jsx#L388-L400)：终端侧用 `computeHeight(this.props.height)`——正确

**错位本质：同一容器内，终端侧用"扣减后高度"、Splitter 容器与 SFTP 侧用"原始高度"，两套基准并存。**

## 3. 影响面

- 仅影响 `sshSftpSplitView` 拆分视图；普通终端 pane / 全屏 SFTP pane 不受直接影响
- leftRight（左右拆分）：SFTP 面板整体超高，底部被裁
- topDown（上下拆分）：SFTP pane 高度按 `size2%×原始高` 分配，比例失真且底部被裁
- 分隔条拖动比例基于错误总高，视觉比例与实际分配有偏差
- 上游固有缺陷（非本分支引入），合并上游时不冲突，但上游若重构 Splitter（如 issue #4569 分屏相关改动）需留意

## 4. 修复建议（供决策，未动手）

### 方案A（推荐）：JS 侧统一扣减，两处联动
1. [session.jsx L562](file:///media/dp25/DATA/deb/fcitx5-deb/github/electerm/src/client/components/session/session.jsx#L562)：`height: this.props.computeHeight(this.props.height) + 'px'` —— 与 term-wrap 同基准
2. [calcSftpWidthHeight](file:///media/dp25/DATA/deb/fcitx5-deb/github/electerm/src/client/components/session/session.jsx#L367-L386)：函数内 `height` 基准改为 `this.props.computeHeight(this.props.height)`

- 优点：与终端侧既有 computeHeight 体系一致，改动 2 行，语义清晰
- 注意点：calcSftpWidthHeight 也被非拆分场景复用（L372-377 提前返回原始 height）——修改时需同步确认非拆分路径的 renderSftp 高度来源，避免只改拆分分支导致两分支基准分裂

### 方案B（不推荐）：CSS 约束
给 Splitter 容器加 `height: calc(100% - 69px)` 之类约束。
- 缺点：69px 为实测值（33px 控制条有 1px 漂移，36 标签栏为变量），CSS 硬编码会与 JS 常量漂移，重蹈 2026-10-13 底部遮挡问题的覆辙

### 验证清单（实施时）
1. CDP 实测 Splitter 底缘 = `.session-wrap` 裁切线（误差 ≤1px）
2. leftRight / topDown 两方向、拖动分隔条至 20%/80% 两极
3. 非拆分视图回归（终端全屏、SFTP 全屏）
4. 窗口 resize 后复测（高度自适应场景）
5. lint + compile + 813 项单测 + 打包安装实测

## 5. 风险提示

- computeHeight 相关改动在 2026-10-13 曾出过"33px 遮挡"回归（历史教训：判断布局扣减是否"幽灵"必须 CDP 实测 DOM 几何，不能只靠代码推断）——本修复方向与该事件结论一致（顶部占位 68px 必须扣），属**补齐遗漏的扣减**而非新扣减，风险低但必须实测
- `.terminal-control` 实占 33px vs 扣减 32px 存在固有 1px 漂移（用户已接受），修复后底缘可能仍有 ≤1px 误差，属预期
