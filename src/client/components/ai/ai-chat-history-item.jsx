import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import AIOutput from './ai-output'
import AIStopIcon from './ai-stop-icon'
import AgentToolCallCard from './agent-tool-call-card'
import { runAgentLoop, stopAgentRun } from './agent'
import { appendMandatoryGuardrails } from './ai-guardrails'
import { buildAiRole } from '../../common/ai-role'
import { buildSessionMessages, summarizeContext, countContextImages, isImageRequestRejected, stripImageParts } from './ai-context'
import Modal from '../common/modal'
import { resolveImage } from './ai-image-cache'
import {
  shouldAutoCompress,
  canCompact,
  splitPendingTurn,
  compactAskMessages
} from './ai-auto-compress'
import { summarizeMessages, autoCompressSession, autoCompressEnabled } from './ai-compress'
import {
  Alert,
  Tooltip,
  Tag
} from 'antd'
import {
  CopyOutlined,
  CloseOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
  CompressOutlined,
  PaperClipOutlined,
  FileImageOutlined
} from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import { formatSize } from './ai-attachments'

// memo()'d: the panel holds the draft prompt in its own state, so every
// keystroke re-renders the whole transcript. Without this the keystroke also
// re-rendered (and re-parsed the markdown of) every message in it -- 50ms+ per
// character in a long agent session. Entries are updated immutably
// (store.updateAiHistoryEntry), so the reference comparison is meaningful.
export default memo(function AIChatHistoryItem ({ item }) {
  const [showOutput, setShowOutput] = useState(true)
  const [isStreaming, setIsStreaming] = useState(false)
  // `current` is the stop flag; `requestId` is the HTTP request currently in
  // flight (agent mode), so that stopping can cancel it rather than wait for it
  // to come back.
  const abortRef = useRef(false)
  // 组件卸载守卫：流式轮询链（递归 setTimeout）在条目卸载后必须终止，
  // 否则 AI 会话多时幽灵轮询叠加（每次卸载残留一条 200ms 链直到流结束）
  const aliveRef = useRef(true)
  useEffect(() => {
    return () => {
      aliveRef.current = false
    }
  }, [])
  const {
    prompt,
    sessionId,
    chatSessionId,
    nameAI,
    modelAI,
    roleAI,
    baseURLAI,
    apiPathAI,
    apiKeyAI,
    proxyAI,
    authHeaderNameAI,
    languageAI,
    mode,
    toolCalls,
    autoCompressCount
  } = item

  function toggleOutput () {
    setShowOutput(!showOutput)
  }

  function buildRole () {
    return appendMandatoryGuardrails(buildAiRole(item, window.store.getLangName()))
  }

  // The context this turn sends: the session history up to and including the
  // previous turns, but not this turn's own (still streaming) response.
  // Shared with the context size indicator in ai-chat.jsx so the number shown
  // is built from the same message list that goes out. `resolveImage` is what
  // turns an entry's image metadata into the picture parts of this turn, so a
  // screenshot the user pasted last turn is still sent to the model now.
  const conversationMessages = useMemo(() => buildSessionMessages({
    history: window.store.aiChatHistory,
    chatSessionId,
    upto: item.timestamp,
    role: buildRole(),
    excludeId: item.id,
    resolveImage
  }), [chatSessionId, item.id, item.timestamp])

  // Everything a request needs beyond the message list; also what the
  // compressor uses to reach the same provider (see ai-compress.js).
  const requestConfig = useMemo(() => ({
    modelAI,
    roleAI,
    baseURLAI,
    apiPathAI,
    apiKeyAI,
    proxyAI,
    languageAI,
    authHeaderNameAI
  }), [
    modelAI,
    roleAI,
    baseURLAI,
    apiPathAI,
    apiKeyAI,
    proxyAI,
    languageAI,
    authHeaderNameAI
  ])

  // The message list this turn actually sends. Normally the memoized session
  // messages above, but when auto compress is on and the request would not fit
  // the window, the earlier turns are replaced by a summary first. The live
  // prompt survives untouched -- it is the question being answered, not
  // history. The stored session is compacted separately once the answer is in
  // (autoCompressSession below), so this is only about the request leaving now.
  const buildOutgoingMessages = useCallback(async () => {
    if (!autoCompressEnabled() || !conversationMessages) {
      return conversationMessages
    }
    const info = summarizeContext(conversationMessages, {
      model: modelAI,
      contextLength: window.store.config.contextLengthAI
    })
    if (!shouldAutoCompress(info)) {
      return conversationMessages
    }
    const { context } = splitPendingTurn(conversationMessages)
    if (!canCompact(context)) {
      return conversationMessages
    }
    // Marked before the request: summarizing a nearly full window takes a
    // while, and the badge is the only sign that this turn is waiting on it.
    // Cleared again if the summary comes back unusable.
    window.store.updateAiHistoryEntry(item.id, { autoCompressCount: 1 })
    const summary = await summarizeMessages(context, requestConfig)
    if (!summary) {
      window.store.updateAiHistoryEntry(item.id, { autoCompressCount: 0 })
      return conversationMessages
    }
    return compactAskMessages(conversationMessages, summary)
  }, [conversationMessages, modelAI, requestConfig, item.id])

  const pollStreamContent = useCallback(async (sid) => {
    // 卸载后停止轮询链：不再写 store/setState
    if (!aliveRef.current) {
      return
    }
    try {
      const streamResponse = await window.pre.runGlobalAsync('getStreamContent', sid)

      if (streamResponse && streamResponse.error) {
        if (streamResponse.error === 'Session not found') {
          return
        }
        window.store.removeAiHistory(item.id)
        return window.store.onError(new Error(streamResponse.error))
      }

      window.store.updateAiHistoryEntry(item.id, {
        response: streamResponse.content || ''
      })
      setIsStreaming(streamResponse.hasMore)
      if (streamResponse.hasMore) {
        setTimeout(() => pollStreamContent(sid), 200)
      } else {
        // The answer is in the store now, so the session can be summarized for
        // the turns that follow this one.
        autoCompressSession(chatSessionId, requestConfig)
      }
    } catch (error) {
      window.store.removeAiHistory(item.id)
      window.store.onError(error)
    }
  }, [item.id, chatSessionId, requestConfig])

  // 响应到手之后走哪条通道：流式就轮询，一次性就把答案写回去。
  // 降级重发也走这里，所以单独提出来，避免把"重发"写成第二份成功分支。
  const applyResponse = useCallback((aiResponse) => {
    if (aiResponse && aiResponse.isStream && aiResponse.sessionId) {
      setIsStreaming(true)
      window.store.updateAiHistoryEntry(item.id, {
        sessionId: aiResponse.sessionId,
        response: aiResponse.content || ''
      })
      pollStreamContent(aiResponse.sessionId)
    } else if (aiResponse && aiResponse.response) {
      window.store.updateAiHistoryEntry(item.id, {
        response: aiResponse.response
      })
      // No stream to poll: the answer is in the store, so the session can be
      // summarized for the turns that follow this one.
      autoCompressSession(chatSessionId, requestConfig)
    }
  }, [item.id, chatSessionId, requestConfig, pollStreamContent])

  const startRequest = useCallback(async (messagesOverride) => {
    try {
      // 降级重发带着已经构造好的消息回来；首次发送才现算
      const messages = messagesOverride || await buildOutgoingMessages()
      const aiResponse = await window.pre.runGlobalAsync(
        'AIchat',
        prompt,
        modelAI,
        buildRole(),
        baseURLAI,
        apiPathAI,
        apiKeyAI,
        proxyAI,
        true,
        authHeaderNameAI,
        messages
      )

      if (aiResponse && aiResponse.error) {
        // 带图请求被 provider 以 400 拒掉时，先给一次"去掉图重发"的机会：
        // 各网关对 content 数组的支持差异很大，直接报错用户无从判断是自己
        // 的配置还是图片的问题（S2-3 / 设计 §6-14）。只给一次，重发时不再问。
        if (!messagesOverride &&
          isImageRequestRejected(aiResponse.error) &&
          countContextImages(messages) > 0) {
          Modal.confirm({
            title: window.translate('aiImageFallbackTitle'),
            content: window.translate('aiImageFallbackText'),
            okText: window.translate('aiImageFallbackOk'),
            cancelText: window.translate('cancel'),
            onOk: () => startRequest(stripImageParts(messages)),
            onCancel: () => {
              window.store.removeAiHistory(item.id)
              window.store.onError(new Error(aiResponse.error))
            }
          })
          return
        }
        window.store.removeAiHistory(item.id)
        return window.store.onError(new Error(aiResponse.error))
      }

      applyResponse(aiResponse)
    } catch (error) {
      window.store.removeAiHistory(item.id)
      window.store.onError(error)
    }
  }, [prompt, modelAI, baseURLAI, apiPathAI, apiKeyAI, proxyAI, authHeaderNameAI, item.id, chatSessionId, requestConfig, buildOutgoingMessages, applyResponse])

  const startAgentRequest = useCallback(async () => {
    abortRef.current = false
    abortRef.requestId = null
    await runAgentLoop(item, requestConfig, abortRef, setIsStreaming, conversationMessages)
  }, [item, requestConfig, conversationMessages])

  useEffect(() => {
    if (item.pending) {
      window.store.updateAiHistoryEntry(item.id, { pending: false })
      if (mode === 'agent') {
        startAgentRequest()
      } else {
        startRequest()
      }
    }
  }, [])

  async function handleStop (e) {
    e.stopPropagation()
    if (mode === 'agent') {
      setIsStreaming(false)
      await stopAgentRun(abortRef)
      return
    }
    if (!sessionId) return

    try {
      await window.pre.runGlobalAsync('stopStream', sessionId)
      setIsStreaming(false)
    } catch (error) {
      console.error('Error stopping stream:', error)
    }
  }

  function renderStopButton () {
    if (!isStreaming) {
      return null
    }
    return (
      <AIStopIcon
        onClick={handleStop}
        title='Stop this AI request'
      />
    )
  }

  const alertProps = {
    title: (
      <div className='ai-history-item-title'>
        <span className='pointer mg1r' onClick={toggleOutput}>
          {showOutput ? <CaretDownOutlined /> : <CaretRightOutlined />}
        </span>
        <span>{prompt}</span>
      </div>
    ),
    type: 'info'
  }

  function handleDel (e) {
    e.stopPropagation()
    window.store.removeAiHistory(item.id)
  }

  function handleCopy () {
    copy(prompt)
  }

  function renderTitle () {
    return (
      <div>
        {nameAI && (
          <p>
            <b>Name:</b> {nameAI}
          </p>
        )}
        <p>
          <b>Model:</b> {modelAI}
        </p>
        <p>
          <b>Role:</b> {roleAI}
        </p>
        <p>
          <b>Base URL:</b> {baseURLAI}
        </p>
        <p>
          <b>Time:</b> {new Date(item.timestamp).toLocaleString()}
        </p>
        <p>
          <CopyOutlined
            className='pointer'
            onClick={handleCopy}
          />
          <CloseOutlined
            className='pointer mg1l'
            onClick={handleDel}
          />
        </p>
      </div>
    )
  }

  function renderAttachments () {
    const images = item.images || []
    const files = item.attachments || []
    if (!images.length && !files.length) {
      return null
    }
    const e = window.translate
    // 历史里只留元数据（名字/尺寸/体积），图本身在内存缓存。重启后缓存空了：
    // 缩略图没有、后续发送也只会带占位符，所以这里明确标灰并给出原因，
    // 而不是让一条“看起来带图”的记录骗人
    return (
      <div className='ai-chat-item-attachments mg1b'>
        <div className='ai-image-attachments'>
          {images.map(img => {
            const name = String((img && img.name) || 'image')
            const live = !!(img && img.id && resolveImage(img.id))
            const dims = img && img.width && img.height
              ? `${img.width}×${img.height} · ${formatSize(img.bytes)}`
              : formatSize(img && img.bytes)
            return (
              <span
                key={'img-' + (img.id || name)}
                className={'ai-image-card' + (live ? '' : ' is-expired')}
                title={live
                  ? `${name} (${dims})`
                  : `${name} (${dims}) — ${e('aiImageExpired')}`}
              >
                <FileImageOutlined />
                <span className='ai-image-meta'>
                  <span className='ai-image-name'>{name}</span>
                  <span className='ai-image-size'>{dims}</span>
                </span>
              </span>
            )
          })}
        </div>
        {files.map(a => (
          <Tag key={a.name + a.size} title={`${a.name} (${formatSize(a.size)})`}>
            <PaperClipOutlined /> {a.name}
          </Tag>
        ))}
      </div>
    )
  }

  // Auto compress happens on its own, with no visible step of its own, so the
  // turn says so: the conversation was summarized and the request continued
  // from the summary instead of the full history. Ask mode summarizes before
  // sending, agent mode in the middle of the run (possibly more than once).
  function renderAutoCompressBadge () {
    if (!autoCompressCount) {
      return null
    }
    return (
      <div className='ai-auto-compress-badge mg1b'>
        <Tag
          color='blue'
          title='The context filled up and was summarized automatically, this turn continued from the summary'
        >
          <CompressOutlined /> {window.translate('autoCompress')}
          {autoCompressCount > 1 ? ` x${autoCompressCount}` : ''}
        </Tag>
      </div>
    )
  }

  function renderToolCalls () {
    if (mode !== 'agent' || !toolCalls || !toolCalls.length) {
      return null
    }
    return (
      <div className='agent-tool-calls'>
        {toolCalls.map((tc) => (
          <AgentToolCallCard key={tc.id} toolCall={tc} autoCollapse={!isStreaming} />
        ))}
      </div>
    )
  }

  return (
    <div className='chat-history-item'>
      <div className='mg1y'>
        <Tooltip title={renderTitle()}>
          <Alert {...alertProps} />
        </Tooltip>
      </div>
      {renderAttachments()}
      {renderAutoCompressBadge()}
      {renderToolCalls()}
      {showOutput && <AIOutput item={item} />}
      {renderStopButton()}
    </div>
  )
})
