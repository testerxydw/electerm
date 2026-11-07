# db-session.jsx 继续拆分方案（N11b）

> 状态：**执行中**（2026-11-07）。N11a 的 §2 队列已全部收口（`db-session.jsx` 9970 → 6290 行）；
> N11b 第一批 #22 → #23 → #24 已全部收口（6290 → 5680 行）。
> 本文回答一个问题：**还能不能继续拆、值不值得拆、按什么顺序拆**。执行进度见 §7。

---

## 1. 结论先说

**还能拆，但性质变了。**

前 21 个簇解决的是「行为归位」—— state / handler / effect 各回各家，每一簇都有明确的单一职责和大量可搬运的代码。这轮之后剩下的东西分两类：

1. **还有真实的 SRP 问题**：Redis 簇的 24 个 state、5 个 token ref、188 行 handler、78 行渲染，散在文件的三处（620–696 / 2048–2233 / 5650–5727），三者之间隔着两千行。这是目前最刺眼的「一个变更理由被劈成三段」。
2. **已经没什么可归位的了**：render 区的 2265 行几乎全是 antd 组件组合，里面没有独立行为，只有「读 owner 的 state 再画出来」。继续拆它是在搬 JSX，不是在分职责。

所以建议：**逻辑区继续拆到底（约 1300 行收益），render 区只挑 3–4 块断言面可控的，剩下的明确不拆。**

终态预估：**6290 → 约 3600 行**，之后停止。

---

## 2. 现状量化

| 区段 | 行号 | 行数 | 占比 | 性质 |
|---|---|---|---|---|
| 连接/错误/初始 state | 1–324 | 324 | 5.2% | 逻辑 |
| 逻辑区（state / hook 接线 / handler / memo） | 325–3448 | 3124 | 49.7% | 逻辑 |
| error / !ready 早退 | 3449–3491 | 43 | 0.7% | 早退 |
| render 片段定义（`const xArea = (...)`） | 3492–5756 | 2265 | 36.0% | JSX |
| `return (...)` 主挂载 | 5757–6290 | 534 | 8.5% | JSX |

**逻辑 3448 行 / JSX 2799 行**。已拆出的 hook/组件 16 个，都在同目录。

### 2.1 契约面的现实

`src/test/unit-ci/` 下 **49 份 spec 直读 `db-session.jsx`**。这是拆分成本的主要构成，但它不等于「49 次重写」：

- 拆**逻辑 hook**：多数簇的符号在 spec 里命中 0–4 次，跟迁成本 ≈ 改 1–3 份 spec 的组合读取源。
- 拆**render 组件**：断言的是 JSX 接线锚点，命中面 5–20 份，但每份仍只是加一行 `readFileSync`。
- 真正的硬约束是 `db-sql-editor-shell.spec.js` / `db-grid-scroll.spec.js` 的 **hooks 顺序守卫**：任何 `useState/useMemo/useRef/useEffect` 都必须排在 `if (error)`（3449）与 `if (!ready)`（3465）之前。

### 2.2 各候选簇的契约命中面（实测）

| 候选簇核心符号 | 命中 spec 数 |
|---|---|
| `dataWidths` / `visibleColumnNames` | 2 |
| `renderCell` / `sqlResultColumns` / `sqlResultViews` / `treeData` | 3 |
| `sqlCellInfo` / `visibleMetadata` / `selectRedisKey` | 2–4 |
| `openDataCellMenu` / `colTypeByName` / `loadErGraph` / `openStructureDiff` / `loadRedisSlowlog` / `startHistResize` | 1 |
| `applyTtl` / `delSelectedKey` / `insertTemplate` / `templateMenu` / `formatSqlEditor` / `onHistKeyDown` / `foreignKey` | 0 |

结论：**逻辑区的跟迁成本比预期低一个量级**，可以放心做。

---

## 3. 剩余可拆清单

### L1 逻辑区（低风险，建议全部做）

