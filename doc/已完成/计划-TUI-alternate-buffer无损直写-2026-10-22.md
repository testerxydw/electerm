# 计划：TUI alternate buffer 无损直写（TODO #7，2026-10-22）

> **状态：✅ 已完成（2026-10-22 复核归档）**——实现 + 19 单测 + 全量 1376/1376 + compile 全过；提交 `468d2c07`（直写实现）→ `1d13310a`（顺带修 i18n 既有失败），已推送 `origin/master`（rev-list 0 0）。TODO 总清单 #7 收口。CDP 真机回归（vim/htop 开关 + `cat` 大文件洪流）随下次打包进行。
>
> 来源：TODO 总文档 #7（上一会话结论："涉及深层链路改动，需单独新会话从 attach 链路分析开始实施"）。
> 关联：`./调研-xterm稳定版升级影响与路径-2026-10-20.md`（xterm 升级已降级为跟踪，本项解耦独立做）、`./分析-性能热点与优化总案-2026-10-21.md`。

## 一、问题（根因）

- 渲染错乱 issue（electerm#4499 等）的共同根源之一：TUI 应用（vim/htop/claude 等 Ink 类）在 **alternate screen** 下按"自己维护的屏幕模型"做增量重绘（`ESC[nA` 回退 + 覆写），它假设发出的每个字节都被终端处理。
- 本项目在官方直写之上加了两层优化：16ms 写合批 + 2MB 超限丢最旧数据（`attach-addon-custom.js` `_dropOldestUntil` → `truncateTerminalOutput`）。丢帧后 TUI 的下一帧仍按它的模型回退定位 → 指向从未写入的内容 → 错乱。`stripLeadingCursorOps` 只能剥掉幸存帧头部的光标序列做缓解，无法恢复增量重绘语义。
- 上游 electerm 原生即"每条 ws 消息直接 term.write（无丢弃）"；合批丢弃是本项目性能优化，代价是 normal buffer 洪流场景可丢帧（可接受），但对 alternate screen 是错误行为。

## 二、方案（流级切换检测 + alternate 直写）

在 `attach-addon-custom.js` 内实现（单文件，无新文件）：

1. **纯函数 `findAltBufferSwitch(str)`**（导出，复用 `ansiSequenceEnd` 扫描）：
   - 识别 `CSI ? 47 / 1047 / 1049 h|l`（进入/退出 alternate screen 的三种 DECSET/DECRST）；
   - 跳过 OSC/DCS 字符串体（`ansiSequenceEnd` 已处理闭合）；
   - 返回 `{ swType: 'enter'|'exit'|null, swOffset, tailStart }`：swOffset=最后一个切换序列起点；tailStart=尾部未闭合序列起点（-1=无）。
2. **状态机接线（`_enqueueWrite`）**：
   - `this._altBufferActive`：当前是否处于 alternate（初始 false）；
   - `this._pendingTail`：chunk 尾部被截断的未闭合序列暂存（cap 4096，超出直接写出），下一 chunk 前置拼接；200ms 兜底定时器超时按当前模式写出，防服务器空闲悬挂；
   - 无切换且非 alternate：走现有合批/丢弃逻辑（行为零变化）；
   - 处于 alternate：**直写** `term.write()`（跳过合批与丢弃，无损），同步触发 `notifyOnData`（自带 1s debounce）/`onTerminalWrite`；
   - 检测到切换：在 swOffset 切分——前段按旧模式走；进入 alternate 时先 flush 残留 buffer 再直写后段；退出时切换点后恢复合批。同一 chunk 内序列顺序经 term.write FIFO 天然保持。
3. **明确不做**：
   - 不用 `term.buffer.active.type` 判定（write 异步滞后，切换后首批帧会误入丢弃路径）；
   - 直写模式不加丢弃兜底（信任 xterm 内部 write 队列背压；alternate 下洪流场景罕见，错乱比卡顿更伤）；文档记录边界。
   - 不动 16ms 合批与 2MB 丢弃本身（normal buffer 行为零变化）。

## 三、影响面 / 风险

| 项 | 结论 |
|---|---|
| normal buffer 行为 | 零变化（无切换时走原逻辑） |
| 顺带收益 | 修掉 TUI 场景"丢帧→错乱"主根源（#4499 类问题在本分支的独立缓解） |
| 交互面 | taps/recorder/命令历史/密码提示检测均在 writeToTerminal 更上游（逐 chunk），不受写路径切换影响 |
| 内存边界 | alternate 直写无丢弃；若真出现极端洪流由 xterm 内部队列吸收（与上游行为一致） |
| 回滚 | 单文件 revert |

## 四、验证

1. 单测：扩展 `src/test/unit-ci/attach-addon-custom.spec.js`——切换检测纯函数（enter/exit/无/尾巴截断/OSC 跳过）、直写接线（`?1049h` 后 chunk 直写不进 buffer）、切换点切分顺序、跨 chunk 尾巴拼接翻转、尾巴 200ms 兜底写出、exit 恢复合批。
2. `npx standard` + `npm run test-unit-ci` 全量 + `npm run compile` 产物检查。
3. CDP 实测（后续打包验证）：vim/htop 打开退出、vim 内 `:!cat 大文件`（normal 洪流不受影响）、`cat` 大文件洪流（normal 丢弃路径回归）。

## 五、进度

- [x] attach 链路分析 + 方案定稿（2026-10-22）
- [x] 实现 + 单测 + 全量验证（2026-10-22）
