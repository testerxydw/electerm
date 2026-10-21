# 分析：mysql/redis 登录后内存占用（实测取证 + 优化方案）

> 背景：用户反馈登录 mysql/redis 后内存偏高（任务管理器总计约 600MB），疑问是"数据量太大导致的正常消耗还是异常"。
> 2026-10-16 完成实测取证（进程对号 + 假 redis 复现），根因落地后整理本文。只含分析与方案，未实施。
> 相关：《分析-数据库页性能热点与优化方案-2026-10-15.md》（渲染垃圾/大涨大跌维度，已修复项）。

---

## 一、结论速览

1. **~600MB 总量结构上正常，无泄漏证据**：Electron 多进程基线占大头；主进程空载 RSS 即 ~379MB，与用户实例 386MB 几乎一致——主进程没有随使用异常增长。
2. **根因 A（瞬时放大，可自愈）**：redis 大键详情全量拉取时，主进程经历「RESP 解析 → ioredis 对象 → IPC 结构化克隆」三层拷贝，实测单次 **×5.5**（raw 11MB → anon +60MB），连续操作峰值叠加 ±130MB，GC 后回落。
3. **根因 B（常驻持有，受生命周期控制）**：renderer 把详情全量存入 `redisDetail` state，实测 **×2.4**（+26MB），随换键/关 tab 释放。
4. **坏点确认**：hash `hgetall` / set `smembers` **无任何上限**——"数据量太大"场景的放大器；list/zset 有 1000 上限、mysql/redis 键列表有分页，均受控。
5. **连接生命周期已审计**：常规关闭真实释放（P4，§四）；修复 1 个 open/close 竞态滞留窗口。

---

## 二、实测取证

### 2.1 进程对号（用户真实实例，运行 28 分钟；`ps` + `/proc/<pid>/status`）

| 进程 | RSS | 构成 | 说明 |
|---|---|---|---|
| 主进程 | 386MB | RssFile 205 / **RssAnon 仅 40** / Swap 17 | **db 客户端在这里**：`dbClientOp` 走 `ipcMain.handle('async')` → `lib/db-client`（ipc.js:245），mysql 池/redis 客户端/结果 JSON 都在主进程 |
| renderer | 344MB | RssAnon 200 | 终端 scrollback buffer + db 页数据 + 高亮节点 |
| server.js | 68MB | — | **不承载 db 客户端**（纠正最初假设）；纯终端会话在 session-server 子进程（95MB ×2） |
| gpu/utility/zygote | ~130MB | — | 系统组件 |

空载对照：新启动的干净实例主进程 RSS ≈ 379MB ≈ 用户实例 → 主进程无随使用增长；任务管理器 220→378 的"增长"是统计口径差异（PSS/RSS/映射），不是数据泄漏。

### 2.2 复现实验（假 redis RESP2 + CDP 驱动 `openDbTab`/`getKeyDetail`）

数据集：10 万 field × ~105B 值，raw payload ≈ 11MB。

**主进程侧**（连续 4 次 `getKeyDetail`，间隔 1.5s，按 3s 采样）：

```
baseline         rss=376MB anon=48MB
getKeyDetail#1 → anon +60MB   （≈ raw × 5.5）
#2 → +42MB  #3 → +6MB  #4 → +26MB   （峰值 anon 48 → 180MB）
settle 3×3s   → anon 回落 44MB（rss 373MB）
```

**renderer 侧**（模拟 `redisDetail` state 持有返回结果）：

```
baseline heap used=17MB → hold 后 43MB（+26MB 常驻 ≈ raw × 2.4），8s 稳定
```

### 2.3 推论

- 主进程增长 = **瞬时放大**（GC 可回收），量级 ∝ 单键数据量；用户切键浏览大 hash 时的锯齿 ±60~130MB 全部来自这里，可自愈、非泄漏。
- renderer 增长 = **常驻持有**，随 `redisDetail` 生命周期释放；加上终端 buffer 构成 renderer anon 200MB 的主体。
- 排除项（实测平稳，非根因）：主进程连接池（`connectionLimit: 4`）、server/session 子进程、渲染层高亮（已 useMemo 化，见性能热点文档）。

---

## 三、数据流与增长点核对表（代码事实）

| 数据路径 | 现状 | 放大系数（实测/估算） | 定性 |
|---|---|---|---|
| redis hash 详情 | `hgetall` 全量（redis.js:195） | ×5.5 瞬时（主进程）+ ×2.4 常驻（renderer） | 🔴 坏点 |
| redis set 详情 | `smembers` 全量（redis.js:202） | 同上量级 | 🔴 坏点 |
| redis string 详情 | `GET` 全量（展示必需） | ×5.5 瞬时 + ×2.4 常驻；高亮层已有 100KB/2000 上限 | 🟡 大值风险 |
| redis list/zset 详情 | lrange/zrange 0..1000 上限 | 受控 | ✅ |
| redis 键列表 | SCAN 游标分页（≤1000） | 受控 | ✅ |
| mysql 网格 | `LIMIT pageSize OFFSET`（≤1000，默认 100） | 每页几 MB~几十 MB | ✅ |
| mysql 连接池 | `connectionLimit: 4` keepAlive 常驻 | 固定几十 MB | ✅ 基线 |

