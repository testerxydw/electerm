import { PureComponent, createRef } from 'react'
import { createTerm } from '../terminal/terminal-apis'
import deepCopy from 'json-deep-copy'
import clone from '../../common/to-simple-obj'
import { handleErr } from '../../common/fetch'
import {
  statusMap
} from '../../common/constants'
import {
  Select
} from 'antd'
import SwitchLabel from '../common/switch'
import message from '../common/message'
import { showErrorModal } from '../common/error-modal'
import Modal from '../common/modal'
import { copy, readClipboard } from '../../common/clipboard'
import VncForm from './vnc-form'
import SessionShell from '../common/session-shell'
import * as ls from '../../common/safe-local-storage'
import {
  RESIZE_MERGE_MS,
  resolveScaleViewport,
  shouldReLayout
} from '../../common/remote-adapt'
import './vnc.styl'

// noVNC module imports — loaded dynamically
async function loadVncModule () {
  if (window.novnc) return
  console.debug('[VNC-CLIENT] Loading noVNC module...')
  const mod = await import('@novnc/novnc')
  window.novnc = {
    RFB: mod.default
  }
  console.debug('[VNC-CLIENT] noVNC module loaded')
}

// noVNC keeps the reason a connection failed to itself: `_fail()` writes it to
// its own logger and the `disconnect` event carries only `{ clean }`, so a
// failed VNC connection is otherwise just a red status dot with no explanation.
// Keep the last reason so the UI can say what went wrong.
function captureFailure (rfb, onFail) {
  const fail = rfb._fail
  rfb._fail = function (details) {
    onFail(details)
    return fail.call(this, details)
  }
}

const { Option } = Select
const e = window.translate

// 本机逐 host 的缩放开关记忆（与 rdp-scale-view- / spice-scale-view- 同一命名）
const scaleViewportLsKey = (host) => `vnc-scale-view-${host}`

// "Connection closed (code: 4000, reason: connect ECONNREFUSED …)" — the
// wrapper is noise once the reason itself is on screen
function shortReason (reason) {
  const m = /^Connection closed \(code: [0-9]+(?:, reason: (.*))?\)$/.exec(reason)
  return (m && m[1]) || reason
}

// "Unsupported security types" is only reachable when the server offers nothing
// the client implements — in practice RealVNC's RA2 (5), which no open-source
// client can do (the RealVNC Server on older Raspberry Pi OS images offers it,
// and nothing else). The type list alone is not actionable, so suggest the one
// thing that works. Empty when there is nothing specific to say.
function failureHint (reason) {
  const m = /Unsupported security types \(types: ([0-9,]+)\)/.exec(shortReason(reason))
  if (!m) {
    return ''
  }
  const ra2 = m[1].split(',').includes('5')
    ? "RealVNC's RA2 is not supported; "
    : ''
  return ra2 + 'enable "VNC password" authentication on the server.'
}

export default class VncSession extends PureComponent {
  constructor (props) {
    // 缩放优先级与 RDP/SPICE 同一口径（R1/R3）：本机逐 host 记忆 > 书签字段
    // （含 profile 合并）> 默认开。原来只有书签这一层，会话内改不了
    const scaleViewport = resolveScaleViewport(
      ls.getItemJSON(scaleViewportLsKey(props.tab?.host), null),
      window.store.applyProfile(deepCopy(props.tab || {})).scaleViewport
    )
    super(props)
    this.state = {
      types: [],
      showConfirm: false,
      loading: false,
      name: '',
      screens: [],
      currentScreen: '0',
      scaleViewport,
      failure: ''
    }
  }

  domRef = createRef()

  // clipboard sync state (local -> remote direction)
  lastClip = null
  vncViewOnly = false
  // why the last connection attempt failed, see captureFailure()
  vncFailureReason = ''

  componentDidMount () {
    this.remoteInit()
  }

  // 断开并把显存交还系统。卸载和原地重连（handleReInit）必须走同一份实现：
  // 重连只做 disconnect 的话，旧实例的可见 canvas + 隐藏 backbuffer 要等 GC 才还，
  // 点一次重连就多留两份帧缓冲，看上去就是"重连之后内存反而涨了"。
  _releaseRfb = () => {
    const rfb = this.rfb
    if (rfb) {
      // noVNC 的 disconnect 只是把 _screen（含 canvas）从挂载点摘下来，
      // backing store 要等 GC 才归还；先归零可以让显存立刻释放。
      // 两块都要归零：可见 canvas 之外，显示层还有一个同尺寸的隐藏 canvas
      // （_display._backbuffer，渲染时 drawImage 到可见层），它同样占一份
      // 帧缓冲大小的显存（实测 2048x1152 时约 9MB）。
      const canvases = [rfb._canvas, rfb._display && rfb._display._backbuffer]
      for (const canvas of canvases) {
        if (canvas && canvas.width && canvas.height) {
          canvas.width = 0
          canvas.height = 0
        }
      }
      rfb.disconnect()
    }
    delete this.rfb
  }

