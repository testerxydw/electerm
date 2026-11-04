import { PureComponent, createRef } from 'react'
import { createTerm } from '../terminal/terminal-apis'
import deepCopy from 'json-deep-copy'
import clone from '../../common/to-simple-obj'
import { handleErr } from '../../common/fetch'
import {
  statusMap
} from '../../common/constants'
import SwitchLabel from '../common/switch'
import RemoteSuspendSelect from '../common/remote-suspend-select'
import * as ls from '../../common/safe-local-storage'
import SessionShell from '../common/session-shell'
import { eventToRemotePos } from '../common/remote-pointer'
import { resolveScaleViewport } from '../../common/remote-adapt'
import RemoteSuspend, { isTabActive } from '../../common/remote-suspend'
import { freezeFrame, unfreezeFrame, FROZEN_OVERLAY_STYLE } from '../../common/frozen-frame'
import './spice.styl'

async function loadSpiceModule () {
  if (window.spiceHtml5) return
  const mod = await import('spice-client')
  window.spiceHtml5 = {
    SpiceMainConn: mod.SpiceMainConn,
    sendCtrlAltDel: mod.sendCtrlAltDel
  }
}

export default class SpiceSession extends PureComponent {
  constructor (props) {
    const scaleViewportId = `spice-scale-view-${props.tab.host}`
    // 与 RDP 同一口径（R1/S1）：本机逐 host 记忆 > 书签字段（含 profile 合并）> 默认开；
    // 显式关过的 host 仍保持关闭
    const scaleViewport = resolveScaleViewport(
      ls.getItemJSON(scaleViewportId, null),
      window.store.applyProfile(deepCopy(props.tab || {})).scaleViewport
    )
    super(props)
    this.state = {
      loading: false,
      connected: false,
      scaleViewport
    }
    this.spiceConn = null
    this.screenId = `spice-screen-${props.tab.id}`
    this._suspendGuard = new RemoteSuspend({
      onSuspend: () => this._suspendRemote(),
      onResume: () => this._resumeRemote()
    })
  }

  domRef = createRef()
  frozenRef = createRef()

  componentDidMount () {
    this.remoteInit()
    this.attachMouseScaleFix()
    this._suspendGuard.update(isTabActive(this.props))
  }

  // 隐藏的 tab 只是 display:none，组件不卸载：SPICE 的 spice-html5 解码循环会
  // 一直为看不见的画面付费。切走超过宽限期就停掉（服务器端 ws close 会收掉
  // 子进程），回切时走与"重连"按钮同一条 reloadTab 路径重建。
  _suspendRemote = () => {
    if (!this.spiceConn) {
      return
    }
    // 挂起瞬间快照末帧到覆盖层，切回重连期间盖住黑屏（见 frozen-frame.js）
    freezeFrame(
      this.domRef.current && this.domRef.current.querySelector('canvas'),
      this.frozenRef.current
    )
    this._releaseCanvases()
    this.cleanup()
  }

  _resumeRemote = () => {
    if (this._unmounting || this.spiceConn) {
      return
    }
    this.props.reloadTab(this.props.tab)
  }

  componentWillUnmount () {
    // 主动卸载时不再把连接错误误判为失败
    this._unmounting = true
    this._suspendGuard.stop()
    this.detachMouseScaleFix()
    this._releaseCanvases()
    this.cleanup()
  }

  componentDidUpdate (prevProps) {
    if (prevProps.currentBatchTabId !== this.props.currentBatchTabId) {
      this._suspendGuard.update(isTabActive(this.props))
    }
  }

  // SPICE 自行在挂载点里建 canvas：cleanup()/stop() 之后这些画布就不再由我们
  // 掌控（也查不到了），所以必须在 stop 之前把 backing store 归零，
  // 让显存立刻释放而不是等 GC。卸载与原地重连共用这一份。
  _releaseCanvases = () => {
    const canvases = this.domRef.current?.querySelectorAll('canvas') || []
    for (const canvas of canvases) {
      if (canvas.width && canvas.height) {
        canvas.width = 0
        canvas.height = 0
      }
    }
  }

  // The spice client sends event.offsetX/offsetY to the remote as-is, but when
  // the canvas is CSS-scaled (fit mode), those are display pixels instead of
  // remote surface pixels. On high resolution remote screens the pointer then
  // only reaches the top-left region. Convert display coords to surface coords
  // before the lib's handlers run (same mapping as rdp, see remote-pointer.js).
  handleMouseScaleFix = (e) => {
    const canvas = this.domRef.current?.querySelector('canvas')
    if (!canvas || !canvas.width || !canvas.height) return
    const { x, y } = eventToRemotePos(e, canvas, canvas.width, canvas.height)
    Object.defineProperty(e, 'offsetX', {
      value: x
    })
    Object.defineProperty(e, 'offsetY', {
      value: y
    })
  }

  attachMouseScaleFix = () => {
    this.domRef.current?.addEventListener(
      'mousemove',
      this.handleMouseScaleFix,
      true
    )
  }

  detachMouseScaleFix = () => {
    this.domRef.current?.removeEventListener(
      'mousemove',
      this.handleMouseScaleFix,
      true
    )
  }

  cleanup = () => {
    if (this.spiceConn) {
      try {
        this.spiceConn.stop()
      } catch (e) {
        // stop 清理失败仅留痕，后续置 null 防重复调用
        console.debug('[spice-session] conn stop fails:', e.message)
      }
      this.spiceConn = null
    }
  }

