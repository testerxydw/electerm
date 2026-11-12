# N7 新建表 / 新建键 · 手动测试用例

> 功能：MySQL 页面新建表（设计器 create 模式 + createTableDdl）、Redis 页面新建键（五类型 + TTL）。
> 自动化已备：unit-ci `db-create-table-key.spec.js`（13 用例）+ CDP 实机探针 `self-test/db-create-e2e-cdp-probe.js`（15/15 PASS）。
> 本手册覆盖自动化测不到的 UI 交互：弹层布局、输入焦点、按钮态、生成脚本进编辑器的执行链。

## 前置准备

| 项 | 值 |
|---|---|
| 被测包 | 含 N7 改动的重新打包 deb（或 `npm run dev` 本地跑） |
| Redis | 127.0.0.1:6379（无密码即可），另备一个带密码实例更好 |
| MySQL | 192.168.115.67:13306，user `root` / password `password` |
| 自动化备核 | `node self-test/db-create-e2e-cdp-probe.js`（退出码 0 即过） |

## P0 Redis 新建键

### R1 五类型逐个建键

入口：连接 Redis → keyspace 视图 → 工具条「新建键」按钮（刷新按钮左侧）。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 未选 db（redisDb<0）时看按钮 | 置灰（Tooltip 说明需先选 db） |
| 2 | 选 db0 → 打开弹层 → 类型选 string，键名 `t:s`，值 `hello`，TTL 60 → 保存 | 弹层关闭，列表出现 `t:s`，redis-cli `type t:s` = string、`ttl` ≤ 60 |
| 3 | 类型 hash，值两行 `f1=v=1` / `f2 = v2` → 保存 | `hgetall`：f1→`v=1`（含等号完整保留）、f2→` v2`（首个 = 分隔，等号后空格保留） |
| 4 | 类型 list，值三行 a/b/c → 保存 | `lrange 0 -1` = a,b,c（RPUSH 保序） |
| 5 | 类型 set，值两行 m1/m2 → 保存 | `smembers` = m1,m2 |
| 6 | 类型 zset，值 `90 alice` / `-1.5 bob` → 保存 | `zrange WITHSCORES`：bob -1.5 在 alice 90 前（负数 score 正确） |
| 7 | 值 TextArea 的 placeholder | 随类型切换（hash 提示 `field=value`、zset 提示 `score member`） |

### R2 校验与错误口径

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 键名留空 → 保存 | 报错 Alert（机器码 dbRedisCreateKeyNeedName 对应文案），弹层不关 |
| 2 | hash 值填一行无 `=` 的文本 → 保存 | 报错（HashBad），不产生半截键 |
| 3 | zset 值填 `abc x`（score 非数字）→ 保存 | 报错（ZsetBad） |
| 4 | 保存过程中尝试点关闭/Esc | saving 期间弹层不可关（防重复提交） |

### R3 只读护栏

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | readOnly bookmark 打开 keyspace | 「新建键」按钮置灰，Tooltip 给只读说明 |
| 2 | （备核）CDP 对只读 tab 直调 setKey | 被写护栏拒绝（探针已锁） |

## P0 MySQL 新建表

### M1 完整建表链

入口：MySQL tab → 结构区顶部「新建表」按钮（常驻，不依赖已选表）。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 打开设计器 | 标题为「新建表」，顶部有表名输入框，草稿预置 1 个空列，无「刷新」按钮 |
| 2 | 表名 `t_ui_users`，加列：id int NOT NULL DEFAULT 0、username varchar(64) NOT NULL 注释「用户名」、note varchar(255) 可空 | 预览区实时出 CREATE TABLE 候选脚本 |
| 3 | 检查生成脚本 | `username` 列**没有** `DEFAULT ''`（hasDefault=false 同口径）；PK/UNIQUE KEY 内联；表注释在右括号后：`) COMMENT='...'` |
| 4 | 生成 → 脚本落入 SQL 编辑器 → 执行 | 成功；information_schema 反查三列/PRIMARY/uk/表注释一致 |
| 5 | 新表出现在结构区列表 | 刷新后可见 |

### M2 校验拒绝口径（UI 侧应有原因文案）

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 表名填 `bad name`（带空格） | 预览不出语句，给 bad-table-name 原因 |
| 2 | 表名留空 / `9t` 开头数字 | 同上拒绝 |
| 3 | 两列同名 | duplicate-column |
| 4 | 索引引用不存在的列 | index-column-missing |
| 5 | 删光所有列 | no-column |

### M3 方言与只读

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 打开 postgres/sqlite tab 看结构区 | 无「新建表」按钮（canCreateTable 只对 mysql 开） |
| 2 | readOnly MySQL bookmark | 「新建表」不可用（走既有只读通道） |

## P1 回归面

| 用例 | 操作 | 预期 |
|---|---|---|
| G1 弹层滚动 | 新建键/新建表弹层在 1366x768 小窗下 | wrap 不滚、body 内滚（SSOT 约定不回退）；必要时跑 `node self-test/modal-scroll-cdp-probe.js` |
| G2 旧改表链 | 打开已有表进设计器改一列 → 生成 ALTER | 与改动前行为一致（createMode 只在新建入口生效） |
| G3 结构区原功能 | 表结构/索引/DDL 各 tab 切换 | 无异常（工具行是新增常驻行，不应挤压原布局） |
| G4 Redis 原功能 | 对已有 string 键查看/编辑/TTL 修改 | 无异常（新弹层不影响已有编辑链） |

## 清理

```bash
redis-cli del t:s t:h t:l t:s t:z
mysql -h 192.168.115.67 -P 13306 -uroot -ppassword \
  -e "drop table if exists electerm_create_test.e2e_users; drop table if exists <your_db>.t_ui_users"
```

## 记录

每条用例结果记：通过 / 失败 + 截图（失败必须带完整报错栈）。P0 三组全过即可提交。
