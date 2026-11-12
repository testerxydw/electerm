# db-import 修复 · 手动测试用例（打包版 /opt/electerm）

> 适用版本：含两批修复的重新打包 deb（openFile dialog 上移主进程 + 子进程数据目录三级兜底）。
> 自动化三层已备（unit-ci 功能/契约 + CDP 实机探针），本手册覆盖自动化测不到的 UI 与真实桌面交互。

## 前置准备

| 项 | 值 |
|---|---|
| 被测包 | `npm run b && npm run bdebfast` 产物，安装到 /opt/electerm |
| 测试库 | MySQL 192.168.115.67:13306，user `root` / password `password`（mysql.png 配置） |
| 测试文件 | 准备 5 个：`a.csv`、`a.tsv`、`a.jsonl`、`a.xlsx`（2 sheet）、`a.sql`（10 条 INSERT） |
| 数据目录 | `~/.config/electerm`（Linux 打包版） |
| 归档目录 | `~/.config/electerm/lossless_output` |
| 自动化备核 | `node self-test/db-import-cdp-probe.js`（需真库可达，退出码 0 即过） |

## P0 核心修复（本次炸点）

### T1 选文件不再报错

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 新建 MySQL bookmark（115.67:13306）→ 连接 → 打开数据库 tab | 连接成功 |
| 2 | 点导入 → 点「选择文件」 | **弹出系统文件选择对话框**；不再报 `Cannot find module 'electron'` |
| 3 | 选 `a.csv` | 预览正确：格式 csv、列名/样例行与文件一致 |
| 4 | 映射 → 执行（append） | 任务完成，committedRows 与文件行数一致 |
| 5 | 用 mysql2/命令行反查 | 表内数据逐行一致 |

### T2 取消选择（dialog 上移后的取消口径）

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 导入向导 → 「选择文件」→ 对话框里点取消 / 按 Esc | 不报错，返回 `{filePath:null}`，向导停留在选择步骤 |
| 2 | 取消后立刻再点「选择文件」 | 对话框能再次正常弹出（无状态残留） |

### T3 overwrite/upsert 危险模式确认链

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 对 T1 已导入的表重跑导入，模式选 overwrite | 弹危险操作确认框 |
| 2 | 确认后执行 | 旧数据被替换，committedRows 正确，无残留旧行 |

## P1 格式矩阵（T4）

对每种格式走完整导入并反查，全部走「选择文件」入口（确认 dialog → preview → start 全链）：

| 格式 | 关键检查点 | 预期 |
|---|---|---|
| csv | 含引号/逗号转义的字段 | 解析与文件一致 |
| tsv | 制表符定界 | 列识别正确 |
| jsonl/ndjson | 对象行 shape | 列为各 key 的并集 |
| xlsx | 2 个 sheet | 多 sheet 信息可见，切 sheet 后重预览正确 |
| sql 脚本 | 10 条 INSERT，选目标库 | 全部执行，affectedRows 汇总正确 |

## P2 数据目录修复（第二批，无 UI 报错、靠落位检查）

### T5 无损归档落位（最严重修复项）

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 打开终端 tab，执行 `seq 1 100000` 或 `dmesg` 等大量输出 | 正常渲染 |
| 2 | `ls ~/.config/electerm/lossless_output/` | 有 `lossless-<pid>-*.bin` 分片，**不在 /tmp/electerm 下** |
| 3 | 关闭会话 → 重启应用 → 检查目录 | 分片仍在（/tmp 版重启即丢） |
| 4 | `ls /tmp/electerm 2>/dev/null` | 不应出现（若出现说明兜底链失效） |

### T6 widget 数据目录落位

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 安装/启用一个带图标的 widget（触发图标下载） | 图标落在 `~/.config/electerm/widgets/` 下，非 /tmp |
| 2 | 设置 → Widgets → 运行实例 → 看 log/conn 流 | `~/.config/electerm/widget_logs/<id>.log` 有内容，非 /tmp |

### T7 双层目录排查（历史脏数据，一次性）

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | `ls ~/.config/electerm/electerm 2>/dev/null` | 若存在旧的双层目录，属历史遗留，可确认无数据后手工清理 |

## P3 回归面

| 用例 | 操作 | 预期 |
|---|---|---|
| T8 导出 | 同一连接走导出向导选保存路径 | 正常（导出与导入同在子进程，确认未被本次改动波及） |
| T9 弹层滚动 | 导入向导在 1366x768 小窗下滚动 | wrap 不滚、body 内滚（SSOT 约定不回退） |
| T10 Esc 键 | 导入向导打开时按 Esc | 一级生效（capture 阶段修复不回退） |
| T11 只读 tab | bookmark 保持默认（未显式 readOnly:false）→ 执行 DDL | 被只读白名单拒绝（默认护栏行为不变） |

## 清理

```bash
mysql -h 192.168.115.67 -P 13306 -uroot -ppassword \
  -e "drop database if exists electerm_import_test"
rm -f /tmp/a.{csv,tsv,jsonl,xlsx,sql}   # 测试文件按实际路径清理
```

## 记录

每条用例结果记：通过 / 失败 + 截图（失败必须带完整报错栈）。P0 三条全过即可提交（改动尚未 commit）。
