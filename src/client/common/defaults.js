// 默认值 / 固定值唯一索引：只 re-export，不定义任何值。
// 域文件清单、「新增域文件必须被索引」、「索引不得定义值」由
// src/test/unit-ci/defaults-index-ssot.spec.js 锁定。
export * from './constants.js'
export * from './db-session-const.js'
export { default as clientDefaultSetting } from './default-setting.js'
export * from './keyword-limits.js'
export * from './sync-payload-limit.js'
export * from './term-flow.js'
export * from './theme-defaults.js'
