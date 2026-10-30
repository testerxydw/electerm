import { PureComponent, createRef } from 'react'
import { createTerm } from '../terminal/terminal-apis'
import deepCopy from 'json-deep-copy'
import { pick } from 'lodash-es'
import clone from '../../common/to-simple-obj'
import { handleErr } from '../../common/fetch'
import {
  statusMap
} from '../../common/constants'
import {
  ReloadOutlined,
  EditOutlined,
  UploadOutlined,
  DownloadOutlined
} from '@ant-design/icons'
import {
  Select,
  Tooltip
} from 'antd'
import * as ls from '../../common/safe-local-storage'
import { isMac } from '../../common/platform'
import { getScancode } from './code-scan'
import resolutions from './resolutions'
import { readClipboardAsync } from '../../common/clipboard'
import RemoteFloatControl from '../common/remote-float-control'
import SessionShell from '../common/session-shell'
import SessionInfo from '../common/session-info'
import { eventToRemotePos } from '../common/remote-pointer'
import {
  FALLBACK_DESKTOP,
  clampManualSize,
  isAutoRes,
  isNumericSize,
  resolveInitialSize,
  resolveScaleViewport
} from '../../common/remote-adapt'
import SwitchLabel from '../common/switch'
import HelpIcon from '../common/help-icon'
import Modal from '../common/modal'
import RdpCredForm from './rdp-cred-form'
import { FileTransferManager, createFileLogger } from './file-transfer'
import { notification } from '../common/notification'
import message from '../common/message'
import { showErrorModal } from '../common/error-modal'
import ShowItem from '../common/show-item'
import './rdp.styl'

const { Option } = Select

// Whether the server paints the mouse cursor into the bitmap stream.
// false: the cursor is drawn locally (a CSS cursor on the canvas), so it moves
// at local input rate instead of waiting for pointer updates to come back
// through the graphics pipeline - which is the first thing that looks frozen
// on a busy remote desktop. The cost is that the cursor no longer changes
// shape per context (I-beam over text, resize handles, ...).
const ENABLE_SERVER_POINTER = false

// remembered per host, like the resolution and scale-viewport switches
const swapCtrlCmdLsKey = host => `rdp-swap-ctrl-cmd-${host}`

async function loadWasmModule () {
  if (window.ironRdp) return
  console.debug('[RDP-CLIENT] Loading IronRDP WASM module...')
  const mod = await import('ironrdp-wasm')
  window.ironRdp = {
    wasmInit: mod.default,
    wasmSetup: mod.setup,
    SessionBuilder: mod.SessionBuilder,
    DesktopSize: mod.DesktopSize,
    InputTransaction: mod.InputTransaction,
    DeviceEvent: mod.DeviceEvent,
    Extension: mod.Extension,
    ClipboardData: mod.ClipboardData
  }
  await window.ironRdp.wasmInit()
  window.ironRdp.wasmSetup('info')
  console.debug('[RDP-CLIENT] IronRDP WASM module loaded and initialized')
}

export default class RdpSession extends PureComponent {
  constructor (props) {
    const id = `rdp-reso-${props.tab.host}`
    // 三态读取：null = 从未设置过。从未设置（或历史存到了 res-auto 这种非数值
    // 值）一律走"自动（跟随窗口）"，用户显式选过的数值尺寸继续尊重
    const resObj = ls.getItemJSON(id, null)
    const autoRes = !isNumericSize(resObj)
    const initSize = autoRes
      ? FALLBACK_DESKTOP
      : clampManualSize(resObj)
    const scaleViewportId = `rdp-scale-view-${props.tab.host}`
    // 优先级（R3）：本机逐 host 记忆 > 书签字段（含 profile 合并）> 默认开
    const scaleViewport = resolveScaleViewport(
      ls.getItemJSON(scaleViewportId, null),
      window.store.applyProfile(deepCopy(props.tab || {})).scaleViewport
    )
    const swapCtrlCmd = ls.getItemJSON(swapCtrlCmdLsKey(props.tab.host), false)
    super(props)
    this.canvasRef = createRef()
    this.state = {
      loading: false,
      scaleViewport,
      swapCtrlCmd,
      autoRes,
      id: autoRes ? 'res-auto' : resObj.id,
      width: initSize.width,
      height: initSize.height,
      hasRemoteFiles: false,
      downloadBtnDisabled: true,
      uploadReady: false,
      showCredPrompt: false
    }
    // SessionShell 实测到的视口，首连尺寸由它决定。子组件先于父组件挂载，
    // 所以这里拿到的是 null —— 连接要等视口量到之后再发起（见 componentDidMount）
    this.viewSize = null
    this.session = null
    this.fileTransfer = null
    this.fileUploadInProgress = false
    this.log = createFileLogger()
    // what the main process currently believes; see syncMenuShortcuts
    this._menuShortcutsIgnored = false
  }

