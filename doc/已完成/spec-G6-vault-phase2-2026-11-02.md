# Spec · G6 阶段②：书签凭据迁入 Vault + 锁定后禁连

> 上游设计：[`设计-数据库阶段4-增量批次-2026-10-23.md`](../设计-数据库阶段4-增量批次-2026-10-23.md) §14.7（1102-1121 行）
> 阶段①记录：[`TODO-功能补齐与UI美化-2026-10-28--已完成.md`](./TODO-功能补齐与UI美化-2026-10-28--已完成.md) G6 段（545-558 行）
> 本文是**待用户确认**的实施规格。确认后才改业务代码。
> ✅ **2026-11-03 归档**：已确认并按本文实施完毕（`fc1e71b2…8f59e12d`，见同目录 [`tasks-G6-vault-phase2-2026-11-02--已完成.md`](./tasks-G6-vault-phase2-2026-11-02--已完成.md)），§7 待确认四条按"建议"默认接受。

---

## 1. 目标与验收

| # | 目标 | 验收判据 |
|---|------|----------|
| 1 | 新写入的书签/配置凭据用 DEK 封存，明文不再落库 | 启用保险库后新建或编辑含密码的书签，`electerm.db` 对应行只有 `_vault` 封套，无 `password`/`privateKey`/`passphrase`/`certificate`/`dbPassword`/`proxyPassword` 明文 |
| 2 | 存量凭据可迁移，迁移中断可继续 | 迁移分批执行；中途杀进程重启后，旧格式行照样能连接；再次迁移只处理剩余行 |
| 3 | 锁定后新建连接被拦并提示解锁 | 点书签 → 弹现有解锁窗；解锁成功自动继续连接；取消不建 tab、只提示 |
| 4 | 已打开会话不受锁定影响 | 锁定时已有 tab 的终端/SFTP/DB 不断开，内存中的连接参数不变 |
| 5 | 停用保险库不丢凭据 | 停用前先把 `_vault` 反解回旧格式；锁定态停用被拒绝并提示先解锁 |
| 6 | 新旧格式并存可读 | 混合状态下（部分行 `_vault`、部分行明文）全部能正常连接 |

---

## 2. 拍板项（默认按"建议"执行）

| # | 事项 | 建议 | 备注 |
|---|------|------|------|
| D1 | 敏感字段范围 | `password`、`privateKey`、`passphrase`、`certificate`、`dbPassword`、`proxyPassword`；`connectionHoppings[]` 内同名 4 项；`profiles` 表同名 4 项 | `addressBookmarks`、`quickCommands`、同步/导出不在本阶段 |
| D2 | 存储形态 | 每行一个封套：`_vault = { v: 1, data: "vlt1:…" }`，`data` 是上述字段 JSON 的 GCM 密文 | 不逐字段多封套，避免字段数膨胀 |
| D3 | 冷启动锁定态 | 书签对象**不含明文**，只留 `_vault`；连接时按 id 单独取回（`revealBookmark`） | 不整表重读，避免 watch 基线抖动 |
| D4 | 拦截点 | 只拦 `onSelectBookmark`（书签树/分组/工作区/MCP 全部经此） | 历史 tab、已打开 tab 不拦 |
| D5 | 迁移方式 | 前向分批（每批 50 行）+ `vault.migrating` 标记；**不做回滚写回** | 中断安全靠"双格式可读"，比回滚更稳；设计原文的"回滚旧格式"改为"兼容读 + 续跑" |
| D6 | 停用顺序 | 先 `unsealAll`（需已解锁）→ 再删 `vault.json` | 锁定态返回 `vault-locked` |
| D7 | `legacyWrite` | 设置页开关，默认关；打开后新写入回旧路径，已有 `_vault` 原样保留 | 对应设计 §14.7 的回滚开关 |
| D8 | 锁定态编辑 | 允许改非敏感字段；提交里没有敏感字段时保留原 `_vault`；若提交里带明文敏感字段而库锁定 → 拒绝并提示先解锁 | 表单给一行提示（见 §4.3） |

---

## 3. 主进程设计

### 3.1 新文件 `src/app/lib/vault-secrets.js`（纯模块，无 electron）

```
SECRET_KEYS = ['password','privateKey','passphrase','certificate','dbPassword','proxyPassword']
SECRET_TABLES = new Set(['bookmarks','profiles'])
HOPPING_SECRET_KEYS = ['password','privateKey','passphrase','certificate']

collectSecrets(row)   → { top: {...}, hoppings: [{...}] } | null   // 只收非空字符串/对象
stripSecrets(row)     → 删掉明文敏感字段后的副本（保留 _vault）
sealRow(row, dek)     → 生成 _vault、删除明文；无敏感字段则原样返回
openRow(row, dek)     → 解开 _vault 并合并明文、删除 _vault
rowState(row)         → 'sealed' | 'plain' | 'empty'
secretCount(row)      → 明文敏感字段条数（迁移计数用）
```