---

## 四、优化方案（按实测根因排序，均未实施）

### P1 redis hash/set 详情服务端分页（治根因 A+B，收益最大）

- `hgetall` → `hscan(key, cursor, 'COUNT', 500)`；`smembers` → `sscan` 同理；
- server 端协议从 `{ fields, rows }` 扩展为 `{ fields, rows, cursor, hasMore }`（向后兼容：小键一次取完 cursor='0'）；
- renderer 复用现有 `detailLimit`/"load more" 交互，追加"加载下一批（游标）"；
- 同时压掉根因 A（单次 payload 变成 500 条 → 瞬时放大从 60MB 降到 ~0.3MB）和根因 B（常驻持有只有已加载批次）。

### P2 大 string 值软上限（治根因 A/B 的 string 分支）

- server 端 `GET` 后超阈值（建议 256KB）截断，返回 `truncated: true`；renderer 预览区提示"值过大已截断"；
- 编辑保存需要全量时走单独的 `getFullValue`（或编辑前二次拉取）。

### P3 `getKeyDetail` 超大键兜底

- 加 `maxFields` 保护（建议 5 万）：超出返回 `truncated: true` + 计数，renderer 提示改用 match 过滤浏览；
- 与 P1 互补：即使未来出现不支持的命令路径，也不会把主进程顶爆。

### P4 连接生命周期审计（✅ 已审计 + 修复，2026-10-16）

**审计结论：常规路径真实生效**（假 redis socket 连接计数实证）：

| 场景 | 实测 |
|---|---|
| 同 id open→close 循环 ×5 | 每轮连接 1→0，干净归零 |
| 同签名多 tab 共享 | 引用计数共享 1 条连接，最后一个 close 才断开 |
| 调用链覆盖 | delTab/关右/关其他 → `removeTabs` → `closeRemovedDb`；app 退出 → `on-close` → `closeAllDbTabs`；`openDbTab` 同 id 重开先释放 |
| 释放实现 | mysql 引用计数归零 `pool.end()` / redis `disconnect()` / postgres `end()` / `tunnel.close()` |

**发现并修复 1 个竞态滞留**（`db-client/index.js`）：

- 现象：`closeDbTab` 在 `openDbTab` 的 await 完成前到达（`instances` 无正式记录 → no-op），open 完成后连接注册成"无主"→ 滞留到 app 退出/同 id 重开。慢连接（1.5s 延迟模拟）下已复现：conns 卡在 1 不释放。
- 触发条件：慢连接/ssh 隧道（窗口最长 15s OVERALL_TIMEOUT）+ 用户秒关 tab。
- 修复：open 开始注册 pending 占位记录 aborted 标记与中间产物；`closeDbTab` 遇占位置位 aborted；`openDbTab` 在 buildConn 后 / acquire 后 / getMetadata 后分步检查，命中则释放（acquire 成功过才对称 release）并中止；`dbClientOp`/`setDbReadOnly` 对占位按"未打开"处理。修复后复测：close 后 conns 1→0，open 返回 rejected。
- 残留边界（记录不动）：renderer 崩溃时主进程感知不到（连接挂到 app 退出）；慢连接下 `dbClientOp` 在 open 完成前到达会得到 "database tab not open"（原有行为）。

### P5 观测型优化（等证据，暂不动）

- 网格 dataSource useMemo、renderCell 高亮 LRU（原《数据库页性能热点》§四.1/§四.2）——解决渲染垃圾而非稳态占用；
- 仅当用户改大 pageSize（1000 行 × 高亮）且观测到渲染卡顿时再做。

---

## 五、"正常还是异常"判定标准（给使用者的口径）

- **正常**：浏览大 hash/set 后内存上涨 → 稳定平台 → GC/切键回落（涨后平台 + 锯齿是 V8 常态）；关 tab 后回落。
- **异常**（满足任一）：①反复切键/翻页内存阶梯式上涨不回落；②关闭数据库 tab 后不释放；③空载数小时线性增长。

按此口径，当前实例属于**正常**；P1/P2/P3 实施后，大数据量场景的峰值与常驻都会降到与数据量成比例的可控范围。

---

## 六、附：取证方法备忘

- 进程对号：`ps -o pid,rss,args --sort=-rss`；构成：`/proc/<pid>/status`（RssAnon/RssFile 区分 JS 堆与映射）。
- renderer 堆：`--remote-debugging-port` + CDP `Runtime.evaluate('performance.memory')`。
- 主进程放大测量：CDP 驱动 `openDbTab`/`dbClientOp`，外部按 3s 采样 `/proc/<main>/status`。
- 并行测试实例启动坑：electerm 单实例锁是 `$TMPDIR/electerm-instance.sock`（全局固定，`create-app.js` → `handleSingleInstance`），与 `--user-data-dir` 无关 → 必须用独立 `TMPDIR` + 独立 `DATA_PATH`。