  componentWillUnmount () {
    // 主动卸载时不再把"断开"误判为连接失败（否则正在删除的 tab 会闪 error）
    this._unmounting = true
    this._detachClipboardSync()
    this._releaseRfb()
    clearTimeout(this.timer)
    clearTimeout(this.screenTimer)
    clearTimeout(this.layoutTimer)
  }

  setStatus = status => {
    const id = this.props.tab?.id
    this.props.editTab(id, {
      status
    })
  }

  // fullscreen always fills the screen, the per host setting only applies
  // windowed —— 所以栏内开关在全屏下置灰，否则会显示"关"而画面其实在缩放
  getFit = () => {
    if (this.props.fullscreen) {
      return true
    }
    return !!this.state.scaleViewport
  }

  // viewport box measured by the shell, used as the size hint for the server.
  // The shell's RO callback lands after this child's componentDidMount, so the
  // first connect measures the mount node itself; the layout props are not used
  // (in fullscreen they still describe the windowed box).
  calcCanvasSize = () => {
    const { width, height } = this.viewSize || {}
    if (width && height) {
      return { width, height }
    }
    const el = this.getDom()
    const w = el && el.clientWidth
    const h = el && el.clientHeight
    return {
      width: w || window.innerWidth,
      height: h || window.innerHeight
    }
  }

  // 视口变化：旧实现每个 ResizeObserver 帧直接重排一次，而重排会写 noVNC 的两个
  // setter 并触发 canvas 尺寸计算。这里：
  // 1. 忽略小于阈值的抖动（滚动条、DPR 取整）；
  // 2. 把一次拖窗/侧栏动画内的连续变化合并成一次重排。
  handleViewportResize = (width, height) => {
    const next = { width, height }
    this.viewSize = next
    if (!shouldReLayout(this.lastLayoutSize, next)) {
      return
    }
    this.lastLayoutSize = next
    clearTimeout(this.layoutTimer)
    this.layoutTimer = setTimeout(this.updateViewLayout, RESIZE_MERGE_MS)
  }

  buildWsUrl = (port, type = 'vnc', extra = '') => {
    const { host, tokenElecterm } = this.props.config
    const { id } = this.props.tab
    if (window.et.buildWsUrl) {
      return window.et.buildWsUrl(
        host,
        port,
        tokenElecterm,
        id,
        type,
        extra
      )
    }
    return `ws://${host}:${port}/${type}/${id}?token=${tokenElecterm}${extra}`
  }