| # | 簇 | 现状位置 | 行数 | 目标文件 | 契约跟迁 |
|---|---|---|---|---|---|
| 1 | ✅ 网格列定义（`renderCell` / `colMenu` / `columnWidths` / `colTypeByName` / `colCommentByName` / `orderedColumnNames` / `hiddenColumnSet` / `visibleColumnNames` / `rowColumnNames` / `openDataCellMenu` / `dataWidths` / `colFitAllBtn` / `toggleColumnVisible` / `moveColumn` / `columns`） | 2275–2614 | 实测 owner −275 / hook 407 | `use-db-grid-columns.jsx` ✅ 已建 | 5 份（已跟迁） |
| 2 | ✅ SQL 结果列定义（`sqlColumnKeys` / `sqlColWidths` / `sqlFitted` / `sqlWidths` / `sqlColTypeMaps` / `sqlResultColumns` / `sqlSortNumeric` / `sqlResultViews` / `sqlCellInfo` / `sqlValuePane` / `sqlPaneShown`） | 2616–2802 | 实测 owner −171 / hook 254 | `use-db-sql-result-columns.jsx` ✅ 已建 | 5 份（已跟迁） |
| 3 | ✅ 树数据（`visibleMetadata` / `countTreeNodes` / `treeFilterNodeCount` / `treeTitle` / `treeData`） | 2804–2969 + 195–209（图标表） | 实测 owner −171 / hook 233 | `use-db-tree-data.jsx` ✅ 已建 | 8 份（已跟迁） |
| 4 | Redis 键浏览（键列表/键树/选中/详情/TTL：`redisDb` 起 24 个 state 中的浏览类 + `selectRedisKey` / `applyTtl` / `delSelectedKey`） | 620–696 + 2142–2233 | ~230 | `use-db-redis-browse.js` | 3–4 份 |
| 5 | Redis 实例视图（`redisInfo` / `er` / `structDiff` / `redisSlowlog` + `loadErGraph` / `openErGraph` / `closeErGraph` / `loadDiffStructure` / `openStructureDiff` / `closeStructureDiff` / `loadRedisSlowlog`） | 661–673 + 2048–2141 | ~110 | `use-db-redis-instance.js` | 3 份 |
| 6 | SQL 文件读写（`sqlFile` / `sqlFileDirty` + `sqlBufferReplacable` / `confirmReplaceBuffer` / `openSqlFile` / `saveSqlFile`） | 492–493 + 1973–2046 | ~85 | `use-db-sql-file.js` | 1–2 份 |
| 7 | 连接生命周期（`doConnect` / `connectOtherDb` / `reconnect` / `retryConnect` + 连接 effect） | 893–994 | ~102 | `use-db-connection.js` | 1–2 份 |
| 8 | 视图操作（`patchViewColumns` / `turnPage` / `onColSort` / `onViewApply` / `onViewReset`） | 1169–1275 | ~107 | `use-db-view-actions.js` | 2–3 份 |
| 9 | 外键引用侧栏（`refInfo` / `refsKeyRef` / effect / `refItems` / `showRefTab`） | 404–466 | ~63 | `use-db-foreign-refs.js` | 0 |

L1 小计：**约 1300 行**，owner 降到 **约 5000 行**。

> **第 4、5 项（Redis）要单独说明**：这两块的收益**不是行数，是结构**。
> 现状 `useDbRedisKeys`（816–849）一口气注入 **33 个参数**，全部是 Redis state；`useDbRedisWrite`（2256–2274）又注入其中一批；而 `selectRedisKey`（2142）反过来通过 `(...a) => selectRedisKey(...a)` 惰性箭头注回 `useDbRedisKeys` —— **存在双向依赖**。
> 所以这里不能只「把 state 搬进 hook 返回 30 个名字」（那只会让 owner 多一片无人使用的解构）。正确切法是：
> - `use-db-redis-browse.js` 持有浏览类 state + `selectRedisKey` / `applyTtl` / `delSelectedKey`，并把 `loadRedisKeys` 等通过 `bridge` 惰性取（沿用现有 `Object.assign(bridge, ...)` 机制）；
> - `use-db-redis-instance.js` 持有 INFO / 慢日志 / ER 图 / 结构对比的 state 与 handler，与浏览类**无交集**，可独立先做；
> - 做完这两块后，`use-db-redis-keys.js` 的 33 个注入参数应当缩到 5 个以内（state 从 state hook 内部直取）。
> 如果只是为了减行数，这一项**投入产出比最差**；如果为了「Redis 首次做到 state / 逻辑 / 渲染三层分离」，它是最值得做的一项。建议先做第 5 项（`use-db-redis-instance`，无循环依赖、契约面 3 份），验证手感后再动第 4 项。

