import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Flex, Input, Segmented, Button, Tag, message, Popover } from 'antd'
import TabSelect from '../footer/tab-select'
import AiChatHistory from './ai-chat-history'
import AiChatSessions from './ai-chat-sessions'
import AiContextIndicator from './ai-context-indicator'
import SwitchLabel from '../common/switch'
import { buildSessionMessages, summarizeContext, getUsageLevel } from './ai-context'
import { appendMandatoryGuardrails } from './ai-guardrails'
import uid from '../../common/uid'
import { pick } from 'lodash-es'
import {
  SettingOutlined,
  SendOutlined,
  PlusOutlined,
  HistoryOutlined,
  CompressOutlined,
  PaperClipOutlined
} from '@ant-design/icons'
import {
  aiConfigWikiLink,
  aiChatModeLsKey
} from '../../common/constants'
import { getItem, setItem } from '../../common/safe-local-storage.js'
import HelpIcon from '../common/help-icon'
import { refsStatic } from '../common/ref'
import {
  readTextAttachment,
  validateAttachmentTotal,
  buildAttachmentsBlock,
  isDuplicateAttachment,
  formatSize
} from './ai-attachments'
import './ai.styl'

const { TextArea } = Input
const MAX_HISTORY = 500

export default function AIChat (props) {
  const [prompt, setPrompt] = useState('')
  const [compressing, setCompressing] = useState(false)
  const [attachments, setAttachments] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)
  const [mode, setMode] = useState(() => getItem(aiChatModeLsKey) || 'ask')
  const isAgent = mode === 'agent'
  const autoCompress = !!props.aiAutoCompress
  const submitDisabled = isAgent && props.agentRunning

  const currentChatSessionId = props.currentChatSessionId || ''

  useEffect(() => {
    if (!currentChatSessionId && props.rightPanelTab === 'ai') {
      window.store.startNewChat()
    }
  }, [currentChatSessionId, props.rightPanelTab])

  // Memoized on purpose: `prompt` lives in this component's state, so every
  // keystroke re-renders it. `AIChatHistory` is memo()'d, and a fresh array on
  // each keystroke defeated that -- which also meant its scroll-to-bottom
  // layout effect re-ran while typing, yanking the view down mid-scroll.
  // Entries are updated immutably, so a new array identity really does mean
  // the transcript changed.
  const sessionHistory = useMemo(
    () => (props.aiChatHistory || []).filter(
      h => h.chatSessionId === currentChatSessionId
    ),
    [props.aiChatHistory, currentChatSessionId]
  )

  const config = props.config || {}

  // Size of the context the *next* message will carry: every entry of this
  // session, from the last compression onwards, built by the same helper the
  // sender uses. While an agent loop is running its own, much larger, figure
  // is published to the store (tool schemas and tool results included) and
  // takes precedence.
  const sessionContextInfo = useMemo(() => {
    if (!currentChatSessionId) {
      return null
    }
    const lang = config.languageAI || window.store.getLangName()
    const role = appendMandatoryGuardrails(
      (config.roleAI || '') + `;用[${lang}]回复`
    )
    const messages = buildSessionMessages({
      history: props.aiChatHistory,
      chatSessionId: currentChatSessionId,
      role
    })
    if (!messages || messages.length < 2) {
      return null
    }
    return summarizeContext(messages, {
      model: config.modelAI,
      contextLength: config.contextLengthAI
    })
  }, [
    props.aiChatHistory,
    // length as well as identity: sending a message pushes onto the existing
    // array, so the reference alone would not change
    props.aiChatHistory.length,
    currentChatSessionId,
    config.roleAI,
    config.languageAI,
    config.modelAI,
    config.contextLengthAI
  ])

  const contextInfo = props.aiContextInfo || sessionContextInfo
  const contextLevel = getUsageLevel(contextInfo && contextInfo.percent)

  function handlePromptChange (e) {
    setPrompt(e.target.value)
  }

  function handleModeChange (val) {
    const m = val === 'Ask' ? 'ask' : 'agent'
    setItem(aiChatModeLsKey, m)
    setMode(m)
  }

  const e = window.translate

  async function handleFiles (files) {
    const notText = []
    let totalTooLarge = false
    const next = [...attachments]
    for (const file of Array.from(files)) {
      // 先粗筛同名同尺寸（省一次读取），真正的去重看内容指纹：
      // 截图文件名几乎都是 image.png，只比 name+size 会误丢第二张
      const sameNameSize = next.some(a => a.name === file.name && a.size === file.size)
      const { attachment, error } = await readTextAttachment(file)
      if (error === 'notTextFile') {
        notText.push(file.name)
        continue
      }
      if (!attachment) {
        continue
      }
      if (sameNameSize && isDuplicateAttachment(next, attachment)) {
        continue
      }
      if (!validateAttachmentTotal(next, file.size)) {
        totalTooLarge = true
        continue
      }
      next.push(attachment)
    }
    setAttachments(next)
    if (totalTooLarge) {
      message.error(e('aiAttachmentTooBig'))
    }
    if (notText.length) {
      message.error(`${e('aiAttachmentTextOnly')}: ${notText.join(', ')}`)
    }
  }

  // `overridePrompt` is the "send this text, not what is in the box" path: an
  // external caller (terminal, database page) hands the panel a finished prompt.
  // Passing the text in -- instead of setPrompt-then-submit -- is what removes
  // the timer guessing: the old callers waited 500ms and 1200ms for the panel to
  // mount and lost the message whenever the panel won the race later. The draft
  // in the box is deliberately left alone, because it is not this request's
  // input and wiping it would cost the user their typing.
  const handleSubmit = useCallback(function (overridePrompt) {
    const isOverride = typeof overridePrompt === 'string'
    const text = isOverride ? overridePrompt : prompt
    if (window.store.aiConfigMissing()) {
      window.store.toggleAIConfig()
    }
    // Read the live flag rather than the rendered one. `submitDisabled` can be
    // stale: the loop sets `agentRunning` from the new turn's mount effect, and
    // manate's `auto` re-subscribes its listener on every render, so a write
    // landing in that window never reaches the panel -- leaving the icon looking
    // enabled while a run is in flight, which let a second agent turn through.
    if (isAgent && window.store.agentRunning) return
    if (!text.trim() && !(isOverride ? '' : attachments.length)) return

    const chatId = uid()
    const block = isOverride ? '' : buildAttachmentsBlock(attachments)
    const promptWithAttachments = block
      ? (text.trim() ? text + '\n\n' + block : block)
      : text
    // 外部递交的那一句不带面板附件：附件属于输入框里的草稿，不是这次请求的输入
    const entryAttachments = isOverride
      ? []
      : attachments.map(a => ({ name: a.name, size: a.size, truncated: a.truncated }))
    const chatEntry = {
      prompt: text,
      promptWithAttachments,
      attachments: entryAttachments,
      response: '',
      isStreaming: false,
      pending: true,
      sessionId: null,
      chatSessionId: currentChatSessionId,
      mode,
      toolCalls: [],
      ...pick(props.config, [
        'nameAI',
        'modelAI',
        'roleAI',
        'baseURLAI',
        'apiPathAI',
        'apiKeyAI',
        'proxyAI',
        'languageAI',
        'authHeaderNameAI',
        // 能力位跟着条目存：历史重放时用的是"当时那次发送"的判定口径，
        // 用户事后把 off 改成 on 不该让已经发过的条目换个说法
        'supportsImageAI'
      ]),
      timestamp: Date.now(),
      id: chatId
    }

    // Reassign rather than push: the store only notifies on a property write,
    // and the transcript is keyed off the array identity.
    window.store.aiChatHistory = [...window.store.aiChatHistory, chatEntry]
    if (!isOverride) {
      setPrompt('')
      setAttachments([])
    }

    // Keep the newest, not the oldest: the previous `slice(0, MAX_HISTORY)`
    // dropped the entry that had just been appended, so the 501st message of a
    // session was written to the store and then thrown away.
    if (window.store.aiChatHistory.length > MAX_HISTORY) {
      window.store.aiChatHistory = window.store.aiChatHistory.slice(-MAX_HISTORY)
    }
  }, [prompt, attachments, mode, currentChatSessionId])

  // 外部递交过来的 prompt（终端"解释输出"/数据库页"AI 解释"）。
  // 由面板在拿到它的这一次渲染里消费，而不是让调用方猜面板挂载要多久：
  // nonce 保证同一份递交只发一次，切走再回来不会重复发。
  const pendingConsumedRef = useRef(0)
  useEffect(() => {
    const p = props.pendingAiPrompt
    if (!p || !p.text || p.nonce === pendingConsumedRef.current) {
      return
    }
    pendingConsumedRef.current = p.nonce
    // 消费即清：面板切走再切回来（重新挂载）不该把同一段话再发一遍
    if (window.store.pendingAiPrompt === p) {
      window.store.pendingAiPrompt = null
    }
    if (p.autoSubmit) {
      handleSubmit(p.text)
    } else {
      setPrompt(p.text)
    }
  }, [props.pendingAiPrompt, handleSubmit])

  function renderHistory () {
    if (props.showChatSessions) {
      return (
        <AiChatSessions
          sessions={window.store.getChatSessions()}
          currentChatSessionId={currentChatSessionId}
          onLoadSession={(sid) => window.store.loadChatSession(sid)}
          onDeleteSession={(sid) => window.store.deleteChatSession(sid)}
          onClearAll={() => window.store.clearAllChatSessions()}
        />
      )
    }
    return (
      <AiChatHistory
        history={sessionHistory}
      />
    )
  }

  function toggleConfig () {
    window.store.toggleAIConfig()
  }

  function handleNewChat () {
    window.store.startNewChat()
  }

  async function handleCompressSession () {
    setCompressing(true)
    try {
      await window.store.compressChatSession(currentChatSessionId)
    } finally {
      setCompressing(false)
    }
  }

  function handleAutoCompressChange (val) {
    window.store.setAiAutoCompress(val)
  }

  // The toolbar button is the auto compress button: the popover behind it holds
  // the persistent toggle plus the manual compress action, so one button covers
  // both "keep this session small for me" and "compact it right now".
  function renderAutoCompressPopover () {
    return (
      <div className='ai-auto-compress-popover'>
        <Flex align='center' justify='space-between' gap={12}>
          <span className='ai-auto-compress-label'>{e('autoCompress')}</span>
          <SwitchLabel
            checked={autoCompress}
            onChange={handleAutoCompressChange}
            size='small'
          />
        </Flex>
        <hr />
        <Flex vertical gap={4} align='flex-start'>
          <Button
            size='small'
            icon={<CompressOutlined />}
            onClick={handleCompressSession}
            loading={compressing}
            disabled={sessionHistory.length < 2}
            type={contextLevel === 'warn' || contextLevel === 'danger' ? 'primary' : 'default'}
          >
            {e('compress')}
          </Button>
        </Flex>
      </div>
    )
  }

  function handleShowHistory () {
    window.store.toggleChatSessions()
  }

  function renderTabSelect () {
    if (isAgent) {
      return null
    }
    return (
      <TabSelect
        selectedTabIds={props.selectedTabIds}
        tabs={props.tabs}
        activeTabId={props.activeTabId}
      />
    )
  }

  function renderSendIcon () {
    if (submitDisabled) {
      return (
        <SendOutlined
          className='mg1l send-to-ai-icon disabled'
          title='Agent is running, please wait'
        />
      )
    }
    return (
      <SendOutlined
        onClick={handleSubmit}
        className='mg1l pointer icon-hover send-to-ai-icon'
        title='Enter to send, Shift+Enter for new line'
      />
    )
  }

  useEffect(() => {
    refsStatic.add('AIChat', {
      setPrompt,
      handleSubmit
    })
    return () => {
      refsStatic.remove('AIChat')
    }
  }, [handleSubmit])

  if (props.rightPanelTab !== 'ai') {
    return null
  }

  const handleKeyPress = (evt) => {
    // 输入法组字中的回车是"选定候选词"，不是"发送"。以前只看 shiftKey，
    // 中文/日文输入法定词时按回车会把半截 prompt 直接发出去。
    if (evt.nativeEvent && (evt.nativeEvent.isComposing || evt.keyCode === 229)) {
      return
    }
    if (!evt.shiftKey) {
      evt.preventDefault()
      if (!submitDisabled) {
        handleSubmit()
      }
    }
  }
  return (
    <Flex
      vertical
      className={'ai-chat-container' + (dragOver ? ' ai-attachment-dragover' : '')}
      onDragOver={(evt) => {
        evt.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(evt) => {
        setDragOver(false)
        if (!evt.dataTransfer.files.length) {
          return
        }
        evt.preventDefault()
        handleFiles(evt.dataTransfer.files)
      }}
    >
      <Flex className='ai-chat-history' flex='auto'>
        {renderHistory()}
      </Flex>

      <Flex vertical className='ai-chat-input'>
        <Flex className='ai-chat-toolbar mg1b' align='center' justify='space-between' gap={4}>
          <Flex align='center' gap={4}>
            <Button
              size='small'
              icon={<PlusOutlined />}
              onClick={handleNewChat}
              className='new-chat-btn'
            >
              {e('new')}
            </Button>
            <Popover
              content={renderAutoCompressPopover()}
              trigger='click'
              placement='topLeft'
            >
              <Button
                size='small'
                icon={<CompressOutlined />}
                type={autoCompress ? 'primary' : 'default'}
                danger={!autoCompress && contextLevel === 'danger'}
              >
                {e('autoCompress')}
              </Button>
            </Popover>
            <Button
              size='small'
              icon={<HistoryOutlined />}
              onClick={handleShowHistory}
              type={props.showChatSessions ? 'primary' : 'default'}
            >
              {e('history')}
            </Button>
          </Flex>
          <AiContextIndicator info={contextInfo} />
        </Flex>
        {attachments.length > 0 && (
          <Flex wrap='wrap' gap={4} className='ai-chat-attachments mg1b'>
            {attachments.map(a => (
              <Tag
                key={a.id}
                closable
                onClose={() => setAttachments(arr => arr.filter(x => x.id !== a.id))}
                title={`${a.name} (${formatSize(a.size)})`}
              >
                <PaperClipOutlined /> {a.name}
              </Tag>
            ))}
          </Flex>
        )}
        <TextArea
          value={prompt}
          onChange={handlePromptChange}
          onPressEnter={handleKeyPress}
          placeholder='Enter your prompt here'
          autoSize={{ minRows: 3, maxRows: 10 }}
          className='ai-chat-textarea'
        />
        <input
          type='file'
          multiple
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={(evt) => {
            handleFiles(evt.target.files)
            evt.target.value = ''
          }}
        />
        <Flex className='ai-chat-terminals' justify='space-between' align='center'>
          <Flex align='center'>
            <Segmented
              options={['Ask', 'Agent']}
              value={mode === 'ask' ? 'Ask' : 'Agent'}
              onChange={handleModeChange}
              size='small'
            />
            {renderTabSelect()}
            <PaperClipOutlined
              onClick={() => fileInputRef.current?.click()}
              className='mg1l pointer icon-hover toggle-ai-attach-icon'
            />
            <SettingOutlined
              onClick={toggleConfig}
              className='mg1l pointer icon-hover toggle-ai-setting-icon'
            />
            <HelpIcon
              link={aiConfigWikiLink}
            />
          </Flex>
          {renderSendIcon()}
        </Flex>
      </Flex>
      {window.et.AIDisclamer && (
        <div className='ai-disclamer mg1t'>{window.et.AIDisclamer}</div>
      )}
    </Flex>
  )
}
