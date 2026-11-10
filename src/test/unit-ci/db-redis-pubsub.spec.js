#!/usr/bin/env node
/**
 * N5f · Redis Pub/Sub 契约测试
 *
 * 锁的是源码事实（CDP 真机探针 self-test/redis-pubsub-cdp-probe.js 锁运行时）：
 *   1. 主进程四件套存在且走独立订阅 client（subscribe 切连接模式，绝不与共享连接合用）
 *   2. closeRedisConnection 兜底清 pubsubs（订阅连接泄漏 = 常驻 fd）
 *   3. 转发层登记 4 个 op（错一个名字渲染层就是 undefined is not a function）
 *   4. 发布测试行走控制台策略通道（runRedisCommand），不绕过护栏；
 *      PUBLISH 不在 BLOCKED 名单（否则发布框永远被拒）
 *   5. i18n en/zh 成对、styl token 纪律
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const r = (...p) => path.join(__dirname, '..', '..', '..', ...p)
const read = f => fs.readFileSync(r(f), 'utf8')

const redisSrc = read('src/app/lib/db-client/redis.js')
const indexSrc = read('src/app/lib/db-client/index.js')
const keysSrc = read('src/client/components/database/use-db-redis-keys.js')
const panelSrc = read('src/client/components/database/db-redis-key-space.jsx')
const policySrc = read('src/app/lib/db-client/redis-command-policy.js')
const localesSrc = read('src/app/common/locales-extra.js')
const stylSrc = read('src/client/components/database/db-session.styl')

const KEYS = [
  'dbRedisPubSub',
  'dbRedisPubSubTitle',
  'dbRedisPubSubChannels',
  'dbRedisPubSubPatterns',
  'dbRedisPubSubTip',
  'dbRedisPubSubStart',
  'dbRedisPubSubStartFailed',
  'dbRedisPubSubStop',
  'dbRedisPubSubPause',
  'dbRedisPubSubResume',
  'dbRedisPubSubCopy',
  'dbRedisPubSubClear',
  'dbRedisPubSubEmpty',
  'dbRedisPubSubWaiting',
  'dbRedisPubSubColKind',
  'dbRedisPubSubKindMsg',
  'dbRedisPubSubKindPmsg',
  'dbRedisPubSubColChannel',
  'dbRedisPubSubColMessage',
  'dbRedisPubSubPublish',
  'dbRedisPubSubPubChannel',
  'dbRedisPubSubPubMessage',
  'dbRedisPubSubPublishOk',
  'dbRedisPubSubPublishFailed'
]

test('主进程导出 Pub/Sub 四件套', () => {
  for (const fn of ['startRedisPubSub', 'getRedisPubSubData', 'toggleRedisPubSubPause', 'stopRedisPubSub']) {
    assert.ok(redisSrc.includes(`function ${fn} (`), `redis.js 定义 ${fn}`)
    assert.ok(redisSrc.includes(`  ${fn},`), `module.exports 含 ${fn}`)
  }
})

test('订阅走独立 client，与共享连接池隔离', () => {
  // startRedisPubSub 里必须自己 createClient（不碰 acquire 的共享连接）——
  // subscribe 会把连接切进订阅模式，复用共享连接 = 键树/控制台全废
  const m = redisSrc.match(/async function startRedisPubSub [\s\S]{0,800}/)
  assert.ok(m, 'startRedisPubSub 段落')
  assert.ok(m[0].includes('createClient(conn)'), 'startRedisPubSub 内 createClient')
  assert.ok(!m[0].includes('acquire('), 'startRedisPubSub 不碰共享连接 acquire')
})

test('message / pmessage 事件都落环形缓冲', () => {
  assert.ok(redisSrc.includes("client.on('message', (channel, message)"), 'message 事件')
  assert.ok(redisSrc.includes("client.on('pmessage', (pattern, channel, message)"), 'pmessage 事件')
  assert.ok(redisSrc.includes('const PUBSUB_RING_MAX = '), '环形上限常量')
  assert.ok(redisSrc.includes('const PUBSUB_TEXT_MAX = '), '正文截断常量')
  assert.ok(redisSrc.includes("'…[truncated]'"), '截断有标记不静默剪')
})

test('全部订阅失败时抛错并清理 handle；部分失败保留并回传 errors', () => {
  const m = redisSrc.match(/async function startRedisPubSub [\s\S]*?\n}/)
  assert.ok(m, 'startRedisPubSub 函数体')
  assert.ok(m[0].includes('if (!okChannels.length && !okPatterns.length)'), '全失败抛错判定')
  assert.ok(m[0].includes('cleanupPubsub(handleId)'), '失败路径清理 handle')
  assert.ok(m[0].includes('errors'), '回传 errors 清单')
})

test('closeRedisConnection 兜底清 pubsubs', () => {
  const m = redisSrc.match(/async function closeRedisConnection [\s\S]*?\n}/)
  assert.ok(m, 'closeRedisConnection 函数体')
  assert.ok(m[0].includes('pubsubs'), '关闭时遍历 pubsubs')
  assert.ok(m[0].includes('pubsubs.clear()'), 'pubsubs.clear()')
})

test('转发层登记 4 个 redis op', () => {
  const m = indexSrc.match(/redis: \{[\s\S]*?\n {2}\}/)
  assert.ok(m, 'redis adapter 段落')
  for (const op of ['startRedisPubSub', 'getRedisPubSubData', 'toggleRedisPubSubPause', 'stopRedisPubSub']) {
    assert.ok(m[0].includes(`${op}: '${op}'`), `adapter 登记 ${op}`)
  }
})

test('渲染层 4 个 wrapper 走 dbClientOp', () => {
  for (const fn of ['startRedisPubSub', 'getRedisPubSubData', 'toggleRedisPubSubPause', 'stopRedisPubSub']) {
    const re = new RegExp(`export function ${fn} [\\s\\S]*?dbClientOp', tabId, '${fn}'`)
    assert.ok(re.test(keysSrc), `${fn} → dbClientOp ${fn}`)
  }
})

test('面板：入口按钮 / Modal / 消息表 / 发布行走策略通道', () => {
  assert.ok(panelSrc.includes("className='db-redis-pubsub-open'"), '入口按钮')
  assert.ok(panelSrc.includes("className='db-redis-pubsub-modal'"), 'Modal className')
  assert.ok(panelSrc.includes('startRedisPubSub(tabId, pubsub.channels, pubsub.patterns)'), 'start 传 channels/patterns')
  assert.ok(panelSrc.includes("'runRedisCommand'"), 'PUBLISH 走 runRedisCommand 策略通道')
  // 引号转义：消息里的 " 与 \ 必须先转义再进 tokenize
  assert.ok(panelSrc.includes('.replace(/\\\\/g'), 'quoteArg 转义反斜杠')
  assert.ok(panelSrc.includes('.replace(/"/g'), 'quoteArg 转义双引号')
  // 订阅模式切换后才显示退订/暂停/复制（running 分支）
  assert.ok(panelSrc.includes('dbRedisPubSubStop'), '退订按钮')
  assert.ok(panelSrc.includes('toggleRedisPubSubPause'), '暂停接线')
})

test('PUBLISH 不在控制台黑名单（BLOCKED）；只读回落名单按需拦截', () => {
  // BLOCKED 是无条件拒绝；publish 属"只读位下才拒"（FALLBACK_WRITE），非只读可用。
  // 若有人把 publish 挪进 BLOCKED，发布测试行就永远死了 —— 这里守住这条线
  assert.ok(!/\['publish',/.test(policySrc), 'BLOCKED 名单不含 publish')
  assert.ok(/'sort', 'publish'/.test(policySrc), 'publish 在 FALLBACK_WRITE（只读拒，非只读放行）')
  // subscribe 类命令必须仍在 BLOCKED（共享连接保护，别被顺手删了）
  assert.ok(policySrc.includes("['subscribe', 'pubsub']"), 'subscribe 仍被控制台拦截')
})

test('i18n：24 键 en/zh 各出现一次以上', () => {
  for (const k of KEYS) {
    const n = localesSrc.split(k + ':').length - 1
    assert.ok(n >= 2, `${k} en+zh（实际 ${n} 处）`)
  }
})

test('styl：pubsub 块无 hex 颜色、无 px 圆角', () => {
  const m = stylSrc.match(/\.db-redis-pubsub-modal[\s\S]*$/)
  assert.ok(m, 'db-redis-pubsub-modal 块存在')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(m[0]), '块内无 hex 颜色')
  assert.ok(!/border-radius \d+px/.test(m[0]), '块内无 px 圆角字面量')
})
