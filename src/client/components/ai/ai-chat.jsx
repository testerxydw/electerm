import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Flex, Input, Segmented, Button, Tag, Popover } from 'antd'
import message from '../common/message'
import TabSelect from '../footer/tab-select'
import AiChatHistory from './ai-chat-history'
import AiChatSessions from './ai-chat-sessions'
import AiContextIndicator from './ai-context-indicator'
import AiImageCapChip from './ai-image-cap-chip'
import {
  detectImageCapability,
  detectTransport,
  evaluateImageSend
} from './ai-image-capability'
import SwitchLabel from '../common/switch'
import { buildSessionMessages, summarizeContext, getUsageLevel } from './ai-context'
import { resolveImage, putImage, dropImage } from './ai-image-cache'
import { appendMandatoryGuardrails } from './ai-guardrails'
import { buildAiRole } from '../../common/ai-role'
import uid from '../../common/uid'
import { pick } from 'lodash-es'
import {
  SettingOutlined,
  SendOutlined,
  PlusOutlined,
  HistoryOutlined,
  CompressOutlined,
  PaperClipOutlined,
  CloseOutlined
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
import {
  isImageFile,
  extractPastedImages,
  normalizeImageFile,
  validateImageBudget,
  isDuplicateImage,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_SESSION_IMAGE_BYTES,
  IMAGE_MIMES
} from './ai-image-attachments'
import './ai.styl'

const { TextArea } = Input
const MAX_HISTORY = 500

// 文件选择的过滤器：图片走视觉通道，文本附件仍按老规矩（扩展名在部分系统上
// 不给 mime，所以带上几个常见后缀，不然选了 .sql 会被对话框直接藏掉）
const FILE_ACCEPT = [
  ...IMAGE_MIMES,
  'text/*',
  '.txt', '.md', '.log', '.sql', '.json', '.yaml', '.yml', '.csv', '.xml', '.sh'
].join(',')

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

  // 图片能力与发送通道：判定是猜的（没有标准接口能读模态），所以它只用来提示与
  // 拦一次发送，用户点「仍要发送」就能放行；见 ai-image-capability.js 的分层说明
  const imageCapability = useMemo(() => detectImageCapability({
    supportsImageAI: config.supportsImageAI,
    modelAI: config.modelAI,
    baseURLAI: config.baseURLAI
  }), [config.supportsImageAI, config.modelAI, config.baseURLAI])
  const imageTransport = useMemo(
    () => detectTransport(config.apiPathAI),
    [config.apiPathAI]
  )
  // 本次草稿的"仍要发送"确认：只对本条消息生效，发送后回到未确认状态，
  // 免得一次点头变成整个会话的默认放行
  const [imageAllowOnce, setImageAllowOnce] = useState(false)
  const imageSend = useMemo(() => evaluateImageSend({
    support: imageCapability.support,
    apiPath: config.apiPathAI,
    allowOnce: imageAllowOnce
  }), [imageCapability.support, config.apiPathAI, imageAllowOnce])

  // Size of the context the *next* message will carry: every entry of this
  // session, from the last compression onwards, built by the same helper the
  // sender uses. While an agent loop is running its own, much larger, figure
  // is published to the store (tool schemas and tool results included) and
  // takes precedence.
  const sessionContextInfo = useMemo(() => {
    if (!currentChatSessionId) {
      return null
    }
    const role = appendMandatoryGuardrails(
      buildAiRole(config, window.store.getLangName())
    )
    const messages = buildSessionMessages({
      history: props.aiChatHistory,
      chatSessionId: currentChatSessionId,
      role,
      // pictures count too: a few screenshots are thousands of tokens each
      resolveImage
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

  // 一批文件里可能图片、文本、别的都有，两条通道各走各的：图片进内存缓存并只把
  // 元数据留在草稿里，文本按老路径内联进 prompt。最后一次性提交 -- 分开 setAttachments
  // 的话后一次拿到的是旧的 attachments，先加的那批会被覆盖掉。
  async function handleFiles (files) {
    const list = Array.from(files || [])
    const problems = {
      notText: [],
      textTooBig: false,
      images: {
        unsupportedType: [],
        tooLarge: [],
        unreadable: [],
        count: false,
        bytes: false
      }
    }
    let next = attachments
    const imageFiles = list.filter(f => isImageFile(f))
    const otherFiles = list.filter(f => !isImageFile(f))
    if (imageFiles.length) {
      next = await addImages(next, imageFiles, problems.images)
    }
    if (otherFiles.length) {
      next = await addTextFiles(next, otherFiles, problems)
    }
    setAttachments(next)
    reportAttachmentProblems(problems)
  }

  async function addImages (current, files, problems) {
    let next = current
    for (const file of files) {
      const id = uid()
      const { attachment, error } = await normalizeImageFile(file, { id })
      if (error) {
        const bucket = error === 'unsupportedType'
          ? problems.unsupportedType
          : (error === 'tooLarge' ? problems.tooLarge : problems.unreadable)
        bucket.push(file.name)
        continue
      }
      if (isDuplicateImage(next, attachment)) {
        // 同一张图既在 files 里又在位图里（部分 Linux 截图工具会这样），收一次就够
        continue
      }
      const budget = validateImageBudget(
        next.filter(a => a.kind === 'image'),
        attachment.bytes,
        1
      )
      if (!budget.ok) {
        problems[budget.reason === 'count' ? 'count' : 'bytes'] = true
        continue
      }
      // 图片本体只进内存缓存。历史条目每来一段流式文本都会被整条重写并落库，
      // 几百 KB 的 base64 跟着走一遍是白花的磁盘与内存（见 ai-image-cache.js）。
      if (!putImage({
        id,
        dataUrl: attachment.dataUrl,
        bytes: attachment.bytes
      }).ok) {
        problems.bytes = true
        continue
      }
      const { dataUrl, ...meta } = attachment
      next = [...next, meta]
    }
    return next
  }

  async function addTextFiles (current, files, problems) {
    const next = [...current]
    for (const file of files) {
      // 先粗筛同名同尺寸（省一次读取），真正的去重看内容指纹：
      // 截图文件名几乎都是 image.png，只比 name+size 会误丢第二张
      const sameNameSize = next.some(
        a => a.kind !== 'image' && a.name === file.name && a.size === file.size
      )
      const { attachment, error } = await readTextAttachment(file)
      if (error === 'notTextFile') {
        problems.notText.push(file.name)
        continue
      }
      if (!attachment) {
        continue
      }
      const texts = next.filter(a => a.kind !== 'image')
      if (sameNameSize && isDuplicateAttachment(texts, attachment)) {
        continue
      }
      // 文本预算只算文本：图片按压缩后的 bytes 单独记（validateImageBudget）
      if (!validateAttachmentTotal(texts, file.size)) {
        problems.textTooBig = true
        continue
      }
      next.push(attachment)
    }
    return next
  }

  function reportAttachmentProblems (p) {
    if (p.textTooBig) {
      message.error(e('aiAttachmentTooBig'))
    }
    if (p.notText.length) {
      message.error(`${e('aiAttachmentTextOnly')}: ${p.notText.join(', ')}`)
    }
    const im = p.images
    if (im.count) {
      message.error(`${e('aiImageLimit')} (${MAX_IMAGES_PER_MESSAGE})`)
    }
    if (im.bytes) {
      message.error(`${e('aiImageTotalTooBig')} (${formatSize(MAX_SESSION_IMAGE_BYTES)})`)
    }
    if (im.unsupportedType.length) {
      message.error(`${e('aiImageUnsupportedType')}: ${im.unsupportedType.join(', ')}`)
    }
    if (im.tooLarge.length) {
      message.error(
        `${e('aiImageTooLarge')} (${formatSize(MAX_IMAGE_BYTES)}): ${im.tooLarge.join(', ')}`
      )
    }
    if (im.unreadable.length) {
      message.error(`${e('aiImageUnreadable')}: ${im.unreadable.join(', ')}`)
    }
  }

  // 粘贴：只有剪贴板里真有图时才接管，纯文字粘贴必须照旧落进 textarea
  function handlePaste (evt) {
    const files = extractPastedImages(evt.clipboardData)
    if (!files.length) {
      return
    }
    evt.preventDefault()
    handleFiles(files)
  }

  function removeAttachment (a) {
    if (a.kind === 'image') {
      // 草稿里删掉就释放缓存字节；已经发出去的那一轮靠历史条目和 LRU 预算兜住
      dropImage(a.id)
    }
    setAttachments(arr => arr.filter(x => x.id !== a.id))
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

    const images = isOverride ? [] : attachments.filter(a => a.kind === 'image')
    if (images.length && !imageSend.allowed) {
      // 拦在请求发出之前：把图发过去等 provider 回 400，用户只会看到一句看不懂的话
      message.warning(
        imageSend.reason === 'transport' ? e('aiImageTransportBlocked') : e('aiImageBlocked')
      )
      return
    }

    const chatId = uid()
    const texts = isOverride ? [] : attachments.filter(a => a.kind !== 'image')
    const block = buildAttachmentsBlock(texts)
    const promptWithAttachments = block
      ? (text.trim() ? text + '\n\n' + block : block)
      : text
    // 外部递交的那一句不带面板附件：附件属于输入框里的草稿，不是这次请求的输入
    const entryAttachments = texts.map(
      a => ({ name: a.name, size: a.size, truncated: a.truncated })
    )
    // 历史条目只记元数据：图片本体在内存缓存里，重开窗口即"已过期"；
    // 连着存缩略图也算了，一条几百字节的小 base64 在流式期间同样会被反复重写
    const entryImages = images.map(
      a => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        width: a.width,
        height: a.height,
        bytes: a.bytes
      })
    )
    const chatEntry = {
      prompt: text,
      promptWithAttachments,
      attachments: entryAttachments,
      images: entryImages,
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
      setImageAllowOnce(false)
    }

    // Keep the newest, not the oldest: the previous `slice(0, MAX_HISTORY)`
    // dropped the entry that had just been appended, so the 501st message of a
    // session was written to the store and then thrown away.
    if (window.store.aiChatHistory.length > MAX_HISTORY) {
      const all = window.store.aiChatHistory
      // the entries falling off the end take their picture bytes with them
      all.slice(0, all.length - MAX_HISTORY).forEach(
        e => (e.images || []).forEach(img => dropImage(img && img.id))
      )
      window.store.aiChatHistory = all.slice(-MAX_HISTORY)
    }
  }, [
    prompt, attachments, mode, currentChatSessionId, imageSend,
    // 配置快照按 _configVersion 换引用：漏了它，改完 AI 设置直接点发送仍会带上旧语言
    props.config
  ])

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
          <Flex align='center' gap={6} className='ai-image-cap-slot'>
            <AiImageCapChip
              support={imageCapability.support}
              source={imageCapability.source}
              transport={imageTransport}
              hasImages={attachments.some(a => a.kind === 'image')}
              onOpenConfig={toggleConfig}
            />
            <AiContextIndicator info={contextInfo} />
          </Flex>
        </Flex>
        {attachments.length > 0 && (
          <Flex wrap='wrap' gap={4} className='ai-chat-attachments mg1b'>
            {attachments.map(a => (a.kind === 'image'
              ? (
                <div
                  key={a.id}
                  className={'ai-image-card' + (imageSend.allowed ? '' : ' is-warn')}
                  title={`${a.name} (${formatSize(a.bytes)}${a.width ? `, ${a.width}×${a.height}` : ''})`}
                >
                  <img className='ai-image-thumb' src={a.thumbDataUrl} alt={a.name} />
                  <span className='ai-image-meta'>
                    <span className='ai-image-name'>{a.name}</span>
                    <span className='ai-image-size'>
                      {formatSize(a.bytes)}{a.width ? ` · ${a.width}×${a.height}` : ''}
                    </span>
                  </span>
                  <CloseOutlined
                    className='ai-image-remove pointer'
                    onClick={() => removeAttachment(a)}
                  />
                </div>
                )
              : (
                <Tag
                  key={a.id}
                  closable
                  onClose={() => removeAttachment(a)}
                  title={`${a.name} (${formatSize(a.size)})`}
                >
                  <PaperClipOutlined /> {a.name}
                </Tag>
                )))}
          </Flex>
        )}
        {/*
          带图却被拦时把话说明白，并给两条出路：能力判错可以"仍要发送"（只对本次生效），
          通道不对时连"仍要发送"都不给——图会在构造请求体时被压成文本，点头也救不回来
        */}
        {attachments.some(a => a.kind === 'image') && !imageSend.allowed && (
          <Flex align='center' gap={8} wrap className='ai-image-blocked mg1b'>
            <span className='ai-image-blocked-text'>
              {imageSend.reason === 'transport'
                ? e('aiImageTransportBlocked')
                : e('aiImageBlocked')}
            </span>
            {imageSend.reason === 'capability' && (
              <Button
                size='small'
                className='ai-image-send-anyway'
                onClick={() => setImageAllowOnce(true)}
              >
                {e('aiImageSendAnyway')}
              </Button>
            )}
            <Button
              size='small'
              type='link'
              className='ai-image-go-settings'
              onClick={toggleConfig}
            >
              {e('aiImageGoSettings')}
            </Button>
          </Flex>
        )}
        <TextArea
          value={prompt}
          onChange={handlePromptChange}
          onPaste={handlePaste}
          onPressEnter={handleKeyPress}
          placeholder='Enter your prompt here'
          autoSize={{ minRows: 3, maxRows: 10 }}
          className='ai-chat-textarea'
        />
        <input
          type='file'
          multiple
          accept={FILE_ACCEPT}
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