  componentDidMount () {
    // React 先跑子组件的 componentDidMount，SessionShell 的实测回调在父组件那一轮
    // 才发生（同一提交阶段内、同步）。挂到微任务等它跑完，首连位图尺寸才拿得到真实
    // 视口；直接同步调用会永远退化成 FALLBACK_DESKTOP，"跟随窗口"名存实亡。
    Promise.resolve().then(() => {
      if (this._unmounting) {
        return
      }
      this.remoteInit()
    })
  }

  componentWillUnmount () {
    // 主动卸载时不再把会话结束误判为连接失败
    this._unmounting = true
    this.cleanup()
  }

  cleanup = () => {
    // a closed/reloaded tab must not leave the app menu ignoring its shortcuts
    this.setMenuShortcutsIgnored(false)
    if (this.session) {
      try {
        this.session.shutdown()
      } catch (e) {
        this.log(`session.shutdown() error: ${e.message}`, 'error')
      }
      this.session = null
    }
    if (this.fileTransfer) {
      this.fileTransfer.cleanup()
      this.fileTransfer = null
    }
  }

  runInitScript = () => { }

  // fullscreen always fills the screen, the per tab setting only applies
  // windowed; the switch is not reachable in fullscreen anyway
  getFit = () => {
    return !!this.props.fullscreen || !!this.state.scaleViewport
  }

  // 视口实测回调。本批次只把它用作"首连位图尺寸"的依据：
  // 已连上时不去改 canvas 属性（写 canvas.width 会重分配 backing store 并清屏，
  // 画面会白一下），运行中重谈分辨率属于批次 C。
  handleViewportResize = (width, height) => {
    this.viewSize = { width, height }
    if (this.session || !this.state.autoRes) {
      return
    }
    const size = resolveInitialSize({
      measured: this.viewSize,
      manual: null
    })
    if (size.width !== this.state.width || size.height !== this.state.height) {
      this.setState({
        width: size.width,
        height: size.height
      })
    }
  }

  // 首连尺寸：手选数值尺寸优先，否则取实测视口（夹到上限），都量不到时用占位值
  resolveConnectSize = () => {
    const { autoRes, width, height } = this.state
    return resolveInitialSize({
      measured: this.viewSize,
      manual: autoRes ? null : { width, height }
    })
  }

  setStatus = status => {
    const id = this.props.tab?.id
    this.props.editTab(id, {
      status
    })
  }