### L2 render 区（中风险，建议做 4 块）

| # | 簇 | 现状位置 | 行数 | 目标文件 | 契约跟迁 |
|---|---|---|---|---|---|
| 10 | SQL 区（编辑器工具栏 + 结果区编排 + 参数面板挂载） | 4983–5502 | 520 | `db-session-sql-area.jsx` | 8–12 份 |
| 11 | 收藏面板 + 历史面板渲染 | 4446–4982 | 537 | `db-session-side-panels.jsx` | 4–6 份 |
| 12 | 结构区（表结构 v2 + DDL + 数据字典入口） | 5503–5649 | 147 | `db-session-structure-area.jsx` | 3–4 份 |
| 13 | Redis 键空间区 | 5650–5727 | 78 | `db-session-redis-area.jsx` | 2–3 份 |

L2 小计：**约 1280 行**，owner 降到 **约 3600 行**。

### L3 明确不拆

| 块 | 行数 | 不拆理由 |
|---|---|---|
| `dataArea`（3611–4383） | 773 | 它是数据页的**编排层**，内部 60+ 处直读 owner 的 `view` / `grid` / `pageFilterKw` / `editing` / `editValue` / `canEditCell` / `selectedCell`… 拆出去要传 40+ props。**props drilling 比现状更难维护** —— 这是把「一个文件太长」换成「一个组件参数太多」，问题没解决只是换了形态 |
| `return (...)`（5757–6290） | 534 | 纯挂载点，除了 headBar 已拆的部分，剩下都是 `{dataArea}` `{sqlArea}` 这类一行挂载。拆它只是把 534 行搬到另一个文件 |
| `valuePaneEl` / `emptyPaneEl` / `refTabsEl` / `sqlOptsPop` / `workspaceHome` | 96 / 14 / 9 / 25 / 37 | 单块都太小（<100 行），单独成文件后 owner 与组件之间要维护 10+ 个包一层就用完的 props，收益为负 |

---

## 4. 每簇的执行纪律（沿用 N11a，逐条硬约束）

1. **逐字搬运**：脚本切片 + `diff` 校验（#16 已验证过这套流程：149 行 JSX 与搬迁前字节一致）。不做顺手重构、不改注释语义、不调依赖数组。
2. **注入最小化**：只注入 hook 真正消费的页面级量。纯内部符号（setter / 中间派生值 / 内部 handler）**不外泄**，否则 owner 侧解构出未使用变量，`standard` 直接报 `no-unused-vars`。
3. **TDZ 是最大陷阱**：hook 形参是**即时取值**。被注入的依赖必须先定义。本项目已经踩过两次：
   - `useDbCellEdit` / `useDbBulkEdit` 必须排在 `confirmRowWrite`（E1 闸门）之后；
   - `redisDb` 属 Redis 簇，guard hook 用 `getRedisDb: () => redisDb` 惰性取值绕过。
   **遇到「依赖在后面」时，优先用 getter 惰性化，而不是把 hook 调用点挪到文件末尾**（后者会让 hooks 顺序守卫的语义变得难读）。
