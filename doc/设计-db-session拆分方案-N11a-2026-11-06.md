# db-session.jsx 拆分方案与进度（N11a）

> 日期：2026-11-06
> 来源：综合 [`分析-数据库功能业界对标与待完善TODO-2026-11-06.md`](./分析-数据库功能业界对标与待完善TODO-2026-11-06.md) §7 N11a / §10 与当前源码结构。
> 状态：**设计方案 + 实施进度记录**（2026-11-06 起按 SRP 分步实装，进度见 §1）。下列"目标文件"为建议落点，实施时按 AGENTS.md §5.2（编码规范·拆分纪律）小步推进。
> 目标：把单体 `db-session.jsx`（2026-11-06 实测 **9970 行**）按"行为零变更"拆成子组件 + hooks，每步跑全量单测。
> **设计原则：以单一职责（SRP）划分模块边界**——每个目标文件只承担表中"职责"列的一项；行数只作辅助信号，不作为拆分判据（见 AGENTS.md §5.1）。

## 1. 已完成的拆分（进度记录）

| 步骤 | 搬出内容 | 目标文件 | 主文件行数变化 |
|---|---|---|---|
| N11a-1 | 模块级纯常量 + 纯函数（23 常量 / 17 纯函数） | `src/client/common/db-session-const.js`（249 行） | 10228 → 10083 |
| N11a-2 | 页面内查找簇（4 state + 命中聚合 + 定位 + recount） | `src/client/components/database/use-db-page-search.js`（169 行） | 10083 → 9958 |
| N11a-3 | 导出/复制簇（grid/sql 导出 + 复制） | `src/client/components/database/use-db-export.js`（196 行） | 9958 → 9827 |
| N11a-4（并行 #1） | `DbGridTable` 网格包装（定高滚动 / 虚拟渲染） | `db-grid-table.jsx`（79 行） | 内联函数删除；`db-grid-scroll.spec.js` / `perf-guard.spec.js` 契约跟随迁移 |
| N11a-5（并行 #14） | SQL 结果区渲染 `renderSqlResults` / `renderOne` | `db-sql-results.jsx`（352 行） | 主文件 −262 行；2 处调用点改 `<DbSqlResults/>` |
| N11a-6（并行 #15） | Redis 值详情 `renderRedisDetail` / `renderRedisEditable` 等 | `db-redis-detail.jsx`（870 行） | 主文件 −777 行；1 处调用点改 `<DbRedisDetail/>` |
| N11a-7（并行 #2） | 元数据树/结构加载：`loadTree`/`onSelectTree`/`loadStructure`/`treeFilter`/`toggleSys` | `use-db-tree.js`（213 行） | 逻辑 hook 化；`getVisibleMetadata` getter 注入避免 TDZ，两个 effect 依赖数组不变 |
| N11a-8（并行 #3） | 视图/过滤/分页：`viewParts`/`applyView`/`findLastPage`/`loadPage`/`pageSizeOf` | `use-db-view.js`（454 行） | 导出纯函数 + hook；`pageSizeOf` clamp 契约随迁 `perf-guard.spec.js` |
| N11a-9（并行 #11） | Redis 键空间：`loadRedisKeys`/`loadRedisKeyTree`/批量删键/键树 | `use-db-redis-keys.js`（487 行） | 返回 20 个名字；跨簇调用走 `bridge` 延迟绑定 |
| N11a-10（接线） | 树面板 + Redis 键空间两个渲染副本真正接线 | `db-tree-panel.jsx`（79 行）+ `db-redis-key-space.jsx`（293 行） | 主文件 −236 行；`keys` 显式合成 11 个 hook 返回值 + 7 个 owner state，保留 `const redisArea =` 锚点；7 份契约改组合读取 |
| N11a-11（#6） | F2 手动事务：轮询 tick + 自动回滚提示 + 6 个 handler | `use-db-transaction.js`（118 行） | 主文件 −53 行；state/ref 留 owner 注入，2 个 useEffect 依赖数组不变；契约零改动 |
| N2-1 | 变更预览 + 变更集模型（纯函数，未接 UI） | `src/client/common/db-change-preview.js` + `src/client/common/db-change-set.js` | 仅改文案调用 |
| N2-UI（并行 WIP） | 变更面板 UI | `src/client/components/database/use-db-changes.js` + `db-change-panel.jsx` | 非本方案实现；因主文件已 import，依赖链随第二点提交纳入以保证可构建 |