  buildWsUrl = (port, type = 'rdp', extra = '') => {
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

  remoteInit = async (credOverride) => {
    this.setState({
      loading: true
    })
    const { config } = this.props
    const { id } = this.props
    const tab = {
      ...window.store.applyProfile(deepCopy(this.props.tab || {})),
      ...credOverride
    }
    // keep resolved credentials for the connect-time prompt
    this.tab = tab
    if (!tab.username) {
      this.setState({
        loading: false,
        showCredPrompt: true
      })
      return
    }
    const {
      type,
      term: terminalType
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
    if (!r) {
      this.setState({ loading: false })
      this.setStatus(statusMap.error)
      return
    }

    const {
      pid, port
    } = r
    this.pid = pid

    const { width, height } = this.resolveConnectSize()
    const extra = `&width=${width}&height=${height}`
    const proxyAddress = this.buildWsUrl(port, 'rdp', extra)

    try {
      await loadWasmModule()
    } catch (e) {
      this.log(`Failed to load WASM module: ${e.message}`, 'error')
      this.setState({ loading: false })
      this.setStatus(statusMap.error)
      return
    }

    this.setStatus(statusMap.success)

    try {
      const canvas = this.canvasRef.current
      if (!canvas) {
        this.log('Canvas ref not available', 'error')
        this.setState({ loading: false })
        return
      }

      const rdpHost = tab.host
      const rdpPort = tab.port || 3389
      const destination = `${rdpHost}:${rdpPort}`
      const username = tab.username || ''
      const password = tab.password || ''

      const desktopSize = new window.ironRdp.DesktopSize(width, height)
      const enableCredsspExt = new window.ironRdp.Extension('enable_credssp', true)
      // Unknown extensions are ignored by older wasm builds, so this is safe to
      // pass unconditionally.
      const pointerExt = new window.ironRdp.Extension('enable_server_pointer', ENABLE_SERVER_POINTER)

      const builder = new window.ironRdp.SessionBuilder()
      builder.username(username)
      builder.password(password)
      if (tab.domain) {
        builder.serverDomain(tab.domain)
      }
      builder.destination(destination)
      builder.proxyAddress(proxyAddress)
      builder.authToken('none')
      builder.desktopSize(desktopSize)
      builder.renderCanvas(canvas)
      builder.extension(enableCredsspExt)
      builder.extension(pointerExt)

      this.fileTransfer = new FileTransferManager(
        () => this.session,
        this.log,
        (inProgress) => {
          this.fileUploadInProgress = inProgress
        },
        () => {
          this.setState({ uploadReady: false })
        },
        (filePath, fileName, fileSize) => {
          notification.success({
            message: 'File downloaded from remote',
            description: (
              <ShowItem to={filePath}>
                {`${fileName} (${this.fileTransfer.formatFileSize(fileSize)})`}
              </ShowItem>
            ),
            duration: 0
          })
        }
      )

      this.fileTransfer.setStateChangeCallback((state) => {
        this.setState({
          hasRemoteFiles: state.hasRemoteFiles,
          downloadBtnDisabled: !state.hasRemoteFiles
        })
      })

      const fileTransferExtensions = this.fileTransfer.createExtensions()
      fileTransferExtensions.forEach((ext) => {
        builder.extension(ext)
      })

      builder.remoteClipboardChangedCallback((clipboardData) => {
        try {
          if (clipboardData.isEmpty()) {
            return
          }
          const items = clipboardData.items()
          for (const item of items) {
            const mimeType = item.mimeType()
            if (mimeType === 'text/plain') {
              const text = item.value()
              window.pre.writeClipboard(text)
            }
          }
        } catch (e) {
          this.log(`Clipboard error: ${e.message}`, 'error')
        }
      })

      builder.forceClipboardUpdateCallback(() => {
        this.syncLocalToRemote()
      })

      builder.setCursorStyleCallbackContext(canvas)
      builder.setCursorStyleCallback(function (style) {
        canvas.style.cursor = style || 'default'
      })

      this.session = await builder.connect()

      const ds = this.session.desktopSize()

      canvas.width = ds.width
      canvas.height = ds.height

      this.setState({
        loading: false,
        // 自动模式下把画布属性对齐到服务端实际给出的尺寸，
        // 否则 render 里的 width/height 与真位图不一致，指针落点会偏
        width: ds.width,
        height: ds.height
      })

      canvas.focus()

      const session = this.session
      session.run().then((info) => {
        this.log(`Session ended: ${info.reason()}`, 'info')
        this.onSessionEnd(session)
      }).catch((e) => {
        // 原地重连（handleReInit / onCredSubmit）会 shutdown 旧会话，旧 run()
        // 迟到的 reject 不是新连接的失败，弹错误窗会把用户误导成"连不上"
        if (this._unmounting || this.session !== session) {
          return
        }
        this.showError(e)
        this.onSessionEnd(session)
      })
    } catch (e) {
      this.showError(e)
      this.setState({
        loading: false,
        // let the user retry with different credentials on auth failure
        showCredPrompt: this.isAuthError(e) ? true : this.state.showCredPrompt
      })
      this.setStatus(statusMap.error)
    }
  }

  formatError = (e) => {
    if (e && typeof e === 'object' && '__wbg_ptr' in e) {
      try {
        const kindNames = {
          0: 'General',
          1: 'WrongPassword',
          2: 'LogonFailure',
          3: 'AccessDenied',
          4: 'RDCleanPath',
          5: 'ProxyConnect',
          6: 'NegotiationFailure'
        }
        const kind = e.kind ? e.kind() : 'Unknown'
        const bt = e.backtrace ? e.backtrace() : ''
        return `[${kindNames[kind] || kind}] ${bt}`
      } catch (_) { }
    }
    return e?.message || e?.toString() || String(e)
  }

  // WrongPassword(1) / LogonFailure(2)
  isAuthError = (err) => {
    if (err && typeof err === 'object' && '__wbg_ptr' in err && err.kind) {
      try {
        const kind = err.kind()
        return kind === 1 || kind === 2
      } catch (_) { }
    }
    return false
  }

  // map known IronErrorKind codes to a user-friendly message
  errText = (err) => {
    if (this.isAuthError(err)) {
      return window.translate('loginFail') + ` (${this.formatError(err)})`
    }
    return this.formatError(err)
  }

  showError = (err) => {
    const text = this.errText(err)
    this.log(`Connection failed: ${this.formatError(err)}`, 'error')
    // 连接失败含堆栈/凭据错误详情，走统一错误弹窗（带一键复制）而非瞬态 toast
    showErrorModal({ error: text })
  }

  onCredSubmit = (res) => {
    this.setState({
      showCredPrompt: false
    })
    // tear down the failed attempt before reconnecting
    this.cleanup()
    // reconnect with the provided credentials, not persisted to the bookmark
    this.remoteInit(res)
  }

  onCredCancel = () => {
    this.setState({
      showCredPrompt: false
    })
    this.setStatus(statusMap.error)
  }

  renderCredPrompt = () => {
    const {
      showCredPrompt
    } = this.state
    if (!showCredPrompt) {
      return null
    }
    const confirmProps = {
      title: window.translate('credentialsRequired'),
      footer: null,
      open: true,
      onCancel: this.onCredCancel
    }
    return (
      <Modal
        {...confirmProps}
      >
        <RdpCredForm
          initialValues={pick(this.tab, ['username', 'password'])}
          handleFinish={this.onCredSubmit}
        />
      </Modal>
    )
  }

  syncLocalToRemote = async () => {
    if (!this.session || this.fileUploadInProgress) {
      return
    }
    try {
      const text = await readClipboardAsync()
      if (text) {
        const data = new window.ironRdp.ClipboardData()
        data.addText('text/plain', text)
        await this.session.onClipboardPaste(data)
      }
    } catch (e) {
      this.log(`Local clipboard sync error: ${e.message}`, 'error')
    }
  }

  onSessionEnd = (session) => {
    // 忽略两类误报：
    // ① 卸载时主动 session.shutdown() 触发的结束；
    // ② 旧会话实例的迟到结束事件（重连已建新会话，连接实际仍活着）。
    // 二者都会让实际未断开的会话被标记 error，从而在 tab 上冒出重连按钮。
    if (this._unmounting) return
    if (session && this.session !== session) return
    this.session = null
    this.setStatus(statusMap.error)
  }

  setupInputHandlers = () => {
    const canvas = this.canvasRef.current
    if (!canvas || this._inputHandlersSetup) return
    this._inputHandlersSetup = true

    canvas.addEventListener('keydown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!this.session) return
      const scancode = this.getScancode(e.code)
      if (scancode === null) return
      try {
        const event = window.ironRdp.DeviceEvent.keyPressed(scancode)
        const tx = new window.ironRdp.InputTransaction()
        tx.addEvent(event)
        this.session.applyInputs(tx)
      } catch (err) {
        this.log(`Key press error: ${err.message}`, 'error')
      }
    })

    canvas.addEventListener('keyup', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!this.session) return
      const scancode = this.getScancode(e.code)
      if (scancode === null) return
      try {
        const event = window.ironRdp.DeviceEvent.keyReleased(scancode)
        const tx = new window.ironRdp.InputTransaction()
        tx.addEvent(event)
        this.session.applyInputs(tx)
      } catch (err) {
        this.log(`Key release error: ${err.message}`, 'error')
      }
    })