- 失败不抛：`openRow` 解密失败返回 `{ row, error }`，调用方决定降级。
- 所有函数不改入参，返回新对象（渲染层/主进程共享的 observable 不会被就地改）。

### 3.2 新文件 `src/app/lib/vault-bookmarks.js`（读写包装）

```
wrapDbAction(rawDbAction) → async (dbName, op, ...args)
  - 非 SECRET_TABLES：原样透传
  - find / findOne：读回后逐行处理
      * 库未启用 → 原样
      * 行有 _vault 且已解锁 → openRow（渲染层拿到明文，维持现有契约）
      * 行有 _vault 且锁定   → stripSecrets + `_sealed: true`
      * 旧格式明文行         → 原样（保证迁移中断仍可连接）
  - insert / update：写前处理
      * 行有 _vault 且无明文敏感字段 → 原样（只改标题等非敏感字段）
      * 有明文敏感字段
          - 库未启用或 legacyWrite=true → 原样
          - 已解锁 → sealRow
          - 锁定   → 抛 `vault-locked`（表单应已拦住）
  - remove 等：透传

migrateBatch(rawDbAction, { limit }) → { total, done, sealed, remaining }
  - 只扫 bookmarks + profiles 中 rowState==='plain' 的行
  - 每行 sealRow 后写回；每批上限 limit（默认 50）
  - 需要已解锁，否则 { ok:false, reason:'vault-locked' }

unsealAll(rawDbAction) → { total, unsealed, failed }
  - 把 _vault 行反解回旧格式（写回明文、删 _vault）；需已解锁
```

依赖方向：`vault-bookmarks` 惰性 `require('./vault-instance')` 取服务；`db.js` 惰性引用包装器，避免模块环。

### 3.3 改动 `src/app/lib/db.js`

```js
const db = createDb(appPath, defaultUserName, encOpts)
module.exports = {
  ...db,
  rawDbAction: db.dbAction,          // 仅主进程内部（迁移/反解）使用
  dbAction: require('./vault-bookmarks').wrapDbAction(db.dbAction)
}
```

### 3.4 改动 `src/app/lib/vault.js`

- config 增两个字段：`legacyWrite: false`、`migrating: false`；`status()` 一并返回。
- 新增 handler `setLegacyWrite({ value })`、`markMigrating({ value })`（只写 config）。
- `disable()` 保持"证明身份 → 删 config"；反解动作由 `vault-instance` 前置执行（服务层不碰 DB）。

### 3.5 改动 `src/app/lib/vault-instance.js`

`vaultOp(action, arg)` 先拦这几个动作，其余仍走 `service.run`：

| action | 行为 |
|--------|------|
| `migrate` | `withDek` 内跑 `migrateBatch`；首尾 `markMigrating` |
| `migrateStatus` | 统计 `plain/sealed` 行数，只读 |
| `unsealAll` | `withDek` 内跑 `unsealAll` |
| `revealBookmark` | 按 id `findOne('bookmarks')` → `openRow`，只返回敏感字段明文；锁定返回 `vault-locked` |
| `disable` | 若存在 `_vault` 行：必须先 `unsealAll`（锁定返回 `vault-locked`）→ 再 `service.run('disable')` |

`revealBookmark` 返回值不含 `_vault`、不含非敏感字段；不写日志。

---

## 4. 渲染层设计（含草图，需确认）

### 4.1 新文件 `src/client/common/vault-unlock.js`

跨组件的"请求解锁"通道（store 与底栏锁头共用，属于同一机制，不新增平行抽象）：

```
requestUnlock() → Promise<boolean>   // 无订阅者时直接 false
onUnlockRequest(fn) → unsubscribe    // vault-lock.jsx 订阅后打开现有 Modal
settleUnlock(ok)                     // 弹窗成功/取消时回填并清空 pending
```

### 4.2 改动 `src/client/components/setting-panel/vault-lock.jsx`

- 挂 `onUnlockRequest`：收到请求 → `setOpen(true)`，记住 pending。
- `handleUnlock` 成功 → `settleUnlock(true)`；`onCancel`/取消 → `settleUnlock(false)`。
- 不改现有解锁弹窗外观。

### 4.3 改动 `src/client/store/setting.js`（连接拦截）

```
onSelectBookmark(id) 改为 async：
  1. status = vaultOp('status')
  2. enabled && !unlocked → ok = await requestUnlock()；false 则 message.warning(vaultNeedUnlockToConnect) 并 return
  3. item 若有 _sealed（或含 _vault）→ r = vaultOp('revealBookmark', { id })（锁定即重复步骤 2）
     r.ok → 合并明文；失败 → 提示并 return
  4. 原有 addTab 逻辑不变
```

蓝图：