  setStatus = status => {
    const id = this.props.tab?.id
    this.props.editTab(id, {
      status
    })
  }

  buildWsUrl = (port, type = 'spice', extra = '') => {
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

  // 首连在 SessionShell 的 RO 回调之前（子组件先 mount），直接量挂载点；
  // 上层布局宽高在全屏时是陈旧值，不再作为兜底
  calcCanvasSize = () => {
    const { width, height } = this.viewSize || {}
    if (width && height) {
      return { width, height }
    }
    const el = this.domRef.current
    const w = el && el.clientWidth
    const h = el && el.clientHeight
    return {
      width: w || window.innerWidth,
      height: h || window.innerHeight
    }
  }

  // fullscreen always fills the screen, the per tab setting only applies
  // windowed; the switch is not reachable in fullscreen anyway
  getFit = () => {
    if (this.props.fullscreen) {
      return true
    }
    return !!this.state.scaleViewport
  }

  handleViewportResize = (width, height) => {
    this.viewSize = { width, height }
  }

  handleSendCtrlAltDel = () => {
    if (this.spiceConn && window.spiceHtml5?.sendCtrlAltDel) {
      window.spiceHtml5.sendCtrlAltDel(this.spiceConn)
    }
  }

  handleScaleViewChange = (v) => {
    const scaleViewportId = `spice-scale-view-${this.props.tab.host}`
    ls.setItemJSON(scaleViewportId, v)
    this.setState({
      scaleViewport: v
    })
  }

  // 栏内条目（N3 契约里的 displayItems）：缩放开关留在顶栏，一眼看得见
  renderDisplayItems = () => {
    return (
      <>
        <SwitchLabel
          size='small'
          label={window.translate('scaleViewport')}
          checked={this.getFit()}
          onChange={this.handleScaleViewChange}
        />
        <RemoteSuspendSelect />
      </>
    )
  }

  remoteInit = async () => {
    this.setState({
      loading: true
    })
    const { config } = this.props
    const { id } = this.props
    const tab = window.store.applyProfile(deepCopy(this.props.tab || {}))
    const {
      type,
      term: terminalType,
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
    if (!r) {
      this.setState({ loading: false })
      this.setStatus(statusMap.error)
      return
    }

    const { pid, port } = r
    this.pid = pid

    try {
      await loadSpiceModule()
    } catch (e) {
      console.error('[SPICE] Failed to load SPICE module:', e)
      this.setState({ loading: false })
      this.setStatus(statusMap.error)
      return
    }
    // 关闭 tab 发生在异步窗口里：componentWillUnmount 已跑过且 this.spiceConn
    // 还不存在，继续建连会留下一条没人 stop 的会话（子进程还会持续推流）
    if (this._unmounting) {
      return
    }

    this.setStatus(statusMap.success)

    const { width, height } = this.calcCanvasSize()
    const wsUrl = this.buildWsUrl(port, 'spice', `&width=${width}&height=${height}`)

    try {
      const SpiceMainConn = window.spiceHtml5.SpiceMainConn
      // 每次连接尝试递增代际；onerror 仅对"当前这一代"生效，
      // 旧连接的迟到错误（cleanup 触发 stop、或重建后的异步回调）一律忽略，
      // 避免实际仍连着的会话被误标 error 而在 tab 上冒出重连按钮
      const gen = (this._spiceGen = (this._spiceGen || 0) + 1)
      const spiceOpts = {
        uri: wsUrl,
        password: password || '',
        screen_id: this.screenId,
        onsuccess: () => {
          this.setState({
            loading: false,
            connected: true
          })
          // 重连成功：撤掉挂起期间盖在上面的末帧覆盖层，露出新画面
          unfreezeFrame(this.frozenRef.current)
          this.setStatus(statusMap.success)
        },
        onerror: (e) => {
          console.error('[SPICE] Connection error:', e)
          if (this._unmounting) return
          if (this._spiceGen !== gen) return
          this.setState({ loading: false })
          this.setStatus(statusMap.error)
        },
        onagent: () => {}
      }

      this.spiceConn = new SpiceMainConn(spiceOpts)

      this.setState({
        loading: false
      })
    } catch (e) {
      console.error('[SPICE] Connection failed:', e)
      this.setState({ loading: false })
      this.setStatus(statusMap.error)
    }
  }

  handleReInit = () => {
    // 与卸载同口径：stop() 会销毁画布，先归零再停，位图不必等 GC
    this._releaseCanvases()
    this.cleanup()
    this.props.reloadTab(
      this.props.tab
    )
  }

  render () {
    const { loading } = this.state
    const {
      host,
      port,
      username
    } = this.props.tab || {}
    return (
      <SessionShell
        loading={loading}
        fit={this.getFit()}
        wrapClassName='spice-session-wrap'
        onViewportResize={this.handleViewportResize}
        onReconnect={this.handleReInit}
        info={{ username, host, port }}
        displayItems={this.renderDisplayItems()}
        fullscreen={this.props.fullscreen}
        fullscreenIcon={this.props.fullscreenIcon}
        onSendCtrlAltDel={this.handleSendCtrlAltDel}
      >
        <div
          className='spice-session-mount'
          id={this.screenId}
          ref={this.domRef}
          style={{ position: 'relative' }}
        >
          <canvas
            ref={this.frozenRef}
            className='frozen-frame-overlay'
            style={FROZEN_OVERLAY_STYLE}
          />
        </div>
      </SessionShell>
    )
  }
}
