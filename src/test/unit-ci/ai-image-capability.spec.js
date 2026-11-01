// 图片能力判定（三层来源）的契约。
//
// 这里钉住的是"判定不能悄悄退化"的几件事：
// - 用户覆盖算第一优先级，且只认 on/off，其它值一律按 auto 走；
// - 预置标注能压过模型名（中转站改名后名字读不出东西，只能靠标注）；
// - 启发式的判否名单保守：名字里写着 vision 就先算能看，deepseek-chat 这类才判否；
// - 读不出来是 unknown 并且不拦发送——否则大部分中转站直接不能贴图；
// - 图片 token 估算有下限，宁可估高不要估低。
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

let cap

before(async () => {
  cap = await import('../../../src/client/components/ai/ai-image-capability.js')
})

// 判定结果的取值就是这几个字面量；测试里用具名字面量，模块导出改名时这里会红
const SUPPORT_YES = 'yes'
const SUPPORT_NO = 'no'
const SUPPORT_UNKNOWN = 'unknown'
const SOURCE_OVERRIDE = 'override'
const SOURCE_PRESET = 'preset'
const SOURCE_MODEL_NAME = 'model-name'
const SOURCE_NONE = 'none'

const detect = opts => cap.detectImageCapability(opts)

describe('detectImageCapability：用户覆盖是第一层', () => {
  it('on 压过"名字写着纯文本"的模型', () => {
    const r = detect({ supportsImageAI: 'on', modelAI: 'deepseek-chat', baseURLAI: 'https://api.deepseek.com/v1' })
    assert.equal(r.support, 'yes')
    assert.equal(r.source, SOURCE_OVERRIDE)
  })

  it('off 压过"名字写着视觉"的模型，也压过预置标注', () => {
    assert.equal(detect({ supportsImageAI: 'off', modelAI: 'gpt-4o' }).support, 'no')
    const preset = detect({
      supportsImageAI: 'off',
      modelAI: 'claude-sonnet-4-5',
      baseURLAI: 'https://api.anthropic.com/v1'
    })
    assert.equal(preset.source, SOURCE_OVERRIDE)
  })

  it('空值/大小写/其它写法都按 auto 处理（不能因为一个脏值就断言能力）', () => {
    for (const v of [undefined, null, '', 'AUTO', 'auto ', 'yes', 'true', '1']) {
      assert.equal(detect({ supportsImageAI: v, modelAI: 'gpt-4o' }).support, 'yes', String(v))
    }
  })
})