> 注：`db-change-panel.jsx` / `use-db-changes.js` 属用户其他 WIP，本方案不改动其实现，仅随提交纳入依赖链。

**进度**：三轮渲染接线（#1 / #14 / #15）后 **8926 行**；三 hook 簇（#2 / #3 / #11）接线后 **8142 行**；两个渲染副本接线后 **7906 行**；#6 事务簇拆出后 **7853 行**（相对 9970 行基线 −2117 行）。主文件内联定义残留 0，N2-UI markers（`useDbChanges` / `DbChangePanel`）保持存活。

**验证（三 hook 收口）**：`standard` RC=0；db-* 单测 **2199/2199**；全量 `npm run test-unit-ci` **5092/5092 / fail 0**（其中 `not ok 1034 - build-time injection` 为 `node-safe-delete-shim.cjs` 对 `node_modules` 目录 trash 的 `EISDIR` 噪声）；`npm run compile` RC=0（`done build in 402.417 s`、`[check-cm6-chunk] OK`、产物 `db-session-5.8.1-DecjfU0G.js` 344.27 kB）。另用 VM 实跑对比新版 `pageSizeOf` 与 `ccf04edb` 旧内联实现：函数体逐行一致、14 组输入输出 0 差异。实机 GUI smoke（`self-test/db-sqlite-sql-demo.js`）**未跑**。

**验证（接线批次）**：`standard` RC=0；db-* 单测 **2199/2199**；全量 `npm run test-unit-ci` **fail 0**（`not ok 1034 - build-time injection` 为 `widget-protocol.spec.js` 的 safe-delete 垫片 EISDIR 噪声，10 个子测试 cancelled）；`npm run compile` RC=0（`done build in 347.799 s`、`[check-cm6-chunk] OK`、产物 `db-session-5.8.1-D4znyuNp.js` 345.97 kB）。产物 grep 确认含 `db-redis-sel-clear` / `dbFilterNodes`，证明两个渲染组件真进 bundle 而非 dead。接线期间修过两处真实回归：10 个 `redisApi` 解构名变孤儿（改为 `keys` 显式列出 18 个名字）、`i18n-coverage.spec.js` 把新模块注释里的 `>中文<` 误判为直写中文 JSX 文本节点（改注释措辞）。实机 GUI smoke（`self-test/db-sqlite-sql-demo.js`）**未跑**。

**验证（#6 收口）**：`standard` RC=0；db-* 单测 **2199/2199**；全量 `npm run test-unit-ci` **fail 0**；`npm run compile` RC=0（`done build in 310.35 s`、产物 `db-session-5.8.1-6oWehl1v.js` 346.40 kB、`db-sql-editor-5.8.1-Cv0HViK9.js` 384.07 kB 独立、主入口 CM6 特征串计数 0 → chunk 边界保持）。实机 GUI smoke 未跑。

**提交**：分五点固化 —— ① `be269e52` 本文档 + 并行实验结论；② `ccf04edb` #1/#14/#15 三组件 + 契约迁移 + N2-UI 依赖链；③ `7b0e291f` #2/#3/#11 三 hook + 14 份契约迁移 + 文档进度同步；④ `9fefc08a` 接线树面板 / Redis 键空间两个渲染组件 + 7 份契约迁移；⑤ 本次提交 #6 事务 hook + 文档进度同步。均未 push。

### 1.1 并行拆分实验结论（2026-11-06）