  remoteInit = async (term = this.term) => {
    this.vncFailureReason = ''
    this.setState({
      loading: true,
      failure: ''
    })
    const { config } = this.props
    const { id } = this.props
    const tab = window.store.applyProfile(deepCopy(this.props.tab || {}))
    const {
      type,
      term: terminalType,
      viewOnly = false,
      clipViewport = false,
      qualityLevel = 3, // 0-9, lower = faster performance
      compressionLevel = 1, // 0-9, lower = faster performance
      shared = true,
      showDotCursor = true, // show dot cursor when server sends no cursor image (common on Windows)
      username,
      password
    } = tab
    const opts = clone({
      term: terminalType || config.terminalType,
      tabId: id,
      uid: tab.id,
      srcTabId: tab.id,
      termType: type,
      ...tab
    })
    const r = await createTerm(opts)
      .catch(err => {
        const text = err.message
        handleErr({ message: text })
      })
    this.setState({
      loading: false
    })
    if (!r) {
      this.setStatus(statusMap.error)
      return
    }
    this.setStatus(statusMap.success)
    const { pid, port } = r
    this.pid = pid
    this.port = port

    // Load VNC module if not already loaded
    try {
      await loadVncModule()
    } catch (e) {
      console.error('[VNC-CLIENT] Failed to load VNC module:', e)
      this.setState({ loading: false })
      this.setStatus(statusMap.error)
      return
    }
    // 关闭 tab 发生在异步窗口里：componentWillUnmount 已跑过且 this.rfb 还不存在，
    // 继续 new RFB 会建出一条没人关闭的 ws，session server 也就一直推流不退出
    if (this._unmounting) {
      return
    }

    const { width, height } = this.calcCanvasSize()
    const wsUrl = this.buildWsUrl(port, 'vnc', `&width=${width}&height=${height}`)
    // noVNC sizes its own canvas (`_screen` fills whatever box it is mounted
    // into, the canvas is centered in it), so scaling is entirely driven by
    // `scaleViewport` plus the size of the mount node.
    const vncOpts = {
      clipViewport,
      // 首连缩放取决策后的值（本机记忆 > 书签 > 默认开），不直接用 tab 字段，
      // 否则栏内开关的记忆只在重连后才生效、而首连又是从 tab 读 —— 两层会打架
      scaleViewport: this.state.scaleViewport,
      viewOnly,
      qualityLevel, // JPEG quality 0-9, lower = faster
      compressionLevel, // Compression 0-9, lower = faster
      shared, // Allow shared connections
      credentials: {}
    }
    if (username) {
      vncOpts.credentials.username = username
    }
    if (password) {
      vncOpts.credentials.password = password
    }
    const RFB = window.novnc.RFB
    const rfb = new RFB(
      this.getDom(),
      wsUrl,
      vncOpts
    )
    captureFailure(rfb, reason => {
      this.vncFailureReason = reason
    })

    // Monkey patch _handleExtendedDesktopSize to capture screen info
    const originalHandleExtendedDesktopSize = rfb._handleExtendedDesktopSize
    rfb._handleExtendedDesktopSize = function () {
      try {
        // Wait for header
        if (this._sock.rQwait('ExtendedDesktopSize', 4)) {
          return false
        }

        const numberOfScreens = this._sock.rQpeek8()
        const bytes = 4 + (numberOfScreens * 16)
        if (this._sock.rQwait('ExtendedDesktopSize', bytes)) {
          return false
        }

        const firstUpdate = !this._supportsSetDesktopSize
        this._supportsSetDesktopSize = true

        if (firstUpdate) {
          this._requestRemoteResize()
        }

        const num = this._sock.rQshift8() // number-of-screens
        this._sock.rQskipBytes(3) // padding

        const screens = []
        for (let i = 0; i < num; i += 1) {
          const idBytes = this._sock.rQshiftBytes(4)
          const id = (idBytes[0] << 24 | idBytes[1] << 16 | idBytes[2] << 8 | idBytes[3]) >>> 0

          const x = this._sock.rQshift16() // x-position
          const y = this._sock.rQshift16() // y-position
          const w = this._sock.rQshift16() // width
          const h = this._sock.rQshift16() // height

          const flagsBytes = this._sock.rQshiftBytes(4)
          const flags = (flagsBytes[0] << 24 | flagsBytes[1] << 16 | flagsBytes[2] << 8 | flagsBytes[3]) >>> 0

          screens.push({ id, x, y, width: w, height: h, flags })

          if (i === 0) {
            this._screenID = idBytes
            this._screenFlags = flagsBytes
          }
        }

        // Store the screens in a custom property and dispatch event
        this.screens = screens
        this.dispatchEvent(new CustomEvent('screens', { detail: screens }))

        // Handle the resize feedback logic from original code
        if (this._FBU.x === 1 && this._FBU.y !== 0) {
          let msg = ''
          switch (this._FBU.y) {
            case 1: msg = 'Resize is administratively prohibited'; break
            case 2: msg = 'Out of resources'; break
            case 3: msg = 'Invalid screen layout'; break
            default: msg = 'Unknown reason'; break
          }
          console.warn('Server did not accept the resize request: ' + msg)
        } else {
          this._resize(this._FBU.width, this._FBU.height)
        }

        return true
      } catch (e) {
        console.error('Error in patched _handleExtendedDesktopSize', e)
        return originalHandleExtendedDesktopSize.call(this)
      }
    }

    // Monkey patch autoscale to support single screen scaling
    const originalAutoscale = rfb._display.autoscale
    rfb._display.autoscale = (containerWidth, containerHeight) => {
      const { currentScreen, screens } = this.state

      if (currentScreen === 'all' || !screens.length) {
        return originalAutoscale.call(rfb._display, containerWidth, containerHeight)
      }

      const screen = screens.find(s => s.id === currentScreen)
      if (!screen) {
        return originalAutoscale.call(rfb._display, containerWidth, containerHeight)
      }

      let scaleRatio = 1.0
      if (containerWidth > 0 && containerHeight > 0) {
        const targetAspectRatio = containerWidth / containerHeight
        const screenAspectRatio = screen.width / screen.height

        if (screenAspectRatio >= targetAspectRatio) {
          scaleRatio = containerWidth / screen.width
        } else {
          scaleRatio = containerHeight / screen.height
        }
      }
      rfb._display._rescale(scaleRatio)
    }

    const events = [
      'connect',
      'disconnect',
      'credentialsrequired',
      'securityfailure',
      'clipboard',
      'bell',
      'desktopname',
      'capabilities',
      'screens',
      'desktopsize',
      'serververification'
    ]
    for (const event of events) {
      const handler = this[`on${window.capitalizeFirstLetter(event)}`]
      // 闭包捕获当前 rfb 实例，防止旧实例的迟到 disconnect 事件误伤新连接
      rfb.addEventListener(event, e => handler(e, rfb))
    }
    rfb.scaleViewport = this.getFit()
    rfb.clipViewport = clipViewport
    rfb.qualityLevel = qualityLevel
    rfb.compressionLevel = compressionLevel
    rfb.viewOnly = viewOnly
    rfb.showDotCursor = showDotCursor
    this.vncViewOnly = viewOnly
    this.rfb = rfb
  }

