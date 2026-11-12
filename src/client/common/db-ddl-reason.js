/**
 * 候选 DDL 的"为什么不生成语句"机器码 → i18n key（N3a 结构对比 / N3b 表设计器共用）
 *
 * 放这儿而不是留在组件里，是因为现在有两个界面要出同一批文案；复制一份就成了两处真相，
 * 生成器新增 reason 时必然只改到一边，另一边安静地退回"其他原因"那句话。
 *
 * 只存 key 不存译文，也不碰 window.translate：这个模块要能被 node 单测直接 import
 * （common/ 下的纯函数都吃这条约束），翻译是组件那一层的事。
 */
export const DdlReasonKey = {
  'type-whitelist': 'dbStructDiffDdlReasonType',
  'default-expression': 'dbStructDiffDdlReasonDefault',
  'alter-unsupported': 'dbStructDiffDdlReasonAlter',
  'index-changed': 'dbStructDiffDdlReasonIndex',
  'primary-index': 'dbStructDiffDdlReasonPrimary',
  'index-no-columns': 'dbStructDiffDdlReasonIndexCols',
  'fk-not-generated': 'dbStructDiffDdlReasonFk',
  'unknown-dialect': 'dbStructDiffDdlReasonDialect',
  'missing-target-loc': 'dbStructDiffDdlReasonLoc',
  // N7 新建表（createTableDdl）
  'create-unsupported-dialect': 'dbCreateReasonDialect',
  'bad-table-name': 'dbCreateReasonTableName',
  'no-column': 'dbCreateReasonNoColumn',
  'bad-column-name': 'dbCreateReasonColumnName',
  'missing-column-type': 'dbCreateReasonColumnType',
  'duplicate-column': 'dbCreateReasonDupColumn',
  'index-column-missing': 'dbCreateReasonIndexCol',
  other: 'dbStructDiffDdlReasonOther'
}

export const ddlReasonKey = reason => DdlReasonKey[reason] || DdlReasonKey.other