4. **hooks 顺序守卫**：所有 hook 调用必须在 `if (error)`（3449）/ `if (!ready)`（3465）之前，且数量在各渲染轮次间恒定。
5. **契约跟迁只改读源，不改断言语义**：把新文件拼进组合读取源（`read(JSX) + '\n' + read(NEW)`）。只有当断言本身依赖了具体的代码排版时（如 #7 的 `readOnlyHintKey` 多行导入断言），才把断言改写成「语义等价但格式无关」的形式，并在 spec 里注明原因。
6. **死导入必须同批清掉**：代码迁出后 owner 侧的 import 变孤儿，`standard` 会报。清理前先跑一次基线对比，区分「本簇新增」与「历史遗留基线噪声」（当前基线固定为 6 条：`clearSqlHistory` / `removeSqlHistory` / `exportHistoryFile` / `readHistoryPanelSize` / `filterHistory` / `setSqlHistoryOpen`）。
7. **验证四件套**（每簇独立跑，不合并）：
   - `standard` 对比基线，确认零新增；
   - `db-*.spec.js` 全绿（当前 2217/2217）；
   - 全量 `npm run test-unit-ci`，`# fail 0`（已知 10 个 cancelled 为 `build-time injection` safe-delete 垫片噪声）；
   - `npm run compile` RC=0，并 grep 产物 chunk 确认搬走的符号真进 bundle（防「拆成 dead code」）。
8. **分点提交**：一簇一提交，代码与文档分开。行数**必须在接线完成后测量**（N11a 踩过：按抽取脚本的中间值写进文档，比接线后的真实值少 21 行）。

---

## 5. 建议执行顺序

按「收益 / 风险」从小到大：

**第一批（纯派生逻辑，无副作用，风险最低）**
`#22 use-db-grid-columns` → `#23 use-db-sql-result-columns` → `#24 use-db-tree-data`

这三块都是 `useMemo` + 纯函数，搬走后 owner 只剩「把返回值传给渲染组件」，出问题也只影响显示不影响数据。

**第二批（有副作用，但契约面小）**
`#26 use-db-redis-instance` → `#27 use-db-foreign-refs` → `#25 use-db-redis-browse`

Redis 实例视图（INFO / 慢日志 / ER 图 / 结构对比）与浏览类无交集、无循环依赖，先做它验证手感；`use-db-redis-browse` 涉及 state 与 `useDbRedisKeys` 的双向依赖，放本批最后，做完后 `useDbRedisKeys` 的 33 个注入参数应缩到 5 个以内。

**第三批（接线类）**
`#28 use-db-sql-file` → `#29 use-db-connection` → `#30 use-db-view-actions`

**第四批（render，需重新评估契约面）**
`#31 db-session-side-panels` → `#32 db-session-structure-area` → `#33 db-session-redis-area` → `#34 db-session-sql-area`

`db-session-sql-area`（520 行）放最后，因为它是 `db-sql-editor-shell.spec.js` 与 `db-sql-params-panel.spec.js` 的主要断言对象，风险最高。

---

## 6. 什么时候该停

判断标准不是行数，而是：**打开文件时，能不能一句话说出它负责什么、改一个功能是不是只改一处。**

到 3600 行左右时，剩下的会是：

- 约 2000 行：页面级 state 与 hook 编排（本身就是「会话页」的职责，无法再分）
- 约 1500 行：render 编排（`dataArea` + `return` 的挂载结构）

这两块共享同一个变更理由 —— **「数据库会话页怎么组织」**，再拆就是按行数切，不是按职责切。

**不建议做的事**（重要）：

- 不要为了行数把 24 个 Redis state 塞进一个 hook 再返回 30 个名字。那样 owner 侧会有一大片无人使用的解构，`standard` 报一串 `no-unused-vars`，可读性反而更差。**按子功能分两个 hook，各自内聚。**
- 不要拆 `dataArea`。40+ props 的组件比 773 行的内联 JSX 更难改。
- 不要在同一个提交里既搬代码又改行为。行为变更走独立提交。

---

## 7. 进度记录

基线：**6290 行**（N11a 全部收口后）。当前：**5680 行**（−610，−9.7%）。