  onConnect = (event) => {
    this.vncFailureReason = ''
    this.setStatus(statusMap.success)
    // Capture the remote desktop size from the RFB connection
    this.setState({
      loading: false,
      failure: ''
    })
    this._attachClipboardSync()
  }

  onDesktopsize = (event) => {
  }

  onDisconnect = (event, rfb) => {
    // 忽略两类误报：
    // ① 组件正卸载时主动调用 rfb.disconnect() 触发的断开；
    // ② 旧 RFB 实例的迟到 disconnect（handleReInit 已建新实例，连接实际仍活着）。
    // 二者都会让实际未断开的会话被标记 error，从而在 tab 上冒出重连按钮。
    if (this._unmounting) {
      // 此刻 _sock 已关闭，noVNC 不会再读 _display；解引用隐藏 backbuffer
      // 与显示层，让它们随 rfb 一起被回收（卸载瞬间置空会撞上 3 秒断开定时器）
      if (rfb._display) {
        rfb._display._backbuffer = null
        rfb._display = null
      }
      return
    }
    if (this.rfb !== rfb) return
    this._detachClipboardSync()
    this.setStatus(statusMap.error)
    // a clean disconnect is the user closing the session, not a failure
    if (event?.detail?.clean) {
      return
    }
    const reason = this.vncFailureReason || 'connection closed'
    console.error('[VNC-CLIENT] connection failed:', reason)
    this.setState({
      failure: reason
    })
  }

  onSecurityfailure = (event) => {
    // 安全失败含协议细节，走统一错误弹窗（带一键复制）而非瞬态 toast
    showErrorModal({ error: 'Security Failure: ' + (event.detail?.reason || '') })
  }

  onSerververification = (event) => {
    // RA2ne (RealVNC) authentication requires the client to approve
    // the server's public key before the handshake can proceed.
    // Auto-approve since the user explicitly initiated the connection.
    console.debug('[VNC-CLIENT] Server verification event, approving server:', event.detail?.type)
    this.rfb?.approveServer()
  }

  onOk = (res) => {
    this.setState({
      showConfirm: false
    })
    this.rfb?.sendCredentials(res)
  }

  onCredentialsrequired = (event) => {
    this.setState({
      types: event.detail?.types || [],
      showConfirm: true
    })
  }

  renderForm (types = this.state.types) {
    return (
      <VncForm
        types={types}
        handleFinish={this.onOk}
      />
    )
  }

  onClipboard = (event) => {
    const text = event?.detail?.text
    if (!text || text === this.lastClip) {
      return
    }
    // Track so our click-driven sync won't echo this same text back to the
    // server (some servers re-broadcast what they receive).
    this.lastClip = text
    copy(text)
  }

