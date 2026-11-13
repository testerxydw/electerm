# N7 新建表 / 复制表 / 新建键 · 手动测试用例

> 功能：MySQL 页面新建表（可空白、可复制本库/外库已有表结构）、Redis 页面新建键（五类型 + TTL）。
> 架构（方案 B「双入口、单实现」）：改表 / 新建 / 复制共用同一草稿编辑 UI、同一套校验、
> 同一归一化出口与同一条「预览 → 生成脚本 → 落 SQL 编辑器」通道。复制只预填**结构**，不含数据。
> 自动化已备：unit-ci `db-create-table-key.spec.js` + `db-table-design.spec.js`（两 spec 合计 45 用例）、
> `db-workspace-home.spec.js`（伪页签 onChange 契约）、`error-copy.spec.js`（错误复制链），
> CDP 实机 `db-create-e2e-cdp-probe.js`（15 判据，op 层）+ `db-create-ui-cdp-probe.js`（42 判据，真渲染真点击）。
> 本手册覆盖自动化测不到的 UI 交互：弹层布局、输入焦点、按钮态、生成脚本进编辑器的执行链。

## 前置准备

| 项 | 值 |
|---|---|
| 被测包 | 含本轮改动的重新打包 deb（或 `npm run dev` 本地跑；改源码后须先 `npm run compile`） |
| Redis | 127.0.0.1:6379（无密码即可），另备一个带密码实例更好 |
| MySQL | 192.168.115.67:13306，user `root` / password `password` |
| 复制源 | 库 A 准备 `src_local`（含主键 + 表注释），库 B 准备 `src_ext`（含 UNIQUE KEY + 表注释） |
| 自动化备核 | `node self-test/db-create-e2e-cdp-probe.js` + `node self-test/db-create-ui-cdp-probe.js`（退出码 0 即过） |

> **实机探针隔离说明**：两个探针各自用独立 `TMPDIR`、动态 CDP 端口与 DISPLAY。
> `app/lib/single-instance.js` 的锁 socket 落在 `app.getPath('temp')`（默认 `/tmp`），
> 若本机正在跑打包版 electerm，源码探针会被判成「第二实例」静默 `app.quit()`，
> 表现为 DevTools 端口通但 `no page target`；固定端口还会误连旧页面。
> 沙箱内运行请加 `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE`。

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

### M0 入口可达性与空库（阶段 0 治本）

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 连上 MySQL 后**不打开任何表**，直接点页签栏里**紧跟「会话」**的「新建表」 | 弹层**直接打开**（旧版会弹 warning「请先打开一张表」把人挡在外面，已治本）；目标库回落连接默认库 `dbName` |
| 2 | 打开任意一张表 → 再点「新建表」 | 弹层正常打开，目标库默认=打开表所在库；无 TypeError（空草稿形状已由纯模块统一产出） |
| 3 | 下拉切到另一个库，再切回来 | 预览脚本的全限定前缀 `db.table` 双向跟随 |
| 4 | 填表名 + 预置列的列名/类型 | 预览区实时出 CREATE TABLE（只填表名不填类型时给 missing-column-type 原因，属正确行为） |
| 5 | 自动化备核 | `node self-test/db-create-ui-cdp-probe.js`（A/B/C/D 四阶段 42 判据，退出码 0 即过） |

### M1 完整建表链

入口：MySQL tab → 顶部页签栏**紧跟「会话」**的「新建表」（伪页签，点击开弹层不切页签；不依赖已选表，结构区不残留第二个入口）。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 打开设计器 | 标题「新建表」；顶部两行：目标库下拉 + 表名输入框、「复制自」下拉（默认「空白表」）；草稿预置 1 个空列；无「刷新」按钮 |
| 2 | 表名 `t_ui_users`，加列：id int NOT NULL DEFAULT 0、username varchar(64) NOT NULL 注释「用户名」、note varchar(255) 可空 | 预览区实时出 CREATE TABLE 候选脚本 |
| 3 | 检查生成脚本 | `username` 列**没有** `DEFAULT ''`（hasDefault=false 同口径）；PK/UNIQUE KEY 内联；表注释在右括号后：`) COMMENT='...'` |
| 4 | 生成 → 脚本落入 SQL 编辑器 → 执行 | 成功；information_schema 反查三列/PRIMARY/uk/表注释一致（SQL 带全限定前缀，任何库上下文执行都落对库） |
| 5 | 新表出现在结构区列表 | 刷新后可见 |