describe('detectImageCapability：预置标注是第二层', () => {
  const presets = [
    {
      baseURLAI: 'https://relay.example/v1',
      modelAIs: [
        { value: 'relay-alias-a', vision: true },
        { value: 'relay-alias-b', vision: false },
        { value: 'Unannotated' }
      ]
    },
    {
      baseURLAI: 'https://alias-primary.example/v1',
      aliasURLs: ['https://alias-old.example/v1'],
      modelAIs: [{ value: 'weird-name', vision: true }]
    }
  ]

  it('名字读不出模态时，标注给出答案', () => {
    const yes = detect({ modelAI: 'relay-alias-a', baseURLAI: 'https://relay.example/v1', presets })
    assert.deepEqual([yes.support, yes.source], ['yes', 'preset'])
    const no = detect({ modelAI: 'relay-alias-b', baseURLAI: 'https://relay.example/v1', presets })
    assert.deepEqual([no.support, no.source], ['no', 'preset'])
  })

  it('标注能压过模型名：名字看着像视觉模型，标了 false 就按 false', () => {
    const r = detect({
      modelAI: 'gemini-not-really',
      baseURLAI: 'https://relay.example/v1',
      presets: [{ baseURLAI: 'https://relay.example/v1', modelAIs: [{ value: 'gemini-not-really', vision: false }] }]
    })
    assert.deepEqual([r.support, r.source], ['no', 'preset'])
  })

  it('裸字符串条目 / 没有 vision 字段的条目不表态，继续走名字', () => {
    const r = detect({ modelAI: 'Unannotated', baseURLAI: 'https://relay.example/v1', presets })
    assert.deepEqual([r.support, r.source], [SUPPORT_UNKNOWN, SOURCE_NONE])
    const byName = detect({ modelAI: 'gpt-4o', baseURLAI: 'https://relay.example/v1', presets })
    assert.equal(byName.source, SOURCE_MODEL_NAME)
  })

  it('按 baseURL 定位预置：尾斜杠与别名都要认，模型名大小写不敏感', () => {
    const alias = detect({ modelAI: 'weird-name', baseURLAI: 'https://alias-old.example/v1/', presets })
    const primary = detect({ modelAI: 'weird-name', baseURLAI: 'https://alias-primary.example/v1', presets })
    assert.deepEqual([alias.support, alias.source], ['yes', 'preset'])
    assert.deepEqual([primary.support, primary.source], ['yes', 'preset'])
    assert.equal(detect({ modelAI: 'RELAy-alias-A', baseURLAI: 'https://relay.example/v1', presets }).support, 'yes')
  })

  it('认不出 baseURL（自建/自定义地址）时不猜预置，交给名字', () => {
    const r = detect({ modelAI: 'relay-alias-a', baseURLAI: 'https://my-own-gateway.local/v1', presets })
    assert.equal(r.source, SOURCE_NONE)
  })

  it('真实的 Anthropic 预置带 vision 标注（数据不能被悄悄删掉）', async () => {
    const { defaultAIPresets } = await import('../../../src/client/components/ai/ai-presets.js')
    const anthropic = defaultAIPresets.find(p => p.baseURLAI === 'https://api.anthropic.com/v1')
    assert.ok(anthropic.modelAIs.every(m => m.vision === true), 'Anthropic 预置的模型条目应全部标注支持图片')
    assert.equal(detect({ modelAI: 'claude-haiku-4-5', baseURLAI: 'https://api.anthropic.com/v1' }).source, SOURCE_PRESET)
  })
})

describe('detectImageCapability：模型名启发式是兜底', () => {
  const yes = [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'chatgpt-4o-latest',
    'gemini-2.0-flash', 'gemini-2.5-pro', 'claude-sonnet-4-5', 'claude-3-5-sonnet',
    'qwen2.5-vl-72b-instruct', 'glm-4v-plus', 'pixtral-large-latest',
    'meta-llama/llama-3.2-vision-11b', 'moonshotai/kimi-vl-a3b', 'internvl2_5-8b'
  ]
  const no = [
    'deepseek-chat', 'deepseek-reasoner', 'llama-3.3-70b-versatile',
    'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'moonshot-v1-8k',
    'mistral-large-latest', 'mistral-small-latest', 'codestral-latest',
    'text-embedding-3-small', 'dall-e-3', 'whisper-1', 'o1-preview'
  ]
  const unknown = [
    'deepseek-flash', 'deepseek-v4-flash', 'DEEPSEEK_V4_FLASH', 'orcarouter/free',
    'MiniMax-M3.1-Flash', 'grok-3-mini', 'sonar', 'zai-org/GLM-5.3', 'moonshotai/Kimi-K3',
    'my-model', ''
  ]

  for (const m of yes) {
    it(`${m} → 支持（来源是模型名）`, () => {
      const r = detect({ modelAI: m })
      assert.equal(r.support, SUPPORT_YES, r.source)
      assert.equal(r.source, SOURCE_MODEL_NAME)
    })
  }

  for (const m of no) {
    it(`${m} → 不支持（判否的名单必须保守且可覆盖）`, () => {
      assert.equal(detect({ modelAI: m }).support, SUPPORT_NO, m)
      assert.equal(detect({ modelAI: m }).source, SOURCE_MODEL_NAME)
    })
  }

  for (const m of unknown) {
    it(`${m || '(空模型名)'} → 未识别：不表态也不拦发送`, () => {
      const r = detect({ modelAI: m })
      assert.equal(r.support, SUPPORT_UNKNOWN, m)
      assert.equal(r.source, SOURCE_NONE, m)
    })
  }

  it('预置默认模型也能判：openai 预置的 gpt-4o 走名字，deepseek 预置的 deepseek-chat 判否', () => {
    assert.equal(detect({ modelAI: 'gpt-4o', baseURLAI: 'https://api.openai.com/v1' }).support, SUPPORT_YES)
    assert.equal(detect({ modelAI: 'deepseek-chat', baseURLAI: 'https://api.deepseek.com/v1' }).support, SUPPORT_NO)
  })
})

