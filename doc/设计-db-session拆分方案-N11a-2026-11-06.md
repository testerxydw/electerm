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
| N2-1 | 变更预览 + 变更集模型（纯函数，未接 UI） | `src/client/common/db-change-preview.js` + `src/client/common/db-change-set.js` | 仅改文案调用 |
| N2-UI（WIP 未提交） | 变更面板 UI | `src/client/components/database/use-db-changes.js` + `db-change-panel.jsx` | 进行中 |

> 注：`db-change-panel.jsx` / `use-db-changes.js` 属用户其他 WIP，本方案不触碰。

三轮接线（#1 / #14 / #15）后主文件 **8926 行**。验证：`standard` RC=0、db-* 单测 **2199/2199**、`npm run compile` RC=0（`[check-cm6-chunk] OK`，产物 `db-session-5.8.1-*.js` 含拆分模块）；实机 GUI smoke（`self-test/db-sqlite-sql-demo.js`）**未跑**。改动均未提交（N2-UI 并行任务在途）。

### 1.1 并行拆分实验结论（2026-11-06）

- **纯多 agent 并发改 `db-session.jsx` 不可行**：16 个聚类同处一文件，且当时有 N2-UI 并行任务持有该文件。采用混合模式：多 agent **并行只建新模块 + 改测试**（各写不同文件、只读主文件），由 owner **串行做主文件的删除与接线**——这是唯一无法并行的瓶颈。
- **契约测试必须跟随代码**：源码文本契约（正则抽真实函数体 / 字符串 `includes` / 出现次数）在代码迁出后必须把读取源指向新模块，或改为**组合读取全部已接线（shipped）文件**；阈值与语义不变。**绝不能把未接线的 dead 模块计入**——那是用死代码凑数。已回退 4 份"模块未接线却先改读取源"的 spec，消除"测试验证副本"的漏洞。
- **#2 / #3 / #11 三 hook 簇暂缓**：三者存在跨簇循环依赖（tree 的 `loadStructure` ↔ view 的 `refreshViewParts` / `openRefTable`；redis keys 的 `loadTree` ↔ tree 的 `loadRedisKeys`），且 `useDbTree` 的过滤 effect 依赖后置 `visibleMetadata`（useMemo），按值注入会 TDZ / 改变 effect 顺序。另有约 15 份 spec 以文本契约绑定主文件内联实现，以及 `perf-guard.spec.js:250` 的 `pageSizeOf` clamp 断言。需先做延迟绑定桥接 + 逐簇重定位契约，风险显著高于渲染簇，留待 N2-UI 并行任务收口后单独推进。
- **暂缓产物（dead duplicates，勿当作已接线）**：`use-db-tree.js` / `db-tree-panel.jsx` / `use-db-view.js` / `use-db-redis-keys.js` / `db-redis-key-space.jsx` / `db-grid-cell.jsx`。`renderCell` 经确认为网格与新组件共享，主文件内联实现保留。

## 2. 剩余拆分方案（按耦合度递增排序）

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
- 行数达 AGENTS.md §5.1 文件大小限制阈值即停手登记下一拆分步，不在本文件继续堆。
