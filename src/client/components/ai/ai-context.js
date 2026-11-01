// Context accounting for the AI panel: how big is the conversation we are
// about to send, and how much of the model's context window does it fill.
//
// There is deliberately no tokenizer here. A real one needs the model's
// vocabulary (tiktoken & friends) and would pull a dependency into the
// renderer for a number that only has to be good enough to answer "should I
// compress?". The heuristic below is CJK aware and deliberately pessimistic,
// so the warning arrives a little early rather than too late. Where the
// provider reports real usage we show that number alongside the estimate.
//
// Pure module -- no window / store access -- so it can be unit tested and so
// the sender and the indicator cannot drift apart. The image helpers imported
// below are pure as well (ai-image-attachments.js only reaches browser APIs
// through injected deps), which is what lets node import this file for specs.
import { buildImagePlaceholder, MAX_IMAGE_EDGE } from './ai-image-attachments.js'
import { estimateImageTokens } from './ai-image-capability.js'

// Latin text and code average ~4 chars per token; 3.5 is the safe side.
const CHARS_PER_TOKEN = 3.5
// CJK is roughly one token per character (a little under for Chinese).
const TOKENS_PER_CJK_CHAR = 0.8
// Per message role/delimiter overhead, as counted by the OpenAI tokenizer.
const PER_MESSAGE_OVERHEAD = 4

// BMP ranges that tokenize densely: CJK ideographs, kana, full width forms.
const CJK_RE = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g

// Images are counted as pixels, not as base64 characters -- the data URL of a
// 300 KB screenshot would estimate at ~90k tokens and be wrong by two orders
// of magnitude. A content part on the wire carries no dimensions, so what we
// charge is a picture at the size our own encoder sends: the long edge is
// capped at MAX_IMAGE_EDGE and screenshots are roughly 16:9. (Worst case at
// that cap is 1568x1568 = ~3.3k, a small crop is 85; the 16:9 figure sits
// deliberately above the middle so a picture-heavy session warns early.)
const TOKENS_PER_IMAGE = estimateImageTokens(
  MAX_IMAGE_EDGE, Math.round(MAX_IMAGE_EDGE * 9 / 16)
)

export const DEFAULT_CONTEXT_WINDOW = 128000
export const CONTEXT_WARN_PERCENT = 70
export const CONTEXT_DANGER_PERCENT = 80

// Rough token count of a string. Never exact, never wildly wrong. Called on
// the whole conversation every time it changes, so it stays a single pass
// with one regex sweep rather than a per character test.
export function estimateTokens (text) {
  if (!text) {
    return 0
  }
  const str = typeof text === 'string' ? text : String(text)
  const cjkChars = str.match(CJK_RE)
  const cjk = cjkChars ? cjkChars.length : 0
  const other = str.length - cjk
  return Math.ceil(cjk * TOKENS_PER_CJK_CHAR + other / CHARS_PER_TOKEN)
}

// Tokens for a message `content`, which is a string for every turn we have
// sent so far and an array of parts for a user turn that carries images.
// Arrays must not fall through to estimateTokens: String([{...}]) is
// '[object Object]', so an image turn used to cost a handful of tokens and
// silently hid the few thousand the request really carries.
export function estimateContentTokens (content) {
  if (!content) {
    return 0
  }
  if (typeof content !== 'object') {
    return estimateTokens(content)
  }
  if (!Array.isArray(content)) {
    return estimateTokens(content)
  }
  let total = 0
  for (const part of content) {
    if (!part) {
      continue
    }
    if (typeof part === 'string') {
      total += estimateTokens(part)
      continue
    }
    // Anything that is not a picture part is text-shaped: {type:'text'},
    // Anthropic-style blocks, or a placeholder line. Count what text is there.
    if (part.type === 'image_url' || (part.image_url && !part.type)) {
      total += TOKENS_PER_IMAGE
      continue
    }
    const text = typeof part.text === 'string'
      ? part.text
      : (typeof part.content === 'string' ? part.content : '')
    total += estimateTokens(text)
    // An image URL that lives on the part instead of under image_url (the
    // Responses / Gemini shapes) is still an image, not a string of tokens.
    if (part.type === 'image' || part.type === 'input_image') {
      total += TOKENS_PER_IMAGE
    }
  }
  return total
}

// Tokens for a message array in the OpenAI chat shape (which is also what the
// anthropic / responses builders are fed before they re-shape it).
export function estimateMessagesTokens (messages) {
  if (!Array.isArray(messages)) {
    return 0
  }
  let total = 0
  for (const m of messages) {
    if (!m) {
      continue
    }
    total += PER_MESSAGE_OVERHEAD
    total += estimateContentTokens(m.content)
    if (m.role) {
      total += estimateTokens(m.role)
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc && tc.id)
        total += estimateTokens(tc && tc.function && tc.function.name)
        total += estimateTokens(tc && tc.function && tc.function.arguments)
      }
    }
  }
  return total
}