describe('canSendImages：只有"判成不支持"才拦', () => {
  it('yes / unknown 放行，no 拦下', () => {
    assert.equal(cap.canSendImages(SUPPORT_YES), true)
    assert.equal(cap.canSendImages(SUPPORT_UNKNOWN), true)
    assert.equal(cap.canSendImages(SUPPORT_NO), false)
  })

  it('no + 本次确认仍要发送 → 放行（判定错了不能变成死路）', () => {
    assert.equal(cap.canSendImages(SUPPORT_NO, true), true)
  })

  it('allowOnce 只认真值：字符串/1 不算已确认', () => {
    assert.equal(cap.canSendImages(SUPPORT_NO, 'yes'), false)
    assert.equal(cap.canSendImages(SUPPORT_NO, 1), false)
  })
})

describe('detectTransport / evaluateImageSend：能力之外还要看通道', () => {
  it('apiPath 判定与主进程 detectFormat 同口径', () => {
    assert.equal(cap.detectTransport('/chat/completions'), 'openai-chat')
    assert.equal(cap.detectTransport('/responses'), 'openai-responses')
    assert.equal(cap.detectTransport('/v1/messages'), 'anthropic')
    // 空值/自定义路径按 Chat 处理（现有请求体形状就是 Chat）
    assert.equal(cap.detectTransport(''), 'openai-chat')
    assert.equal(cap.detectTransport('/generateContent'), 'openai-chat')
  })

  it('非 Chat 通道一律拦下，且"仍要发送"不能放行——图会在构造请求体时被压成文本', () => {
    const r = cap.evaluateImageSend({ support: 'yes', apiPath: '/v1/messages', allowOnce: true })
    assert.deepEqual([r.allowed, r.reason], [false, 'transport'])
    assert.equal(cap.evaluateImageSend({ support: 'yes', apiPath: '/responses' }).reason, 'transport')
  })

  it('Chat 通道下按能力判定：no 拦、unknown 放、no+点头放', () => {
    assert.deepEqual(
      cap.evaluateImageSend({ support: 'no', apiPath: '/chat/completions' }),
      { allowed: false, reason: 'capability' }
    )
    assert.equal(cap.evaluateImageSend({ support: 'no', apiPath: '/chat/completions', allowOnce: true }).allowed, true)
    assert.equal(cap.evaluateImageSend({ support: 'unknown', apiPath: '/chat/completions' }).allowed, true)
    assert.equal(cap.evaluateImageSend({ support: 'yes', apiPath: '/chat/completions' }).reason, '')
  })

  it('参数缺失不炸（组件第一次渲染时 config 可能是空的）', () => {
    assert.equal(cap.evaluateImageSend().allowed, true)
    assert.equal(cap.evaluateImageSend({}).allowed, true)
  })
})

describe('estimateImageTokens：估高不估低', () => {
  it('按 (宽×高)/750 近似并取整', () => {
    assert.equal(cap.estimateImageTokens(1024, 1024), Math.ceil((1024 * 1024) / 750))
    assert.equal(cap.estimateImageTokens(1568, 1568), Math.ceil((1568 * 1568) / 750))
  })

  it('小图有 85 的下限', () => {
    assert.equal(cap.estimateImageTokens(64, 64), 85)
  })

  it('尺寸缺失/非法不炸，按下限算', () => {
    assert.equal(cap.estimateImageTokens(0, 0), 85)
    assert.equal(cap.estimateImageTokens(undefined, undefined), 85)
    assert.equal(cap.estimateImageTokens('abc', 100), 85)
  })
})