  // Push the current local clipboard to the remote when it has changed.
  // This implements the local -> remote direction that noVNC cannot do itself.
  // Triggered on view click instead of polling, so it only runs right when the
  // user is about to interact with the remote desktop (e.g. before pasting).
  handleViewMouseDown = () => {
    const rfb = this.rfb
    if (!rfb || this.vncViewOnly) {
      return
    }
    let text
    try {
      text = readClipboard()
    } catch (e) {
      return
    }
    if (!text || text === this.lastClip) {
      return
    }
    this.lastClip = text
    try {
      rfb.clipboardPasteFrom(text)
    } catch (e) {
      // clipboardPasteFrom can throw if the socket is in a bad state; ignore
    }
  }

  // noVNC calls stopPropagation() on canvas mouse events in the bubble phase,
  // so React's delegated onClick (or any bubble-phase listener) never fires.
  // We attach a CAPTURE-phase mousedown listener on the wrapper so it runs
  // before noVNC can stop propagation. mousedown also fires earlier than click,
  // giving the remote clipboard time to update before the user pastes.
  _attachClipboardSync = () => {
    this._detachClipboardSync()
    const el = this.domRef.current
    if (!el) {
      return
    }
    el.addEventListener('mousedown', this.handleViewMouseDown, true)
  }

  _detachClipboardSync = () => {
    const el = this.domRef.current
    if (el) {
      el.removeEventListener('mousedown', this.handleViewMouseDown, true)
    }
  }

  onBell = (event) => {
    message.warning('Bell')
  }

  onDesktopname = (event) => {
    this.setState({
      name: event?.detail?.name || ''
    })
    this.checkScreens()
  }

  onCapabilities = (capabilities) => {
    clearTimeout(this.screenTimer)
    this.screenTimer = setTimeout(this.checkScreens, 1000)
  }

  processScreens = (screens) => {
    if (!screens || !screens.length) {
      return []
    }
    return screens.map((s, i) => ({
      name: `Screen ${i + 1}`,
      ...s,
      id: s.id !== undefined ? s.id : i
    }))
  }

  onScreens = (event) => {
    const screensData = event.detail
    if (screensData && screensData.length) {
      const screens = this.processScreens(screensData)
      this.setState({
        screens,
        currentScreen: screens[0].id
      })
    }
  }

  checkScreens = () => {
    // Attempt to detect screens from noVNC
    let screens = this.rfb?.screens
    if (!screens && this.rfb?.capabilities?.screens) {
      screens = this.rfb.capabilities.screens
    }

    if (screens && screens.length) {
      const next = this.processScreens(screens)
      const cur = this.state.screens || []
      // 远端会反复广播 desktopname/capabilities：内容没变就不 setState，
      // 避免无意义的整页重渲染
      const same = cur.length === next.length &&
        next.every((s, i) => s.id === cur[i].id)
      if (!same) {
        this.setState({ screens: next })
      }
    }
  }

  componentDidUpdate (prevProps, prevState) {
    // viewport size changes are reported by the shell, the layout props are
    // stale in fullscreen so they are not used here
    if (
      prevProps.fullscreen !== this.props.fullscreen ||
      prevState.currentScreen !== this.state.currentScreen
    ) {
      this.updateViewLayout()
    }
  }

