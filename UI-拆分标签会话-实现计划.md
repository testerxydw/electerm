# 标签右键菜单：原地拆分会话到新 pane 实现计划

> **任务范围**：Electerm vs Windterm 对比分析 + 原地拆分会话功能设计与实现
> **本次只做**：原地拆分会话到新 pane（水平 / 垂直两个方向）
> **后续 P0**：closeTabsLeft / closeAllTabs / reopenClosedTab / 会话设置对话框
> **后续 P1**：setColor / copySessionUrl / copySessionName / 移动到分组 / 保存到书签

---

## 一、现状对照

### 1.1 Windterm 标签右键（截图）

Windterm 的"拆分会话"是**在当前 pane 内**新开一个同 layout 的 pane，同一会话或克隆会话跑在新 pane。

### 1.2 Electerm 当前标签右键（`tab.jsx` renderContext）

| 菜单项 | 状态 | 备注 |
|---|---|---|
| close | ✅ | |
| closeOtherTabs | ✅ | |
| closeTabsRight | ✅ | |
| newTab | ✅ | |
| duplicate | ✅ | |
| cloneToNextLayout | ⚠️ | 只切 layout + 克隆，不是原地拆 |
| rename | ✅ | |
| pin/unpin | ✅ | 独有好功能 |
| reload | ✅ | |
| reloadAll | ✅ | |

**缺失（P0 核心）**：原地拆分到新 pane、closeTabsLeft、closeAllTabs、reopenClosedTab、会话设置对话框

**已有确认**：`broadcastInput / toggleBroadcastInput`（session-control.jsx）= Windterm 的"同步输入"

---

## 二、当前 cloneToNextLayout 问题

### 2.1 现状代码

`store/tab.js` `cloneToNextLayout`：
```
- 只能从当前 layout 切到下一个 layout（c1→c2→c3→c2x2→...循环）
- clone 的新 tab batch = (currentBatch + 1) % maxBatch
- 没有"用户指定方向"（水平 vs 垂直）的能力
```

### 2.2 Windterm 语义

Windterm 拆分分两个动作：
1. 选方向（水平 / 垂直）
2. 新 pane 承接一个 clone 会话（或共享会话）

Electerm **layout 没有方向元数据**——只有 pane 数量（c2 是水平两栏还是垂直两栏？取决于 `layouts.jsx` 的 split 方式）。

### 2.3 Electerm 的 layout 结构

`splitConfig` 里的 key 命名暗含方向：
- **c 开头**（column）：水平排列（左右分）→ c2 = 两列水平
- **r 开头**（row）：垂直排列（上下分）→ r2 = 两行垂直

**但**当前 Electron 渲染里 `c2` 和 `r2` 可能是同一套布局（取决于 `layouts.jsx` 里 split 的 orientation）。需要先确认 `layouts.jsx` 中 c2 / r2 的实际方向。

---

## 三、本次实现方案（原地拆分会话）

### 3.1 设计原则（最小改动）

不引入"共享 PTY"语义（复杂），**克隆会话 + 切到带新 pane 的 layout + 把 clone 放进新 pane**。

### 3.2 拆分方向 → layout 映射表

| 当前 layout | 水平拆分（左右加栏）→ | 垂直拆分（上下加栏）→ |
|---|---|---|
| c1 | c2（加一列） | r2（加一行） |
| c2 | c3（三列） | c1r2（上1下2，当前 pane 保持） |
| r2 | r1c2（左1右2） | r3（三行） |
| c3 | c2x2（4 格） | c1r2（取剩余 1→c2 下） |
| r3 | r1c2（取剩余 1→r2 侧） | c2x2（4 格） |
| c2x2 | c2x2 + 警告"已是最大" | 同左 |

**简化方案**：先只做 c1→c2 / c1→r2 / c2→c3 / r2→r3 这几个最常见路径，其他 fallback 到 cloneToNextLayout 行为。

### 3.3 新菜单项（插入现有 renderContext）

```
现有 renderContext 顺序 → 新增 2 项:

close
closeOtherTabs
closeTabsRight
──────────────── 分隔线 ────────────────
splitHorizontal (新增)   ← Alt+W, Alt+H
splitVertical   (新增)   ← Alt+W, Alt+V
cloneToNextLayout (保留)
newTab
duplicate
rename
pin/unpin
reload
reloadAll
```

### 3.4 新方法（store/tab.js）

```js
/**
 * 在指定方向上拆分会话: 克隆当前 tab + 切到带新 pane 的 layout + 放进新 pane
 * @param {'h'|'v'} direction  h=水平左右, v=垂直上下
 */
Store.prototype.splitTab = function (direction = 'h') {
  const { store } = window
  const tab = store.currentTab
  if (!tab) return

  const curLayout = store.layout
  const curBatch = tab.batch
  const maxBatch = splitConfig[curLayout]?.children || 1
  const nextBatch = maxBatch  // 新 pane 的 index（追加）

  // 1. 决定目标 layout
  const targetLayout = pickTargetLayout(curLayout, direction)
  if (!targetLayout || targetLayout === curLayout) {
    return message.warning('Cannot split further')
  }

  // 2. 切 layout
  store.setLayout(targetLayout, false)  // 不自动 distributeTabs，我们自己分配

  // 3. clone tab + 放进新 batch
  store.duplicateTabToBatch(tab.id, nextBatch)
}

/**
 * 复用 duplicateTab 逻辑但允许指定目标 batch
 */
Store.prototype.duplicateTabToBatch = function (tabId, targetBatch) {
  // clone tab → new id → batch=targetBatch → splice 到末尾 → activate
}
```