```
[点击书签]
   │
   ├─ 库未启用 / 已解锁 ──────────────► 直接连接
   │
   └─ 库已启用且锁定
        ┌───────────────────────────────┐
        │ 保险库已解锁后才能新建连接        │
        │ 主密码 [____________]           │
        │ [取消]              [解锁]      │
        └───────────────────────────────┘
             │成功                     │取消
             ▼                         ▼
        取回凭据 → 自动连接         不建 tab，toast 提示
```

### 4.4 改动 `src/client/components/setting-panel/setting-vault.jsx`

在"保险库"一节追加两块（沿用现有卡片/按钮风格）：

```
┌ 保险库 ──────────────────────────────────────────┐
│ 状态：已解锁 / 已锁定    自动锁定 [15 分钟 v]      │
│                                                   │
│ 凭据迁移                                          │
│  ███████░░░  210 / 300                            │
│  说明：分批迁移，可中断后继续；旧格式仍可连接        │
│  [继续迁移]  [稍后]                                │
│                                                   │
│ 兼容写入（legacyWrite）            [ 开关 ]        │
│  开启后新凭据仍以旧格式保存                        │
│                                                   │
│ [修改主密码] [更换恢复码] [停用]                    │
└───────────────────────────────────────────────────┘
```

- "凭据迁移"块只在 `enabled && (migrating || 存在旧格式行)` 时显示；进度来自 `migrateStatus`。
- 停用按钮：锁定态点击 → 提示先解锁；解锁态先 `unsealAll` 再停用。

### 4.5 书签表单锁定提示（D8）

`src/client/components/bookmark-form/form-renderer.jsx` 顶部加一条 Alert（仅 `enabled && locked`）：

```
保险库已锁定：密码 / 私钥 / 口令暂不可见；保存不会清除已存凭据。
```

密码类输入框保持可输入；若用户重新填写，提交时因库锁定被主进程拒绝，界面把 `vault-locked` 翻成"请先解锁保险库"。

### 4.6 词条（`src/app/common/locales-extra.js`）

新增：`vaultNeedUnlockToConnect`、`vaultMigrating`、`vaultMigrateResume`、`vaultMigrateLater`、`vaultMigrateIntro`、`vaultLegacyWrite`、`vaultLegacyWriteHint`、`vaultSealedFormHint`、`vaultUnsealBeforeDisable`、`vaultUnsealFailed`。

---

## 5. 实施顺序与提交（每点一提交，提交后 push）

| 提交 | 内容 | 关键文件 |
|------|------|----------|
| G6-2a | 敏感字段纯模块 + 单测 | `src/app/lib/vault-secrets.js`、`src/test/unit-ci/vault-secrets.spec.js` |
| G6-2b | dbAction 读写包装 + legacyWrite/migrating 状态 | `src/app/lib/vault-bookmarks.js`、`src/app/lib/db.js`、`src/app/lib/vault.js`、单测 |
| G6-2c | 迁移/反解/reveal/disable 动作 + 单测 | `src/app/lib/vault-instance.js`、`vault-bookmarks.js`、`vault-instance` 测试 |
| G6-2d | 连接拦截 + 解锁请求通道 + 单测 | `src/client/common/vault-unlock.js`、`vault-lock.jsx`、`store/setting.js` |
| G6-2e | 设置页迁移/legacyWrite UI + 表单提示 + 词条 | `setting-vault.jsx`、`form-renderer.jsx`、`locales-extra.js`、样式仅复用现有类 |
| G6-2f | 真实例 demo + 截图 + 文档刷新 | `self-test/vault-phase2-demo.js`、设计 §14.7 补记、TODO 台账 |

---

## 6. 验证

1. `export PATH="$HOME/.config/nvm/versions/node/v22.23.2/bin:$PATH"` 后：
   - `node --experimental-detect-module --test src/test/unit-ci/vault-secrets.spec.js`（类同其他新增 spec）
   - 全量 `npm run test-unit-ci`
   - `npx standard`、`npm run vite-build`
2. 真实例 demo（临时 HOME，假书签，不写真实凭据）：
   - 启用 → 迁移 → 检查 DB 行内无明文；锁定 → 点书签弹窗 → 取消不建 tab → 解锁自动连接；
   - 停用 → 明文回填、可连接；混合状态（手工留一条旧格式行）可连接。
   - 截图 4~6 张进 `self-test/vault-phase2-shots/`。
3. 已知边界（写入文档，不在本阶段解决）：
   - `addressBookmarks` / 同步文件 / 导出的 JSON 不在封存范围；
   - 锁定态导出会缺敏感字段（冷启动锁定）；
   - Linux 无 libsecret 时 `safeStorage` 退化的既有风险不变。

---

## 7. 待确认（✅ 2026-11-03 全部按"建议"确认）

- [x] §2 的 D1~D8 是否按"建议"执行
- [x] §4.4 设置页新增两块 UI 是否接受
- [x] §4.5 书签表单锁定提示是否接受
- [x] §5 六个提交的拆分粒度是否接受