  updateViewLayout = () => {
    const { currentScreen, screens } = this.state
    const { clipViewport = false } = this.props.tab
    const container = this.domRef.current ? this.domRef.current.firstElementChild : null

    if (!this.rfb || !container) {
      return
    }

    // 本次重排对齐的是哪个尺寸（handleViewportResize 的抖动比较基准）
    if (this.viewSize) {
      this.lastLayoutSize = { ...this.viewSize }
    }

    // keep noVNC scaling in sync with our fit state, then re-run autoscale so
    // our patched single screen logic sees the new viewport size.
    // noVNC 的 scaleViewport / clipViewport setter 不判等：每次赋值都会跑
    // _updateScale / viewportChangeSize + viewportChangePos，尺寸真变时还要重
    // 分配 canvas backing store 并整屏 blit，所以只在值确实变了时才写。
    const fit = this.getFit()
    if (this.appliedFit !== fit) {
      this.appliedFit = fit
      this.rfb.scaleViewport = fit
    }
    if (this.appliedClip !== clipViewport) {
      this.appliedClip = clipViewport
      this.rfb.clipViewport = clipViewport
    }

    if (fit && this.rfb._display) {
      // 尺寸用 shell 实测值，不再读 container.clientWidth：旧实现同一个回调里
      // 先写 style 再读布局，每帧一次强制同步布局
      const { width, height } = this.calcCanvasSize()
      this.rfb._display.autoscale(width, height)
    }

    // Handle scrolling to the selected screen —— 选屏与缩放比例都没变时重挂定时器
    // 没有意义（滚动位置已对），旧实现是每次重排都挂一个 50ms 定时器
    const scale = this.rfb._display ? this.rfb._display.scale : 1
    const scrollKey = `${currentScreen}@${scale}`
    if (scrollKey !== this.appliedScrollKey) {
      this.appliedScrollKey = scrollKey
      clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        if (currentScreen === 'all') {
          container.scrollTo(0, 0)
        } else {
          const screen = screens.find(s => s.id === currentScreen)
          if (screen) {
            container.scrollTo(screen.x * scale, screen.y * scale)
          }
        }
      }, 50)
    }
  }

  handleSelectScreen = (id) => {
    this.setState({
      currentScreen: id
    })
    // updateViewLayout will be called by componentDidUpdate
  }

  // 栏内缩放开关：写本机记忆并马上重排。noVNC 的 scaleViewport 是 live 的（setter
  // 会跑 _updateScale），不必重连；updateViewLayout 里的 appliedFit 判等保证只有
  // 真变化才写 setter。
  handleScaleViewChange = (v) => {
    ls.setItemJSON(scaleViewportLsKey(this.props.tab?.host), v)
    this.setState({
      scaleViewport: v
    }, this.updateViewLayout)
  }

  getDom = () => {
    return this.domRef.current
  }

  handleReInit = () => {
    this._detachClipboardSync()
    // 与卸载同口径：先归零两份 canvas 再断开，否则每重连一次就多滞留一帧显存
    this._releaseRfb()
    this.remoteInit()
  }

  // 栏内条目（N3 契约里的 displayItems）：选屏与缩放开关都留在顶栏，用户一眼
  // 看得见，不必先开 ⋮（2026-11-03 决定）。
  renderDisplayItems = () => {
    const {
      screens,
      currentScreen
    } = this.state
    return (
      <>
        {
          // 只有一个屏就不出选择器：一个没有可选项的 "Screen 1" 只是噪声
          screens.length > 1
            ? (
              <Select
                size='small'
                value={currentScreen}
                onChange={this.handleSelectScreen}
                popupMatchSelectWidth={false}
              >
                {
                  screens.map(s => (
                    <Option
                      key={s.id}
                      value={s.id}
                    >
                      {s.name}
                    </Option>
                  ))
                }
              </Select>
              )
            : null
        }
        <SwitchLabel
          size='small'
          label={window.translate('scaleViewport')}
          checked={this.getFit()}
          onChange={this.handleScaleViewChange}
        />
      </>
    )
  }

  handleSendCtrlAltDel = () => {
    this.rfb?.sendCtrlAltDel()
  }

  renderConfirm () {
    const {
      showConfirm
    } = this.state
    if (!showConfirm) {
      return null
    }
    const confirmProps = {
      title: e('credentialsRequired'),
      content: this.renderForm(['password']),
      footer: null,
      open: true
    }
    return (
      <Modal
        {...confirmProps}
      >
        {this.renderForm()}
      </Modal>
    )
  }

  // Reuses the terminal pane's centred "stopped" box. Inside the mount and not
  // beside it: in fit mode the shell stretches every direct child of the
  // viewport to 100%, which defeats the box's shrink-to-fit centring.
  renderFailure () {
    const { failure } = this.state
    if (!failure) {
      return null
    }
    const hint = failureHint(failure)
    return (
      <div className='terminal-session-stopped'>
        <div>{shortReason(failure)}</div>
        {hint ? <div className='mg1t'>{hint}</div> : null}
      </div>
    )
  }

  render () {
    const {
      loading,
      name
    } = this.state
    const {
      host,
      port,
      username
    } = this.props.tab || {}
    return (
      <SessionShell
        loading={loading}
        fit={this.getFit()}
        wrapClassName='vnc-session-wrap'
        onViewportResize={this.handleViewportResize}
        onReconnect={this.handleReInit}
        info={{ name, username, host, port }}
        displayItems={this.renderDisplayItems()}
        fullscreen={this.props.fullscreen}
        fullscreenIcon={this.props.fullscreenIcon}
        onSendCtrlAltDel={this.handleSendCtrlAltDel}
        overlay={this.renderConfirm()}
      >
        <div
          className='remote-session-fill vnc-session-mount'
          ref={this.domRef}
        >
          {this.renderFailure()}
        </div>
      </SessionShell>
    )
  }
}