    // Coalesce mouse moves to at most one per animation frame. A high polling
    // rate mouse otherwise produces far more input transactions than the
    // session loop can drain, and every one of them competes with the frames
    // coming back from the server.
    let pendingMousePos = null
    let mouseRafId = null

    const flushMouseMove = () => {
      mouseRafId = null
      const pos = pendingMousePos
      pendingMousePos = null
      if (!pos || !this.session) return
      try {
        const event = window.ironRdp.DeviceEvent.mouseMove(pos.x, pos.y)
        const tx = new window.ironRdp.InputTransaction()
        tx.addEvent(event)
        this.session.applyInputs(tx)
      } catch (err) {
        // suppress frequent mouse errors
      }
    }

    // A click must land where the user actually is, not at the last frame's
    // position.
    const flushMouseMoveNow = () => {
      if (mouseRafId !== null) {
        window.cancelAnimationFrame(mouseRafId)
        flushMouseMove()
      }
    }

    canvas.addEventListener('mousemove', (e) => {
      if (!this.session) return
      // the canvas is rendered with object-fit: contain, so the pointer has
      // to be mapped through the real surface rect (see remote-pointer.js)
      pendingMousePos = eventToRemotePos(
        e,
        canvas,
        canvas.width,
        canvas.height
      )
      if (mouseRafId === null) {
        mouseRafId = window.requestAnimationFrame(flushMouseMove)
      }
    })

    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault()
      canvas.focus()
      flushMouseMoveNow()
      if (!this.session) return
      try {
        const event = window.ironRdp.DeviceEvent.mouseButtonPressed(e.button)
        const tx = new window.ironRdp.InputTransaction()
        tx.addEvent(event)
        this.session.applyInputs(tx)
      } catch (err) {
        this.log(`Mouse down error: ${err.message}`, 'error')
      }
    })

    canvas.addEventListener('mouseup', (e) => {
      e.preventDefault()
      flushMouseMoveNow()
      if (!this.session) return
      try {
        const event = window.ironRdp.DeviceEvent.mouseButtonReleased(e.button)
        const tx = new window.ironRdp.InputTransaction()
        tx.addEvent(event)
        this.session.applyInputs(tx)
      } catch (err) {
        this.log(`Mouse up error: ${err.message}`, 'error')
      }
    })

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      if (!this.session) return
      try {
        if (e.deltaY !== 0) {
          const amount = e.deltaY > 0 ? -1 : 1
          const event = window.ironRdp.DeviceEvent.wheelRotations(true, amount, 1)
          const tx = new window.ironRdp.InputTransaction()
          tx.addEvent(event)
          this.session.applyInputs(tx)
        }
        if (e.deltaX !== 0) {
          const amount = e.deltaX > 0 ? -1 : 1
          const event = window.ironRdp.DeviceEvent.wheelRotations(false, amount, 1)
          const tx = new window.ironRdp.InputTransaction()
          tx.addEvent(event)
          this.session.applyInputs(tx)
        }
      } catch (err) {
        this.log(`Wheel error: ${err.message}`, 'error')
      }
    }, { passive: false })

    canvas.addEventListener('contextmenu', (e) => e.preventDefault())

    canvas.addEventListener('paste', (e) => {
      e.preventDefault()
      this.handlePasteEvent()
    })

    canvas.addEventListener('focus', () => {
      this.syncMenuShortcuts()
      this.syncLocalToRemote()
    })

    canvas.addEventListener('blur', () => {
      this.syncMenuShortcuts()
    })
  }

  getScancode = (code) => {
    const sc = getScancode(code, this.state.swapCtrlCmd)
    return sc !== undefined ? sc : null
  }

  // A registered menu accelerator is consumed by AppKit before the page ever
  // sees the keydown, so with the swap on Cmd+C/V/A/Z/X would still run the
  // local Edit menu instead of reaching the remote as Ctrl+C/V/A/Z/X. While -
  // and only while - the swapped canvas holds focus, tell the main process to
  // stop honouring the app menu's shortcuts.
  setMenuShortcutsIgnored = (active) => {
    if (active === this._menuShortcutsIgnored) return
    this._menuShortcutsIgnored = active
    try {
      // the web client has no app menu, and older bridges do not know the call
      window.pre.runGlobalAsync('setRdpSwapCtrlCmd', active).catch(() => {})
    } catch (e) { }
  }

  syncMenuShortcuts = () => {
    const canvas = this.canvasRef.current
    this.setMenuShortcutsIgnored(
      isMac &&
      !!this.state.swapCtrlCmd &&
      !!canvas &&
      document.activeElement === canvas
    )
  }

  handleSwapCtrlCmdChange = (v) => {
    ls.setItemJSON(swapCtrlCmdLsKey(this.props.tab.host), v)
    this.setState({ swapCtrlCmd: v }, () => {
      // clicking the switch took focus away from the canvas; give it back so
      // the swap is usable immediately
      this.canvasRef.current?.focus()
      this.syncMenuShortcuts()
    })
  }

  handleEditResolutions = () => {
    window.store.toggleResolutionEdit()
  }

  handleReInit = () => {
    // 对齐 VNC：原地断开重连。reloadTab 会重建整个 tab（丢掉会话上下文），
    // 而改分辨率/改缩放并不需要重来一次
    this.cleanup()
    this.remoteInit()
  }

  handleReload = () => {
    this.props.reloadTab(
      this.props.tab
    )
  }

  getAllRes = () => {
    // res-auto 不再被 slice(1) 排除在外：它是"自动（跟随窗口）"的入口，
    // 排在第一位；非数值宽高在 handleResChange / 构造函数里统一按自动处理
    const auto = resolutions.filter(isAutoRes)
    const fixed = resolutions.filter(d => !isAutoRes(d))
    return [
      ...auto,
      ...this.props.resolutions,
      ...fixed
    ]
  }

  handleResChange = (v) => {
    const res = this.getAllRes().find(d => d.id === v)
    const id = `rdp-reso-${this.props.tab.host}`
    ls.setItemJSON(id, res)
    const autoRes = isAutoRes(res)
    const size = resolveInitialSize({
      measured: this.viewSize,
      manual: autoRes ? null : res
    })
    this.setState({
      autoRes,
      id: res.id,
      width: size.width,
      height: size.height
    }, this.handleReInit)
  }

  handleScaleViewChange = (v) => {
    const scaleViewportId = `rdp-scale-view-${this.props.tab.host}`
    ls.setItemJSON(scaleViewportId, v)
    this.setState({
      scaleViewport: v
    })
  }

  renderHelp = () => {
    return null
  }

  getControlProps = (options = {}) => {
    const {
      fixedPosition = true,
      showExitFullscreen = true,
      className = ''
    } = options

    return {
      isFullScreen: this.props.fullscreen,
      onSendCtrlAltDel: this.handleSendCtrlAltDel,
      fixedPosition,
      showExitFullscreen,
      className
    }
  }

  handleSendCtrlAltDel = () => {
    if (!this.session) return
    try {
      const tx = new window.ironRdp.InputTransaction()
      const ctrlScancode = 0x1D
      tx.addEvent(window.ironRdp.DeviceEvent.keyPressed(ctrlScancode))
      const altScancode = 0x38
      tx.addEvent(window.ironRdp.DeviceEvent.keyPressed(altScancode))
      const delScancode = 0x53
      tx.addEvent(window.ironRdp.DeviceEvent.keyPressed(delScancode))
      tx.addEvent(window.ironRdp.DeviceEvent.keyReleased(delScancode))
      tx.addEvent(window.ironRdp.DeviceEvent.keyReleased(altScancode))
      tx.addEvent(window.ironRdp.DeviceEvent.keyReleased(ctrlScancode))
      this.session.applyInputs(tx)
    } catch (err) {
      this.log(`Failed to send Ctrl+Alt+Del: ${err.message}`, 'error')
    }
  }

  handleUploadButtonClick = async () => {
    const properties = [
      'openFile',
      'multiSelections',
      'showHiddenFiles',
      'noResolveAliases',
      'treatPackageAsDirectory',
      'dontAddToRecent'
    ]

    const files = await window.api.openDialog({
      title: 'Choose files to upload to remote desktop',
      message: 'Choose files to upload',
      properties,
      noBrowserTransfer: true
    }).catch((err) => {
      this.log(`File dialog error: ${err.message}`, 'error')
      return false
    })

    if (!files || !files.length) {
      return
    }

    message.info('Ready to paste on remote to upload files', 5)
    this.setState({ uploadReady: true })

    if (this.fileTransfer) {
      await this.fileTransfer.uploadFromPaths(files)
    }
  }

  handleDownloadButtonClick = () => {
    if (this.fileTransfer) {
      this.fileTransfer.downloadFiles()
    }
  }

  handlePasteEvent = async () => {
    const text = await readClipboardAsync()

    if (!text) {
      this.syncLocalToRemote()
      return
    }

    const fileRegWin = /^\w:\\.+/
    const fileReg = /^\/.+/
    const lines = text.split('\n')

    const filePaths = lines.filter(line => fileReg.test(line) || fileRegWin.test(line))

    if (filePaths.length === 0) {
      this.syncLocalToRemote()
      return
    }

    if (this.fileTransfer) {
      await this.fileTransfer.uploadFromPaths(filePaths)
    }
  }

  componentDidUpdate () {
    this.setupInputHandlers()
  }

  renderControlLeft = () => {
    const {
      id,
      hasRemoteFiles,
      uploadReady
    } = this.state
    const sleProps = {
      value: id,
      onChange: this.handleResChange,
      popupMatchSelectWidth: false
    }
    const scaleProps = {
      checked: this.state.scaleViewport,
      onChange: this.handleScaleViewChange,
      label: window.translate('scaleViewport'),
      className: 'mg1l'
    }
    // macOS only: swapping Ctrl/Command is meaningless on a Mac host, and the
    // remote has to be Windows for the Win key to be the other half of the swap.
    // The label is a literal glyph pair, not a translated string: "ctrl <-> cmd"
    // reads the same in every language and needs no locale slot.
    const swapProps = {
      checked: !!this.state.swapCtrlCmd,
      onChange: this.handleSwapCtrlCmdChange,
      label: 'ctrl ⇄ cmd',
      className: 'mg1l'
    }
    const uploadTitle = window.translate('upload') || 'Upload files to remote'
    const downloadTitle = window.translate('download') || 'Download files from remote'
    return (
      <>
        <ReloadOutlined
          onClick={this.handleReInit}
          className='mg2r mg1l pointer'
        />
        <Select
          {...sleProps}
        >
          {this.getAllRes().map(d => {
            const v = d.id
            // res-auto 的宽高是 'auto' 字符串，不能当成 "auto x auto" 渲染
            const label = isAutoRes(d)
              ? window.translate('resolutionAuto')
              : `${d.width}x${d.height}`
            return (
              <Option
                key={v}
                value={v}
              >
                {label}
              </Option>
            )
          })}
        </Select>
        <EditOutlined
          onClick={this.handleEditResolutions}
          className='mg2r mg1l pointer'
        />
        {this.renderInfo()}
        <SwitchLabel
          {...scaleProps}
        />
        {
          isMac
            ? <SwitchLabel {...swapProps} />
            : null
        }
        <Tooltip title={uploadTitle}>
          <UploadOutlined
            onClick={this.handleUploadButtonClick}
            className={`mg1r mg2l pointer rdp-file-transfer-btn${uploadReady ? ' rdp-download-flash' : ''}`}
          />
        </Tooltip>
        <Tooltip title={downloadTitle}>
          <DownloadOutlined
            onClick={this.handleDownloadButtonClick}
            className={`mg2r mg1l pointer rdp-file-transfer-btn${hasRemoteFiles ? ' rdp-download-flash' : ' rdp-download-disabled'}`}
          />
        </Tooltip>
        <HelpIcon
          link='https://github.com/electerm/electerm/wiki/RDP-File-Transfer'
          className='mg2r mg1l'
        />
      </>
    )
  }

  renderControlRight = () => {
    const contrlProps = this.getControlProps({
      fixedPosition: false,
      showExitFullscreen: false,
      className: 'mg1l'
    })
    return (
      <>
        {this.props.fullscreenIcon()}
        <RemoteFloatControl {...contrlProps} />
      </>
    )
  }

  renderInfo () {
    const {
      host,
      port,
      username
    } = this.props.tab || {}
    return (
      <SessionInfo
        username={username}
        host={host}
        port={port}
      />
    )
  }

  render () {
    const { width, height, loading } = this.state
    const controlProps = this.getControlProps()
    return (
      <SessionShell
        loading={loading}
        fit={this.getFit()}
        wrapClassName='rdp-session-wrap'
        onViewportResize={this.handleViewportResize}
        controlLeft={this.renderControlLeft()}
        controlRight={this.renderControlRight()}
        floatControl={<RemoteFloatControl {...controlProps} />}
        overlay={this.renderCredPrompt()}
      >
        <canvas
          className='rdp-canvas'
          width={width}
          height={height}
          tabIndex={0}
          ref={this.canvasRef}
        />
      </SessionShell>
    )
  }
}