### M2 校验拒绝口径（UI 侧应有原因文案）

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 表名填 `bad name`（带空格） | 预览不出语句，给 bad-table-name 原因 |
| 2 | 表名留空 / `9t` 开头数字 | 同上拒绝 |
| 3 | 两列同名 | duplicate-column |
| 4 | 索引引用不存在的列 | index-column-missing |
| 5 | 删光所有列 | no-column |
| 6 | 列名留空 / 两列同名 / 索引没选列 | 顶部红条给草稿问题（create 与 alter 共用 `designIssues` 同一套文案，不再各写一套） |

### M3 方言与只读

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 打开 postgres/sqlite tab 看页签栏 | 无「新建表」按钮（`createTableDdl` 能力位只对 mysql 开；UI 与生成器同源，不认引擎名） |
| 2 | readOnly MySQL bookmark | 弹层仍可打开浏览设计，写入走既有只读护栏 |

### M4 复制已有表（本库 / 外库）★ 新增

前提：库 A 有 `src_local`（主键 + 表注释），库 B 有 `src_ext`（UNIQUE KEY + 表注释）。弹层打开时一次拉齐全部非系统库的 BASE TABLE 作为「复制自」候选（本库与外库同一份清单，可搜索）。

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 新建表弹层 →「复制自」选 `A.src_local` | 草稿立即预填：列 / 索引 / 表注释与源表一致；预览出 CREATE TABLE，含 `PRIMARY KEY` 与 `COMMENT='...'` |
| 2 | 看表名输入框 | 自动填 `src_local_copy`（可随手改）；目标库仍可下拉换，与源库无关 |
| 3 | 改列名 / 类型 / 默认值 / 表注释，增删列与索引 | **全部可编辑**（列名不禁用——只有「表设计」改表模式才禁改名）；预览实时跟随 |
| 4 | 执行生成的 CREATE | 只建结构，**不含任何数据行** |
| 5 | 「复制自」改选 `B.src_ext`（外库） | 已改过草稿时先弹确认「切换复制来源？…已修改的内容会丢失」；确认后草稿换成外库表的列与 UNIQUE KEY，跨库前缀由目标库决定 |
| 6 | 选回「空白表」 | 同样确认后草稿重置为 1 个空列行 |
| 7 | 复制一张带外键的表 | 外键区只读列出并提示「不会随 CREATE TABLE 生成」（设计器不编辑外键，产物里也没有 FK 约束） |

> 说明：复制走 `getTableStructure` 按库读结构（跨库天然可用），再经 `draftAsNew` 重基线清掉
> `origName/src`；生成的仍是普通 CREATE TABLE 脚本，落入 SQL 编辑器由你决定何时执行。
> 若改了源表引用的列名却没同步改索引列，预览会给 `index-column-missing` 原因（正确行为）。

## P1 回归面

| 用例 | 操作 | 预期 |
|---|---|---|
| G1 弹层滚动 | 新建键/新建表弹层在 1366x768 小窗下 | wrap 不滚、body 内滚（SSOT 约定不回退）；必要时跑 `node self-test/modal-scroll-cdp-probe.js` |
| G2 改表链（方案 B 回归） | 打开已有表 →「表设计」改一列 → 生成 ALTER | 与改动前一致；已有列名仍只读、刷新按钮与差异勾选都在；UI 探针 B 阶段已锁 |
| G2b 单流水线一致性 | 对比新建/改表模式对 `DEFAULT ''`、列注释、索引列的写法 | 完全一致（归一化只在 `draftToStructure` 一处，生成器不再判 `hasDefault`） |
| G3 结构区原功能 | 表结构/索引/DDL 各 tab 切换 | 无异常（新建表入口在页签栏，结构区不残留旧按钮） |
| G4 Redis 原功能 | 对已有 string 键查看/编辑/TTL 修改 | 无异常（新弹层不影响已有编辑链） |
| G5 错误复制 | 制造一个报错（如断网连库）→ 错误通知点复制图标 → 粘贴 | **消息 + 完整堆栈**都在剪贴板里；不再出现 `[object Object]`（2026-11-12 修复，notification/clipboard/error-modal 三处已锁） |

## 清理

```bash
redis-cli del t:s t:h t:l t:s t:z
mysql -h 192.168.115.67 -P 13306 -uroot -ppassword \
  -e "drop table if exists electerm_create_test.e2e_users; drop table if exists <your_db>.t_ui_users; \
      drop table if exists <A>.src_local; drop table if exists <B>.src_ext; \
      drop database if exists ui_probe_alt_db; drop table if exists <A>.ui_probe_local_src"
```

## 记录

每条用例结果记：通过 / 失败 + 截图（失败必须带完整报错栈）。P0 三组全过即可提交。
