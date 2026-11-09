# db-batch3 CDP 实机三维度验证报告（2026-11-09）

> 对象：今天第三批数据库提交（ddd241df N5a 控制台 / 9692eeaf N5b 大 Key / 3ba91309 N5c Profiler）。
> 方法：CDP（Chrome DevTools Protocol）实机探针——真 Electron + 真 ioredis + fake-redis（RESP2 假服务器，支持 MONITOR 广播与 MEMORY USAGE）。
> 产物：`self-test/db-batch3-cdp-report.json`、截图 `self-test/2026-11-09-batch3-shots/`、探针 `self-test/db-batch3-cdp-probe.js`。
> 最终轮结果：**checks 19/19 PASS，findings 7/7 PASS**。

## 一、结论总览

| 维度 | N5a 控制台 | N5b 大 Key | N5c Profiler |
|---|---|---|---|
| 功能 | PASS | PASS | PASS |
| 性能 | PASS | PASS（293ms 全库扫描） | PASS（100 cmd/s 持续流） |
| 资源消耗 | PASS（历史封顶 50） | PASS | PASS（DOM 恒定、堆零增长、关弹层即回收） |

**回答用户最初的疑问：这批修改没有引入内存泄漏**——但 CDP 实机验证过程中抓出 4 个真实 bug（其中 2 个正是内存问题），已全部修复并回归。

## 二、功能维度

- **N5a**：55 条读命令全部执行成功，最后一条 GET 回值正确（`value:054`）；打开弹层即拉取命令表（COMMAND 到达服务端）。
- **N5b**：全库扫描出 TOP-N=89 行、按 size 降序；TOP1 正确命中 2000 字段大 hash（`probe:big:hash`，267844 字节，走 MEMORY USAGE 路径）；25 条夹具大键全部在结果里。
- **N5c**：~100 命令/秒持续流 20s，渲染侧 dataSource 线性增长（485→2235，与命令量同量级）；暂停后水位严格冻结（p1=2335 → resume 涨到 2435 → 再暂停 2s p3=2435 === p2）；stop 后回到 Start、pull 定时器被清。

## 三、性能维度

- N5b 全库大 Key 扫描 **283–317ms**（含 24 string + 2000 字段 hash + 全库 SCAN/TYPE/TTL/MEMORY）。
- N5c 流式 100 cmd/s 下每 5s 采样：TaskDuration 1.1–2.4s、LayoutCount 29–49（均为常规值，无布局爆炸）；主进程环形缓冲（PROFILER_RING_MAX=1000）守恒（直拉 buffer 恒 1000 行窗口）。

## 四、资源消耗维度（修复前 vs 修复后）

N5c Profiler 是唯一有内存风险的路径，实测对比：

| 指标 | 修复前（bug 状态实测） | 修复后 |
|---|---|---|
| 渲染侧行数 | 8720 条命令被累计成 **45381 行**（重复 concat） | 2236 行（与命令量 1:1，上限 5000） |
| DOM 节点 | **17.5 万**（整表渲染） | 恒 **3564**（virtual 表只渲染可视区 11 行） |
| 渲染堆 | **+702MB**（185→887MB，20s 流） | **+1.3MB**（32.5→33.8MB，20s 流） |
| 关弹层 | 不回收 | DOM 3566→3542、堆 -3.7MB，即时回收 |
| 关页签 | — | 25.1MB vs baseline 18.9MB（+6.2MB 常规残差） |

N5a：55 条命令后历史封顶 50（HISTORY_MAX，不发一条涨一条）。N5b：结果一次性渲染 89 行，无驻留。

## 五、CDP 抓出的 4 个真实 bug（均已修复）

1. **N5c ioredis monitor API 误用**（`src/app/lib/db-client/redis.js`）：原 `monitor(cb)` 把 Promise 回调当事件监听器，永远只收到一次 `'[object Object]'`。改为 `monitor().then(inst => inst.on('monitor', ...))`。
2. **N5b 大 Key 按钮永远无反应**（`src/client/components/database/db-redis-key-space.jsx`）：`typeof tabId !== 'number'` 恒真（tab.id 是 nanoid 字符串），静默 return。guard 改为 `!tabId || redisDb < 0`。
3. **N5c IPC 转发签名错位**（`redis.js` getRedisProfilerData/toggle/stop 三函数）：转发层统一 `adapter[method](conn, args)`，三函数却是 `(handleId, ...)` → `profilers.get` 永远 miss → pull 恒 `stopped:true`。签名改为 `(conn, { handleId, ... })`，并新增转发协议契约回归测试。
4. **渲染侧 lastSeq 闭包过期 + 无上限累计**（`db-redis-key-space.jsx`）：setInterval 闭包捕获恒 -1 的 state → 每次 pull 全量拉取并 concat 重复累计（即修复前 +702MB 的根源）。改为 `profilerLastSeqRef`（pull 读 ref、updater 写 ref）+ `capRows`（REDIS_PROFILER_VIEW_MAX=5000，超出丢最老）+ 两个 Profiler Table 加 `virtual` + text 列 ellipsis。

## 六、测试分层

- 全量单测 5496 通过（`node --experimental-detect-module`，nvm v22.23.2）。
- 契约测试 `src/test/unit-ci/redis-bigkeys-profiler.spec.js` 11/11（含新增"(conn, args) 转发协议一致性"回归）。
- 修复代码已编译同步到 work/app（vite build + `node src/build/bin/prepare`），探针跑的是修复后二进制。

## 七、覆盖范围说明

- **已实机 CDP**：N5a / N5b / N5c（真 Electron 页面 + 真 IPC + 真 monitor 流）。
- **未做 CDP 实机**：N6 引擎级会话只读、N7 EXPLAIN ANALYZE、N10a 语义层数据词典——三者面向 MySQL/PG，本机无实例；已有单测/契约层覆盖。如需实机验证需先备 MySQL/PG 环境。
- 探针判定备注：antd virtual 表可视区只渲染头部 12 行，DOM 读不到尾部——功能判定用 React fiber 直读 `dataSource`（中间三轮 FAIL 均为探针视口假象，已在探针内注释留痕，非产品问题）。

## 八、遗留

- 修复代码未 commit（遵守"不主动提交"，等用户指示）。
