// supportsImageAI 的落点契约。
//
// 这个配置项最容易坏在"只加了一半"：
// - 不进 optionalAIConfigsArr → aiConfigMissing 把它当必填，空值时一开面板就弹设置窗；
// - 不进同步表 → 换机后模型还在，能力判定却回到猜；
// - 不进提交条目的 pick → 历史条目记住不了当时的判定口径，重放时说法会变；
// - 词条只写一边 → 界面直接掉回 key 本身。
// 五条都在下面钉住，改动时哪条断了当场就红。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const DEFAULTS = read('src/app/common/default-setting.js')
const SYNC = read('src/client/store/sync.js')
const CHAT = read('src/client/components/ai/ai-chat.jsx')
const FORM = read('src/client/components/ai/ai-config.jsx')
const LOCALES = read('src/app/common/locales-extra.js')

const KEYS = [
  'aiSupportsImage',
  'aiSupportsImageTip',
  'aiSupportsImageAuto',
  'aiSupportsImageOn',
  'aiSupportsImageOff'
]

describe('supportsImageAI：默认值与同步', () => {
  test('默认是 auto（不给保证的默认值不能是 on/off 里的任何一个）', () => {
    assert.match(DEFAULTS, /supportsImageAI: 'auto'/)
  })

  test('进同步白名单：跟着模型走，又不是密钥', () => {
    const at = SYNC.indexOf("'modelAI',")
    assert.ok(at > 0, '同步表里找不到 modelAI')
    const block = SYNC.slice(at - 200, at + 400)
    assert.match(block, /'supportsImageAI'/, '能力位没跟 modelAI 一起同步')
    // apiPathAI/baseURLAI 之外的密钥类字段本来就不该同步，这里只确认没把 apiKey 顺手带上
    assert.doesNotMatch(block, /apiKeyAI/, '同步块里出现了 apiKeyAI')
  })
})

describe('supportsImageAI：配置数组两头都要有', () => {
  test('aiConfigsArr 有它，设置表单才会读写这个字段', async () => {
    const mod = await import('../../../src/client/components/ai/ai-config-props.js')
    assert.ok(mod.aiConfigsArr.includes('supportsImageAI'))
  })

  test('optionalAIConfigsArr 也要有它，否则空值时反复弹设置窗', async () => {
    const mod = await import('../../../src/client/components/ai/ai-config-props.js')
    assert.ok(
      mod.optionalAIConfigsArr.includes('supportsImageAI'),
      '漏了这一条：aiConfigMissing 把它当必填项，老配置没有该键会一直弹 AI 设置窗'
    )
  })
})

describe('supportsImageAI：设置表单与提交条目', () => {
  test('表单三态齐备，且绑在模型字段之后（能力是模型的属性）', () => {
    assert.match(FORM, /name='supportsImageAI'/)
    for (const v of ['auto', 'on', 'off']) {
      assert.ok(FORM.includes(`value: '${v}'`), `三态缺 ${v}`)
    }
    const model = FORM.indexOf("label={e('modelAi')}")
    const cap = FORM.indexOf("name='supportsImageAI'")
    assert.ok(model > 0 && cap > model, '能力位应紧跟模型字段，而不是塞在别处')
  })

  test('提交条目带上能力位：历史重放用当时的口径，事后改设置不改旧条目说法', () => {
    const at = CHAT.indexOf("'supportsImageAI'")
    assert.ok(at > 0, '提交条目没有 pick 能力位')
    const block = CHAT.slice(Math.max(0, at - 500), at + 40)
    assert.match(block, /pick\(props\.config, \[/, '能力位应在提交条目的 pick 里')
  })
})

describe('supportsImageAI：词条双语', () => {
  test('五个 key 在 en 与 zhCn 里各出现一次', () => {
    for (const k of KEYS) {
      const n = LOCALES.split(k + ':').length - 1
      assert.equal(n, 2, `${k} 出现 ${n} 次（应中英各一次）`)
    }
  })

  test('中文值不是 key 本身（掉回 key 说明只写了英文那半）', () => {
    const zh = LOCALES.slice(LOCALES.indexOf('const zhCn'))
    assert.match(zh, /aiSupportsImageAuto: '自动判断'/)
    assert.match(zh, /aiSupportsImageOff: '纯文本'/)
  })
})