- **纯多 agent 并发改 `db-session.jsx` 不可行**：16 个聚类同处一文件，且当时有 N2-UI 并行任务持有该文件。采用混合模式：多 agent **并行只建新模块 + 改测试**（各写不同文件、只读主文件），由 owner **串行做主文件的删除与接线**——这是唯一无法并行的瓶颈。
- **契约测试必须跟随代码**：源码文本契约（正则抽真实函数体 / 字符串 `includes` / 出现次数）在代码迁出后必须把读取源指向新模块，或改为**组合读取全部已接线（shipped）文件**；阈值与语义不变。**绝不能把未接线的 dead 模块计入**——那是用死代码凑数。已回退 4 份"模块未接线却先改读取源"的 spec，消除"测试验证副本"的漏洞；三 hook 收口时 14 份 spec 统一改为组合读取 shipped 文件，正则 / 阈值 / 出现次数一个未放宽。
- **#2 / #3 / #11 三 hook 簇已接线（同日单独推进）**：跨簇循环依赖（tree 的 `loadStructure` ↔ view 的 `refreshViewParts` / `openRefTable`；redis keys 的 `loadTree` ↔ tree 的 `loadRedisKeys`）用 `const bridge = {}` + 惰性箭头 `(...a) => bridge.fn(...a)` + `Object.assign(bridge, treeApi, viewApi, redisApi)` 在调用期解析；后置依赖（`visibleMetadata`、`showObjectDdl`、`openTable`、`confirmRedisWrite`、`selectRedisKey`）一律 lazy 注入，`useDbTree` 改 `getVisibleMetadata()` getter 形态且两个 effect 依赖数组保持 `[treeFilterKw, metadata, isRedis]` / `[treeFilterKw]` 不变。契约侧 `db-page-tree-filter.spec.js` 的 VM 沙箱注入同名 getter、`perf-guard.spec.js` 的 `pageSizeOf` clamp 读取源加入 `use-db-view.js`。
- **dead duplicates 已收敛到 1 个**：树面板 / Redis 键空间两个渲染副本已在 N11a-10 接线成 shipped 模块。当前仅剩 `db-grid-cell.jsx`，且经复核**不建议接线**——`renderCell` 全项目仅定义 1 次，以单实例 prop 共享给 `buildGridColumns` / `DbRedisDetail` / `DbSqlResults`，接线零 dedup 收益；若让 3 个 shipped 组件各自 `import makeRenderCell` 会造出多实例、破坏 4 个列 memo 的同一引用（非行为零变更）。该文件未提交、不计入任何契约白名单。
- **接线后条件项必须同批落地**：6 份必改 spec 的读源追加、4 个孤儿导入清理、`i18n-coverage.spec.js` 的中文 JSX 文本节点扫描（新模块注释不得出现 `>中文<` 形态）都是「接线后才触发」的动作项，必须与接线放在同一次变更里；先改读源会让测试验证 dead 模块，违反铁律。
- **#6 事务簇为何最安全**：1344–1443 是 100 行连续块，外部依赖（`onOpError` / `loadWithCount` / `tabId` / `sel` / `grid`）全部前置、无跨簇循环调用、无渲染期后置实参；唯一读主文件的契约 `db-sql-file.spec.js:116`（`!txSupported && !sqlFileDirty`）命中的是 1483 行关闭守卫 effect（三职责合一，不搬），且 `txSupported` 拆后仍由 owner 持有同名变量 → 契约零改动。实测独立性排序：#6 > #10（仅登记段）> #12 > #8 > #5 > #13 > #9 > #4 > #7 > #16。

## 2. 剩余拆分方案（按耦合度递增排序）

> 进度注：#1 / #14 / #15、#2 / #3 / #11、两个渲染副本接线、#6 事务簇均已于 2026-11-06 实装（见 §1 N11a-4~11 与 §1.1）。下表保留原设计边界，供后续簇参照；未接线者仍按耦合度顺序推进。其中 #13 实为依赖 6+ 簇的聚合消费者且持有全局 `mainTab`、#10 仅登记段独立 —— 原表「独立」标注与实测有偏差。

聚类的当前位置以源码 `// ----` 分段标记 + 函数名为锚（行号会随抽取漂移，故以标记为准）：