// Tool schemas are re-sent with every agent request and are far from free --
// ignoring them would understate agent mode by a few thousand tokens.
export function estimateToolsTokens (tools) {
  if (!Array.isArray(tools) || !tools.length) {
    return 0
  }
  try {
    return estimateTokens(JSON.stringify(tools))
  } catch (e) {
    return 0
  }
}

// The `content` of a user turn, in the OpenAI Chat shape.
//
// Two shapes on purpose: with no picture attached it stays the plain string
// every provider has always seen from us, and only a turn that really carries
// one becomes the documented part array [{type:'text'}, {type:'image_url',
// image_url:{url}}]. Keeping the string lane for everything else matters --
// requests without images must not change shape at all.
//
// `entry.images` is the metadata saved on the history entry (id, name, size...);
// the bytes themselves live in the in-process image cache, which is what
// `resolveImage(id)` looks them up. A picture no longer in the cache -- the
// window was reopened -- is sent as its name in brackets rather than as
// nothing: "look at this screenshot" with no screenshot and no trace of one
// reads to the model as a complete message.
//
// Only the Chat branch of ai-format.js forwards `content` verbatim, which is
// why image sending is gated on that transport before the request is built
// (evaluateImageSend): the responses / anthropic builders flatten arrays
// through textFromContent and would drop the pictures in silence.
export function buildUserContent (entry, resolveImage) {
  const text = (entry && (entry.promptWithAttachments || entry.prompt)) || ''
  const images = entry && entry.images
  if (!Array.isArray(images) || !images.length) {
    return text
  }
  const parts = []
  if (text) {
    parts.push({ type: 'text', text })
  }
  const missing = []
  for (const img of images) {
    const rec = typeof resolveImage === 'function'
      ? resolveImage(img && img.id)
      : null
    const url = rec && rec.dataUrl
    if (url) {
      parts.push({ type: 'image_url', image_url: { url } })
    } else {
      missing.push(buildImagePlaceholder(img))
    }
  }
  if (!parts.some(p => p.type === 'image_url')) {
    // Nothing to put on the wire: keep the string shape, say which pictures
    // were meant to be there.
    return [text, ...missing].filter(Boolean).join('\n\n')
  }
  if (missing.length) {
    parts.push({ type: 'text', text: missing.join('\n') })
  }
  return parts
}

// How many picture parts a built request carries, for the indicator's
// "N images ≈ M tokens" line. Derived from the messages themselves so it can
// never disagree with what is actually sent.
export function countContextImages (messages) {
  if (!Array.isArray(messages)) {
    return 0
  }
  let n = 0
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) {
      continue
    }
    for (const part of m.content) {
      if (part && (part.type === 'image_url' || part.type === 'image' ||
        part.type === 'input_image')) {
        n += 1
      }
    }
  }
  return n
}

// Best effort hints, checked 2026-09. No provider publishes the window over
// the API, and relays rename models freely, so this is only a starting point:
// the "Context length" field in the AI config always wins over it.
// Longest / most specific pattern first -- the list is scanned in order.
const MODEL_CONTEXT_WINDOWS = [
  [/qwen-?long/, 10000000],

  // 1M class
  [/gpt-6|gpt-5\.6|gpt-5-6/, 1050000],
  [/gemini/, 1048576],
  [/claude-(opus|sonnet|fable)-5/, 1000000],
  [/deepseek-v4/, 1000000],
  [/qwen3\.(7|8)|qwen3-max|qwen3\.5-max/, 1000000],
  [/kimi-?k3/, 1048576],

  // 500k / 400k / 256k class
  [/grok-4\.6/, 500000],
  [/gpt-5/, 400000],
  [/kimi-?k2\.7/, 262144],
  [/grok-4/, 256000],

  // 200k class
  [/claude/, 200000],
  [/\bo[134]\b/, 200000],

  // 128k class
  [/gpt-4\.1|gpt-4o|gpt-4-turbo|gpt-4-1106|gpt-4-0125/, 128000],
  [/llama-?[34]/, 131072],
  [/qwen/, 131072],
  [/kimi|moonshot/, 131072],
  [/glm|zhipu|chatglm/, 131072],
  [/ernie|wenxin/, 131072],
  [/grok/, 131072],
  [/mistral-large/, 131072],

  // older / smaller
  [/deepseek/, 65536],
  [/gpt-4-32k/, 32768],
  [/mixtral|mistral/, 32768],
  [/gpt-3\.5/, 16385],
  [/gpt-4/, 8192],
  [/llama-?2/, 4096]
]

