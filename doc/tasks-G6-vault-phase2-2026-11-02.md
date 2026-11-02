# Tasks · G6 阶段②（书签凭据迁入 Vault + 锁定禁连）

> 规格：[`spec-G6-vault-phase2-2026-11-02.md`](./spec-G6-vault-phase2-2026-11-02.md)
> 状态：⏸ 待用户确认后开工。每完成一项在方框打 `[x]` 并单独提交。

## T1 · 敏感字段纯模块
- [x] 新增 `src/app/lib/vault-secrets.js`：`SECRET_KEYS`、`collectSecrets`、`stripSecrets`、`sealRow`、`openRow`、`rowState`、`secretCount`
- [x] 新增 `src/test/unit-ci/vault-secrets.spec.js`（覆盖：6 个顶层字段 + hoppings 4 项 + profiles；空值不封；解密失败不抛；不改入参）
- [x] `npx standard` + 单测通过 → 提交 `feat(vault): 书签敏感字段封装纯模块`

## T2 · 读写包装与状态字段
- [x] 新增 `src/app/lib/vault-bookmarks.js`：`wrapDbAction`
- [x] 改 `src/app/lib/db.js`：导出 `rawDbAction`，`dbAction` 走包装
- [x] 改 `src/app/lib/vault.js`：config 增 `legacyWrite`/`migrating`，status 返回，新增 `setLegacyWrite`/`markMigrating`
- [x] 单测 `vault-bookmarks.spec.js`（读锁定不泄明文、旧格式透传、无明文更新保留 `_vault`、锁定写明文抛 `vault-locked`、legacyWrite 透传）
- [x] 提交 `feat(vault): 主进程书签读写封装与兼容写入开关`

## T3 · 迁移 / 反解 / 取回
- [x] `vault-bookmarks.js` 增 `migrateBatch`、`unsealAll`
- [x] `vault-instance.js` 拦截 `migrate`/`migrateStatus`/`unsealAll`/`revealBookmark`/`disable`
- [x] 单测：分批上限、中断后剩余数、unsealAll 失败行保留、reveal 只回敏感字段、锁定 disable 拒绝
- [x] 提交 `feat(vault): 凭据迁移与停用前反解`

## T4 · 渲染层连接拦截
- [ ] 新增 `src/client/common/vault-unlock.js`（`requestUnlock` / `onUnlockRequest` / `settleUnlock`）
- [ ] 改 `vault-lock.jsx` 接入请求通道（成功 settle true / 取消 settle false / 卸载 settle false）
- [ ] 改 `src/client/store/setting.js` 的 `onSelectBookmark` 为异步门禁 + `revealBookmark`
- [ ] 单测 `vault-unlock.spec.js` + store 门禁纯逻辑断言
- [ ] 提交 `feat(vault): 锁定态拦截新建连接并自动续解锁`

## T5 · 设置页与表单提示
- [ ] `setting-vault.jsx`：迁移进度块（`migrateStatus` + 分批续跑）、`legacyWrite` 开关、停用前反解
- [ ] `form-renderer.jsx`：锁定态 Alert
- [ ] `locales-extra.js`：10 条新词条（中英）
- [ ] 单测 `vault-setting-ui.spec.js` 增源码契约
- [ ] 提交 `feat(vault): 设置页迁移入口与锁定态表单提示`

## T6 · 真实例验收与文档
- [ ] `self-test/vault-phase2-demo.js`（临时 HOME：启用→迁移→检查行内无明文→锁定拦截→解锁续连→停用回填）
- [ ] 截图进 `self-test/vault-phase2-shots/`
- [ ] 设计 §14.7 补阶段②实施记录；TODO 台账勾掉阶段②
- [ ] 全量 `npm run test-unit-ci`、`npx standard`、`npm run vite-build`
- [ ] 提交 `test(vault): 阶段②真实例验收与文档`

## 验收门（全部满足才算完成）
- [ ] DB 行内无明文敏感字段
- [ ] 锁定点书签 → 弹窗；取消不建 tab；解锁自动连接
- [ ] 混合新旧格式全部可连接
- [ ] 停用后凭据完好
- [ ] 全量单测绿、lint/build 干净
