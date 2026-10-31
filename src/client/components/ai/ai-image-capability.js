/**
 * 「当前选中的模型能不能收图片」的判定。
 *
 * 先把边界说清楚：没有任何标准接口会告诉你一个模型是否支持视觉输入。
 * OpenAI 兼容的 /models 只返回 id 与 owned_by，Anthropic 的 /models 同样没有
 * 模态字段；而 electerm 的预置一大半是中转站，模型名是自己起的（deepseek-flash
 * 这种），名字里读不出任何东西。所以这里只能给"分层判定 + 人工覆盖"，不能给保证。
 *
 * 三层来源，优先级从高到低：
 *   1. 用户显式覆盖 supportsImageAI = 'on' | 'off'（唯一算数的答案）；
 *   2. 预置标注——ai-presets 的 modelAIs 条目可以带 vision: true|false，
 *      用于名字读不出模态的模型（中转站改名、聚合网关）；
 *   3. 模型名启发式——只对主流命名可靠，判出的结论一律带"按名字猜"的来源标注。
 *
 * 判否的名单刻意保守：判成"不支持"会在发送前拦一道，代价比"未识别"大得多。
 * 未识别（unknown）不拦——否则大多数中转站直接不能贴图，等于把功能锁死在我们的
 * 元数据没跟上；真发给纯文本模型时由 provider 回错误，那时用户已经看得见原因。
 */

// 显式带 .js：node 的 ESM loader 不做扩展名补全，单测要能直接 import 这个模块
import { defaultAIPresets } from './ai-presets.js'

export const SUPPORT_YES = 'yes'
export const SUPPORT_NO = 'no'
export const SUPPORT_UNKNOWN = 'unknown'

export const SOURCE_OVERRIDE = 'override'
export const SOURCE_PRESET = 'preset'
export const SOURCE_MODEL_NAME = 'model-name'
export const SOURCE_NONE = 'none'

// 收了图就能看懂的命名族。claude 全系（3 之后）都带视觉；gemini 全系带视觉；
// *-vl / vision / pixtral / llama-4 这些是名字里就写着"看图"的
const VISION_NAME_RE = /(gemini|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|claude|qwen[\w.-]*-vl|glm-4v|internvl|minicpm-v|pixtral|llama-4|phi-4-multimodal|\bvision\b|\bvl-)/i

// 官方接口文档写死只收文本的命名。宁可漏判成 unknown，也不要把能看图的模型判成不能
const TEXT_ONLY_NAME_RE = /(deepseek-(chat|reasoner)|llama-[23](\.\d)?[-\w]*|moonshot-v1-|mistral-large|mistral-small|codestral|devstral|whisper|text-embedding|dall-?e|rerank|o1-preview)/i

// 预置项既可能是 { value, vision } 也可能是裸字符串（ai-presets 里两种写法都有）
function presetVisionForModel (preset, model) {
  if (!preset) {
    return null
  }
  const name = String(model || '').trim().toLowerCase()
  if (!name) {
    return null
  }
  const list = preset.modelAIs || []
  for (const entry of list) {
    const item = typeof entry === 'string' ? { value: entry } : entry
    if (String(item.value || '').trim().toLowerCase() !== name) {
      continue
    }
    if (typeof item.vision === 'boolean') {
      return item.vision
    }
  }
  return null
}

function findPreset (baseURL, presets) {
  const url = String(baseURL || '').trim().replace(/\/+$/, '')
  if (!url) {
    return null
  }
  const list = presets || []
  return list.find(p => p && (p.baseURLAI === url || (p.aliasURLs || []).includes(url))) || null
}

function heuristic (model) {
  const name = String(model || '').trim()
  if (!name) {
    return { support: SUPPORT_UNKNOWN, source: SOURCE_NONE }
  }
  // 先判"能看"：llama-3.2-vision 这类名字同时命中两张表时，vision 优先
  if (VISION_NAME_RE.test(name)) {
    return { support: SUPPORT_YES, source: SOURCE_MODEL_NAME }
  }
  if (TEXT_ONLY_NAME_RE.test(name)) {
    return { support: SUPPORT_NO, source: SOURCE_MODEL_NAME }
  }
  return { support: SUPPORT_UNKNOWN, source: SOURCE_NONE }
}

/**
 * @param {object} opts
 * @param {string} [opts.supportsImageAI] 配置里的三态覆盖：'auto' | 'on' | 'off'
 * @param {string} [opts.modelAI]         当前模型名
 * @param {string} [opts.baseURLAI]       当前接入地址，用来定位预置
 * @param {Array}  [opts.presets]         预置表（默认取 ai-presets 的 defaultAIPresets）
 * @returns {{support: string, source: string}} 三态结论 + 判定来源
 */
export function detectImageCapability (opts = {}) {
  const { supportsImageAI, modelAI, baseURLAI } = opts
  const flag = String(supportsImageAI || 'auto').trim().toLowerCase()
  if (flag === 'on') {
    return { support: SUPPORT_YES, source: SOURCE_OVERRIDE }
  }
  if (flag === 'off') {
    return { support: SUPPORT_NO, source: SOURCE_OVERRIDE }
  }

  // auto：预置标注 > 名字启发式。预置能覆盖名字，正是它存在的理由
  // （中转站把视觉模型改名成 deepseek-flash 时，名字读不出来，标注可以）
  const preset = findPreset(baseURLAI, opts.presets || defaultAIPresets)
  const vision = presetVisionForModel(preset, modelAI)
  if (vision === true) {
    return { support: SUPPORT_YES, source: SOURCE_PRESET }
  }
  if (vision === false) {
    return { support: SUPPORT_NO, source: SOURCE_PRESET }
  }
  return heuristic(modelAI)
}

/**
 * 这次能不能把图片发出去。
 *
 * 只有"判成不支持"才拦：拦错了用户点一下就放开（allowOnce），拦不住的风险由
 * provider 的错误兜着；而"未识别"不拦，是因为大部分接入点都在这一档。
 *
 * @param {string} support detectImageCapability 的 support
 * @param {boolean} [allowOnce] 本次已确认仍要发送
 */
export function canSendImages (support, allowOnce = false) {
  // 只认 === true：这道判断的意义是"人要显式点头"，一个残留的字符串/数字
  // 不该把闸门打开
  if (allowOnce === true) {
    return true
  }
  return support !== SUPPORT_NO
}

/**
 * 图片占多少上下文。
 *
 * 各家算法不一致，Anthropic 公开的近似是 (宽×高)/750，OpenAI 对高清图的口径也在
 * 几百到一千多之间浮动。这里取同一近似并给下限：宁可估高一点，也不要让用户以为
 * 还有余量——带图后上下文指示条立刻变红是符合预期的，不是缺陷。
 */
export function estimateImageTokens (width, height) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (w <= 0 || h <= 0) {
    return 85
  }
  return Math.max(85, Math.ceil((w * h) / 750))
}