// Returns { size, source } where source is 'config' | 'model' | 'default'.
export function getContextWindow (model, override) {
  const declared = Number(override)
  if (declared > 0) {
    return { size: declared, source: 'config' }
  }
  const id = String(model || '').toLowerCase()
  for (const [re, size] of MODEL_CONTEXT_WINDOWS) {
    if (re.test(id)) {
      return { size, source: 'model' }
    }
  }
  return { size: DEFAULT_CONTEXT_WINDOW, source: 'default' }
}

// The single source of truth for "what gets sent": both the request in
// ai-chat-history-item.jsx and the indicator in ai-chat.jsx go through here,
// so the number on screen is the number that leaves the machine.
//
// Returns null when there is no session to build from -- the sender reads
// that as "no history", and the main process then falls back to a plain
// prompt + role request.
//
// `upto` limits the window to entries at or before a timestamp (the entry
// being sent); `excludeId` drops one entry's response, which is what the
// sender does for its own turn. The indicator omits both to describe the
// *next* request, which will include every response so far.
//
// `resolveImage(id)` -> {dataUrl} | null looks up the picture bytes of a
// history entry's image metadata (see buildUserContent).
export function buildSessionMessages ({
  history,
  chatSessionId,
  upto = Infinity,
  role = '',
  excludeId = null,
  resolveImage = null
}) {
  if (!chatSessionId) {
    return null
  }
  const entries = (history || [])
    .filter(h => h.chatSessionId === chatSessionId && h.timestamp <= upto)
    .sort((a, b) => a.timestamp - b.timestamp)

  // A compressed entry replaces everything before it.
  let lastCompressIndex = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].compressed) {
      lastCompressIndex = i
      break
    }
  }

  const messages = [
    { role: 'system', content: role }
  ]

  const startIndex = lastCompressIndex >= 0 ? lastCompressIndex : 0
  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.compressed) {
      messages.push({
        role: 'user',
        content: `Here is a summary of our previous conversation for context:\n\n${entry.response}`
      })
    } else {
      messages.push({
        role: 'user',
        // promptWithAttachments carries the inlined file blocks;
        // falls back to the plain prompt for legacy entries
        content: buildUserContent(entry, resolveImage)
      })
      if (entry.response && entry.id !== excludeId) {
        messages.push({ role: 'assistant', content: entry.response })
      }
    }
  }
  return messages
}

// Agent mode keeps the session history but swaps in its own system prompt.
// `prompt` may be a string or the part array buildUserContent returns, so an
// agent turn that carries a picture sends it the same way an ask turn does.
export function buildAgentMessages ({ systemPrompt, conversationMessages, prompt }) {
  if (conversationMessages && conversationMessages.length > 1) {
    return [
      { role: 'system', content: systemPrompt },
      ...conversationMessages.filter(m => m.role !== 'system')
    ]
  }
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt }
  ]
}

// Everything the indicator needs, from the messages that will be sent.
export function summarizeContext (messages, { model, contextLength, tools } = {}) {
  const messagesTokens = estimateMessagesTokens(messages)
  const toolsTokens = estimateToolsTokens(tools)
  const tokens = messagesTokens + toolsTokens
  const win = getContextWindow(model, contextLength)
  return {
    tokens,
    messagesTokens,
    toolsTokens,
    images: countContextImages(messages),
    windowSize: win.size,
    windowSource: win.source,
    percent: win.size ? (tokens / win.size) * 100 : null,
    model: model || '',
    measuredTokens: null
  }
}

export function formatTokens (n) {
  const v = Number(n) || 0
  if (v < 1000) {
    return String(Math.round(v))
  }
  if (v < 10000) {
    return (v / 1000).toFixed(1) + 'k'
  }
  if (v < 1000000) {
    return Math.round(v / 1000) + 'k'
  }
  return (v / 1000000).toFixed(1) + 'M'
}

export function formatPercent (p) {
  if (p === null || p === undefined || !isFinite(p)) {
    return ''
  }
  // below 10% a whole number would just read as 0%
  return (p > 0 && p < 10 ? p.toFixed(1) : String(Math.round(p))) + '%'
}

export function getUsageLevel (percent) {
  if (percent === null || percent === undefined || !isFinite(percent)) {
    return 'unknown'
  }
  if (percent >= CONTEXT_DANGER_PERCENT) {
    return 'danger'
  }
  if (percent >= CONTEXT_WARN_PERCENT) {
    return 'warn'
  }
  return 'ok'
}