| # | 聚类（标记/函数） | 目标文件 | 职责 | 边界 / 依赖 |
|---|---|---|---|---|
| 1 | `DbGridTable` 组件（line 288，79 行） | `db-grid-table.jsx` | 纯展示网格表格 | 注入 `structureV2Ref`/`grid`/`visibleColumnNames`；最独立，最先搬 |
| 2 | 元数据树/结构加载：`loadTree`/`onSelectTree`/`loadStructure`/`treeFilter`/系统库切换 | `use-db-tree.js`（逻辑）+ `db-tree-panel.jsx`（渲染） | 树加载、节点选择、结构拉取 | 注入 `bodyRef`、调后端 op、`viewRef` |
| 3 | 视图/过滤：`viewParts`/`applyView`/`scheduleViewSave`/`restoreView`/`onViewChange`/`findLastPage`/`loadPage` | `use-db-view.js` | 视图构建、保存、分页定位 | 依赖 `structureV2Ref`/`dialect`/主进程 `saveView` |
| 4 | 单元格编辑：`startEdit`/`runCellUpdate`/`submitEdit`/`rowSelection` + B3-2 批量改值 / B3-3 查找替换 | `use-db-cell-edit.js` | 网格内编辑与批量改值 | 协 `db-change-set.js`；暂存模式走 staged；依赖 `pkColumn`/`confirmRowWrite`/`useDbChanges` |
| 5 | 行插入：`openInsertModal`/`insertPayload`/`canSubmitInsert` | `use-db-insert.js`（或并入 #4） | 插入表单状态 | 依赖 `buildInsertFormColumns`（已抽 const） |
| 6 | F2 手动事务：`beginTx`/`commitTx`/`rollbackTx`/`setManualTx` + tx tick | `use-db-transaction.js` | 连接级事务开关与清单 | 依赖 `txState`/`runGlobalAsync` |
| 7 | E1 危险 SQL / 执行闸门：`guardRef`/`riskResolveRef`/`isProduction`/`connKey`/`onOpError`/确认接线 | `use-db-guard.js` | 写操作风险分级与执行护栏 | 复用 `confirmSqlRisk` + 生产判定；与 #4/#6 共用于执行入口 |
| 8 | SQL 历史（S3-C） | `use-db-sql-history.js` | 执行历史读写 | 主进程环形存储 |
| 9 | SQL 收藏（B 批：分组/导出/一键/AI 联动） | `use-db-sql-favorite.js` | 收藏管理 | 协 `common/db-sql-favorite.js` |
| 10 | AI 注册 + 生成/修复弹层 | `use-db-ai-register.js`（小）+ 已分离 `db-sql-ai-dialog.jsx` | AI 接线 | 已大半独立 |
| 11 | Redis 键空间：`scanKeysToPage`/批量删键/键树 | `use-db-redis-keys.js` + `db-redis-key-space.jsx` | Redis 键浏览与批量操作 | 依赖 `common/db-redis-*` |
| 12 | EXPLAIN（D 批）/ Redis 类型化写（D 批） | 编排 handler → `use-db-explain.js` / `use-db-redis-write.js` | 执行计划、类型化写 UI | 核心已分离（`db-explain-tree.jsx`/`common/db-redis-write.js`） |
| 13 | 命令面板（E2-3b） | `db-command-palette.jsx` | Ctrl/Cmd+K 四类来源 | 独立 |
| 14 | 结果区渲染：`renderCell`/`renderSqlResults`/`renderOne`/`renderPageSizeSelect`/`renderPageTags` | `db-sql-results.jsx`（+ `db-grid-cell.jsx` 若 `renderCell` 复用） | SQL 结果工作台渲染 | 依赖 `fields`/`visibleColumnNames`/`grid` |
| 15 | Redis 详情：`renderRedisDetail`/`renderRedisEditable`/`renderMoreBtn`/`renderScanMore` | `db-redis-detail.jsx` | Redis 值详情编辑 | 依赖 `redisDetail`/`common/db-redis-*` |
| 16 | 布局骨架：`headBar`/`dataArea`/`db-tree-panel` 容器/空态 HOME | `db-session-headbar.jsx` / `db-session-dataarea.jsx`（HOME 已有 `db-workspace-home.jsx`） | 顶层布局组合 | 最后做，依赖全部子组件就位 |

## 3. 拆分纪律（行为零变更，沿用 §10 已验证）

- **每步不可夹带功能改动**；搬完跑 `node --experimental-detect-module --test src/test/unit-ci/*.spec.js` 全量 + 一次 `self-test/db-sqlite-sql-demo.js` 实机页面 + `npm run compile`（压住 `[check-cm6-chunk]`）。
- **契约测试约束**：源码契约测试用行首正则抽真实函数体求值（如 `^const isLeafNode =`），抽出的函数必须保持 `const NAME = ...` 顶层形式与原缩进层级，否则抽不到。
- **`window.translate` 在模块内即时调用**（不加载时取值），否则切语言后文案钉死。
- **句柄归属**：页面级 ref/状态由 owner 注入 hook，hook 不自建、不回流（见 AGENTS.md §5.2 边界与句柄归属）。
- **调用点位置**：依赖渲染期实参（如 `visibleColumnNames`）的 hook，调用点必须落在其实参定义之后，否则 TDZ 白屏——源码留注释说明为何不能前移。
- 判据是职责是否单一（AGENTS.md §5.1），行数只作坏味道信号：一旦出现第二职责就登记下一拆分步，不在本文件继续堆；不设"必须拆分"的行数硬门禁。