### 3.5 辅助函数（新文件或内联）

```js
// pickTargetLayout: 当前 layout + 方向 → 下一个 layout
// 简化映射表（只覆盖常见路径，其他 fallback 或 warning）
const splitLayoutMap = {
  c1:  { h: 'c2',    v: 'r2'    },
  c2:  { h: 'c3',    v: 'c1r2'  },
  r2:  { h: 'r1c2',  v: 'r3'    },
  c3:  { h: 'c2x2',  v: 'c2x2'  },
  r3:  { h: 'c2x2',  v: 'c2x2'  },
}
// 未匹配的 layout: 保持当前 + message.warning("无法拆分")
```

### 3.6 快捷键

| 动作 | 快捷键 | 说明 |
|---|---|---|
| splitHorizontal | Alt+W, Alt+H | 水平拆分 |
| splitVertical | Alt+W, Alt+V | 垂直拆分 |

注册位置：`src/app/lib/key-bind.js`（主进程）或 `shortcut-handler.js`（客户端）

---

## 四、改动文件清单

| 文件 | 改动 | 估计行数 |
|---|---|---|
| `src/client/store/tab.js` | 新增 `splitTab(direction)` + `duplicateTabToBatch(tabId, batch)` + `splitLayoutMap` | ~50 行 |
| `src/client/components/tabs/tab.jsx` | `renderContext()` 加 2 项菜单项 + 2 个 handler + 2 个 shortcut desc | ~30 行 |
| `src/client/common/constants.js` | 无（splitConfig 已够用）| 0 |
| `src/app/lib/key-bind.js` | 2 个新快捷键定义 | ~10 行 |
| 国际化文件（`src/client/lang/*.js` 或 locale json）| 2 个新 key：splitHorizontal / splitVertical | ~10 行 |
| e2e 测试 `src/test/e2e/02.5.*.spec.js` | 新增 splitTab 场景测试 | ~40 行 |

---

## 五、边界情况

| 场景 | 处理 |
|---|---|
| c1r2 → 水平拆分 | 选 c2x2（上1下2 变 4 格）|
| r1c2 → 垂直拆分 | 选 c2x2 |
| c2x2 再拆 | warning "已到最大布局" |
| clone 的 tab 是 SSH + 有 session state | 复用 `captureSshSessionState` + `_reloadState`（已有逻辑） |
| 目标 batch 被 distributeTabs 覆盖 | 调用 setLayout(..., false) 禁止自动 distribute，我们自己放 |
| 用户有 pinned tab | duplicateTab 已处理（不会 pin clone，除非显式 pin） |
| 当前 tab 有 SFTP / tunnel 状态 | 复用 `duplicateTab` 已有字段拷贝 |

---

## 六、实施步骤

1. **先读** `layouts.jsx` 确认 c2 / r2 在渲染上的方向（水平 vs 垂直）——决定 splitLayoutMap 的正确性
2. **写** store/tab.js 两个新方法 + splitLayoutMap
3. **写** tab.jsx 菜单项 + handler
4. **注册** 快捷键
5. **写** 国际化文案（先写中文，英文翻一下）
6. **跑** 全量测试 `npm run test-unit-ci`
7. **编** 译 + 打测试包

---

## 七、验证要点

| 测试 | 方法 |
|---|---|
| c1 水平拆 → c2 | 右键标签→水平拆分，看 layout 是否变 2 列，新 pane 里是 clone 会话 |
| c1 垂直拆 → r2 | 同上，方向应垂直 |
| c2 水平拆 → c3 | 3 列，新 clone 在 batch=2 |
| c2 垂直拆 → c1r2 | 上1下2 |
| 快捷键 | Alt+W, Alt+H / Alt+W, Alt+V |
| clone SSH 保留状态 | reload / 重连后不应断连 |
| 测试 | `npm run test-unit-ci` 全绿 |

---

## 八、后续 P0/P1 待做（不在本次范围）

### P0：
- closeTabsLeft / closeAllTabs —— 对称补齐 closeTabsRight
- reopenClosedTab —— 需维护 closedTabs 栈
- 会话设置对话框 —— 打开 bookmark-form 预填

### P1：
- setColor 子菜单 —— tab.color 字段已有，加 ColorPicker UI
- copySessionUrl / copySessionName —— navigator.clipboard.writeText
- 移动到分组 / 保存会话到书签 —— tab ↔ bookmark 桥接