| 簇 | 目标文件 | owner 行数 | 提交 | 验证 |
|---|---|---|---|---|
| #22 网格列定义 | `use-db-grid-columns.jsx`（407） | 6290 → 6015 | `e7a9e4b4` | 字节等价 326/326；standard 仅 6 条基线；db-* 2199/2199；全量 fail 0 / pass 5083 / cancelled 10；compile RC=0 |
| #23 SQL 结果列定义与派生视图 | `use-db-sql-result-columns.jsx`（254） | 6015 → 5851 | `a85a92b4` | 字节等价 187/187；standard 仅 6 条基线；db-* 2199/2199；全量 fail 0；compile RC=0 |
| #24 元数据树数据 | `use-db-tree-data.jsx`（233） | 5851 → 5680 | `49dc8f9b` | 字节等价 body 166/166 + 图标表 15/15；standard 仅 6 条基线；db-* 2199/2199；全量 fail 0；compile RC=0 |

### #22 落地要点（供后续簇复用）

- **三段切片**：原 2275–2399（`renderCell` + colMenu）、2415–2420（`rowColumnNames`）、2422–2614（列模型 + `columns` 装配）。中间 2400–2414 是 `useDbExport` 接线，属另一职责，**原地保留**。
- **后缀必须是 `.jsx`**：`renderCell` 返回 `<span>` / `<Tooltip>`，`vite` 对 `.js` 不启用 JSX 解析，首轮 `compile` 在 `use-db-grid-columns.js:78` 直接报 `Unexpected JSX expression`。纯逻辑 hook 才用 `.js`。
- **最小化返回值**：只回流 owner 消费的 13 个符号；`columnWidths` / `colCommentByName` / `hiddenColumnSet` / `sortOrderOf` / `openDataCellMenu` / `dataLive` 保持私有，否则 owner 侧会多出 6 条 `no-unused-vars`。
- **契约正则的隐形锚点**：`db-column-width.spec.js` 的 `colFitAllBtn` 原正则靠「非贪婪扩到后面某个 `  })`」终止，定义迁出后其后已无该锚点 → 改为按函数体自身 `\n  }\n` 收口。迁出 `useMemo`/`useCallback` 大块时先检查 spec 正则的终止锚点是否依赖后续代码。
- **hooks 顺序守卫**：`db-grid-scroll.spec.js` 的 `markers` 要换钉 owner 侧调用点 `} = useDbGridColumns({`，不能留着旧定义名，否则守卫形同虚设。

### #23 / #24 落地要点

- **同一簇里混了「该搬」与「不该搬」的边界**：#23 的 `setSqlColWidths` 被 owner 的
  「重新执行 = 新一轮列宽」用到（原 1564 行）。这里没有把裸 setter 丢出去，而是让 hook
  提供语义化出口 `resetSqlColWidths()`。判断标准：**state 归 hook，但「重置」是业务动作，
  该有名字**。副作用是契约要跟着改（原断言数 `setSqlColWidths({})` 出现次数）。
- **图标表这类「只为别人服务的模块级常量」要跟簇走**：#24 的 `DB_OBJECT_ICONS` /
  `DB_GROUP_ICONS` 只被 `treeData` 两行消费。留在 owner 时 `standard` 不会报（有引用），
  但它已经不属于 owner 的任何职责。搬走后有 3 份 spec 要跟迁。
- **组合读取源会制造假阳性**：`db-sql-value-pane` 的「只读面板不传 onSave」原来读
  owner+hook 拼接源，拼接后非贪婪正则会先命中 owner 里数据页那个带 `onSave` 的
  `<DbValuePane>`。**一旦把两个文件拼起来，任何「第一个匹配」型正则都要重新审视**。
- **不能只跑 `db-*.spec.js`**：#24 的两个失败在 `css-tokens.spec.js` 与
  `perf-guard.spec.js`（都不带 db 前缀）。每簇收尾必须跑全量，全量是唯一可信的判据。
- **整行删除 import 要连带检查契约**：`perf-guard` 直接断言 owner 里有
  `from './db-search'`。删掉死导入后该断言失败 —— 契约改成「谁引用谁负责导入」，
  并给新归属（hook）补一条同样的断言，约束不放松。
