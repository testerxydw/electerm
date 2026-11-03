/**
 * Runtime side of AI context compression.
 *
 * The pure decisions and message rewrites live in ai-auto-compress.js; this
 * module owns the parts that need the provider (the summary request) and the
 * store (whether the toggle is on, how big a stored session is, compressing it).
 * Both the agent loop and ask mode go through here so "too full" means the same
 * number in both.
 */

import { buildSessionMessages, summarizeContext } from './ai-context'
import { resolveImage } from './ai-image-cache'
import { appendMandatoryGuardrails } from './ai-guardrails'
import { buildAiRole } from '../../common/ai-role'
import {
  COMPRESS_SUMMARY_PROMPT,
  shouldAutoCompress
} from './ai-auto-compress'

// Read at the moment of the decision, not captured: the toggle can be flipped
// from the popover while a run is in flight.
export function autoCompressEnabled () {
  return !!(window.store && window.store.aiAutoCompress)
}

// A summary is read, not looked at. Picture parts are dropped from the copy
// that goes out: a few screenshots would cost thousands of tokens each and pull
// the summary toward the one turn that had one. The placeholder a missing
// picture already left behind in the text is kept, so the summary still knows a
// picture was part of the conversation.
function withoutImages (messages) {
  return (messages || []).map(m => {
    if (!m || !Array.isArray(m.content)) {
      return m
    }
    const text = m.content
      .map(p => {
        if (typeof p === 'string') {
          return p
        }
        return p && p.type === 'text' ? p.text : ''
      })
      .filter(Boolean)
      .join('\n\n')
    // never leave the turn empty: an image-only question would disappear from
    // the conversation the summary is supposed to describe
    return { ...m, content: text || '[image]' }
  })
}

// Ask the model for the summary that replaces a conversation. Goes through the
// plain chat path rather than the tool loop: this request only has to produce
// text, and giving it tools would let the summarizer act on the terminal while
// it is supposed to be reading. Returns '' when there is nothing usable, which
// callers read as "leave the conversation alone".
export async function summarizeMessages (messages, config = {}) {
  try {
    const result = await window.pre.runGlobalAsync(
      'AIchat',
      COMPRESS_SUMMARY_PROMPT,
      config.modelAI,
      config.roleAI,
      config.baseURLAI,
      config.apiPathAI,
      config.apiKeyAI,
      config.proxyAI,
      false,
      config.authHeaderNameAI,
      [...withoutImages(messages), { role: 'user', content: COMPRESS_SUMMARY_PROMPT }]
    )
    if (!result || result.error || !result.response) {
      return ''
    }
    return result.response
  } catch (error) {
    console.error('Error summarizing conversation:', error)
    return ''
  }
}

// How big the stored session is, i.e. what the next ask-mode turn would carry.
// Same figure the panel's own indicator shows (components/ai/ai-chat.jsx), minus
// agent tools, which only agent mode sends.
export function sessionContextInfo (sessionId, config = {}) {
  const store = window.store
  if (!sessionId || !store) {
    return null
  }
  const role = appendMandatoryGuardrails(buildAiRole(config, store.getLangName()))
  const messages = buildSessionMessages({
    history: store.aiChatHistory,
    chatSessionId: sessionId,
    role,
    // the pictures are part of what fills the window, so the auto-compress
    // decision has to see them -- otherwise a screenshots-only session never
    // triggers it
    resolveImage
  })
  if (!messages || messages.length < 2) {
    return null
  }
  return summarizeContext(messages, {
    model: config.modelAI,
    contextLength: store.config.contextLengthAI
  })
}

// Compact a stored session when the toggle is on and it is over the line.
// Called once a turn or a run is finished, so the *next* request starts from the
// summary instead of the full history. Returns true when it compressed.
export async function autoCompressSession (sessionId, config = {}) {
  if (!autoCompressEnabled() || !sessionId) {
    return false
  }
  if (!shouldAutoCompress(sessionContextInfo(sessionId, config))) {
    return false
  }
  try {
    await window.store.compressChatSession(sessionId)
    return true
  } catch (error) {
    console.error('Error auto compressing session:', error)
    return false
  }
}
