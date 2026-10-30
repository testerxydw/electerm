/**
 * terminal/sftp wrapper
 */
import { createRef, lazy, Suspense } from 'react'
import { Component } from 'manate/react/class-components'
import Term from '../terminal/terminal.jsx'
import Sftp from '../sftp/sftp-entry'
import {
  FullscreenOutlined
} from '@ant-design/icons'
import {
  Tooltip,
  Splitter
} from 'antd'
import { pick } from 'lodash-es'
import copy from 'json-deep-copy'
import classnames from 'classnames'
import {
  paneMap,
  terminalRdpType,
  terminalVncType,
  terminalWebType,
  terminalFtpType,
  terminalSpiceType,
  terminalDatabaseType
} from '../../common/constants'
import { refs } from '../common/ref'
import sanitizeFilename from '../../common/sanitize-filename.js'
import { getRightClickBehavior } from '../../common/right-click-behavior.js'
import SessionRecIndicator from '../common/session-rec-indicator'
import BroadcastBar from './broadcast-bar.jsx'
import SessionControl from './session-control'
import LazyBoundary from '../common/lazy-boundary'
import './session.styl'

const RdpSession = lazy(() => import('../rdp/rdp-session'))
const VncSession = lazy(() => import('../vnc/vnc-session'))
const DbSession = lazy(() => import('../database/db-session'))
const WebSession = lazy(() => import('../web/web-session.jsx'))
const SpiceSession = lazy(() => import('../spice/spice-session'))
const e = window.translate
const SplitterPane = Splitter.Panel

export default class SessionWrapper extends Component {
  constructor (props) {
    super(props)
    this.domRef = createRef()
    this.state = {
      cwd: '',
      sftpPathFollowSsh: !!props.config.sftpPathFollowSsh,
      key: Math.random(),
      splitSize: [50, 50],
      sessionOptions: null,
      wrapDisabled: false
    }
    if (props.tab.sshSftpSplitView === undefined) {
      props.tab.sshSftpSplitView = !!props.config.sshSftpSplitView
    }
  }

  minWithForSplit = 640
  minHeightForSplit = 400

  getDom = () => {
    return this.domRef.current
  }

  isDisabled = () => {
    const { enableSsh, enableSftp } = this.props.tab
    return enableSsh === false || enableSftp === false
  }

  isSshDisabled = () => {
    return this.props.tab.enableSsh === false
  }

  isSftpDisabled = () => {
    return this.props.tab.enableSftp === false
  }

  handleSshSftpSplitView = () => {
    const nv = !this.props.tab.sshSftpSplitView
    this.editTab({
      sshSftpSplitView: nv
    })
    window.store.triggerResize()
  }

  canSplitView = () => {
    const {
      width,
      height
    } = this.props
    if (this.isDisabled()) {
      return false
    }
    return width > this.minWithForSplit ||
      height > this.minHeightForSplit
  }

  getSplitDirection = () => {
    const {
      sshSftpSplitView
    } = this.props.tab
    if (!sshSftpSplitView || !this.canSplitView()) {
      return 'tabed'
    }
    const {
      width,
      height
    } = this.props
    const ratio = width / height
    const baseRatio = this.minWithForSplit / this.minHeightForSplit
    const wider = ratio > baseRatio
    return wider ? 'leftRight' : 'topDown'
  }

  handleClick = () => {
    window.store.activeTabId = this.props.tab.id
  }

  onDrop = (e) => {
    e.preventDefault()
    const { target } = e
    if (!target) {
      return
    }
    let fromTab
    try {
      fromTab = JSON.parse(e.dataTransfer.getData('fromFile'))
    } catch (e) {
      return
    }
    const onDropElem = this.getDom()
    const { batch } = this.props.tab
    if (!onDropElem || !fromTab || fromTab.batch === batch) {
      return
    }
    const { store } = window
    const { tabs } = store
    const t = tabs.find(t => t.id === fromTab.id)
    if (!t) {
      return
    }
    // Handle currentTab change if needed
    const fromBatch = fromTab.batch
    if (window.store[`activeTabId${fromBatch}`] === fromTab.id && fromBatch !== batch) {
      // Find next tab in the same batch
      const nextTab = tabs.find((t, i) =>
        t.id !== fromTab.id && t.batch === fromBatch
      )
      window.store[`activeTabId${fromBatch}`] = nextTab ? nextTab.id : ''
    }
    t.batch = batch
    // 原窗格被搬空则自动收起（配置开关 autoCloseEmptyPane）
    window.store.autoClosePaneIfEmpty(Number(fromBatch))
    this.clearCls()
  }

  clearCls = () => {
    this.getDom()?.classList.remove('drag-over')
  }

  addCls = () => {
    this.getDom()?.classList.add('drag-over')
  }

  onDragEnter = () => {
    this.addCls()
  }

  onDragLeave = (e) => {
    this.clearCls()
  }

  onDragEnd = (e) => {
    this.clearCls()
    e && e.dataTransfer && e.dataTransfer.clearData()
  }

  setCwd = (cwd) => {
    this.setState({
      cwd
    })
  }

  toggleCheckSftpPathFollowSsh = () => {
    this.setState(prevState => ({
      sftpPathFollowSsh: !prevState.sftpPathFollowSsh
    }))
  }

  editTab = (up) => {
    const {
      tab,
      editTab
    } = this.props
    editTab(
      tab.id,
      up
    )
  }

  onChangePane = pane => {
    const update = {
      pane
    }
    if (pane === paneMap.fileManager) {
      this.setState({
        enableSftp: true
      })
    }
    this.editTab(update)
  }

  computePosition = (index) => {
    return {
      left: 0,
      top: 0
    }
  }

  getWidth = () => {
    return this.props.width
  }

  renderTerminals = () => {
    const {
      sessionOptions,
      sftpPathFollowSsh
    } = this.state
    const {
      tab
    } = this.props
    const {
      pane, type, sshSftpSplitView
    } = tab
    if (type === terminalDatabaseType) {
      // 数据库页自己渲染 32px 工具条（.db-head，高度 = --session-bar-h），
      // 内容高由 .session-wrap 的竖向 flex 分配（T3a）：页面根不再需要
      // "H - tabsHeight" 这类算术，也不会随顶栏高度变化而失效
      const { width } = this.calcTermWidthHeight()
      const dbProps = {
        tab,
        width
      }
      return (
        <div
          className='db-session-box'
          style={{ width }}
        >
          <LazyBoundary>
            <DbSession
              {...dbProps}
            />
          </LazyBoundary>
        </div>
      )
    }
    if (type === terminalWebType) {
      const webProps = {
        tab,
        width: this.props.width,
        reloadTab: this.props.reloadTab
      }
      return (
        <LazyBoundary>
          <WebSession
            {...webProps}
          />
        </LazyBoundary>
      )
    }
    if (type === terminalRdpType || type === terminalVncType || type === terminalSpiceType) {
      // 尺寸一律走 SessionShell 的 ResizeObserver（实测），不要再下发
      // width/height：全屏时布局高是旧值，传下去只会变成错误的首连尺寸
      const rdpProps = {
        tab: this.props.tab,
        ...pick(this.props, [
          'resolutions',
          'tabsHeight',
          'pinned',
          'delTab',
          'config',
          'reloadTab',
          'editTab',
          'fullscreen'
        ]),
        ...pick(
          this,
          [
            'fullscreenIcon'
          ])
      }
      if (type === terminalVncType) {
        return (
          <LazyBoundary>
            <VncSession
              {...rdpProps}
            />
          </LazyBoundary>
        )
      }
      if (type === terminalSpiceType) {
        return (
          <LazyBoundary>
            <SpiceSession
              {...rdpProps}
            />
          </LazyBoundary>
        )
      }

      return (
        <LazyBoundary>
          <RdpSession
            {...rdpProps}
          />
        </LazyBoundary>
      )
    }

    if (type === terminalFtpType) {
      const ftpProps = {
        ...this.props,
        ...pick(this, [
          'onChangePane',
          'setCwd'
        ]),
        isFtp: true
      }
      return (
        <Sftp
          {...ftpProps}
        />
      )
    }

    const cls = pane === paneMap.terminal ||
      (sshSftpSplitView && this.canSplitView())
      ? 'terms-box'
      : 'terms-box hide'
    const {
      width,
      height
    } = this.calcTermWidthHeight()
    const themeConfig = copy(window.store.getThemeConfig())
    const logName = sanitizeFilename(`${tab.title ? tab.title + '_' : ''}${tab.host ? tab.host + '_' : ''}${tab.id}`)
    const pops = {
      ...this.props,
      sftpPathFollowSsh,
      themeConfig,
      pane,
      ...pick(
        this,
        [
          'onChangePane',
          'setCwd'
        ]),
      ...this.computePosition(),
      width,
      height
    }
    return (
      <div
        className={cls}
        style={{
          width,
          height
        }}
      >
        <Term
          logName={logName}
          sessionOptions={sessionOptions}
          {...pops}
        />
        {/* G1 广播红条：浮在终端内容顶部，只在主控 tab 里出现 */}
        <BroadcastBar tabId={tab.id} />
      </div>
    )
  }

  isNotTerminalType = () => {
    const { type } = this.props.tab
    // telnet 不在名单内（S1）：它本质是终端，与 ssh 同路径走 SessionControl，
    // 由此获得查找/全屏等窗口级动作（此前整类缺失）
    return type === terminalRdpType ||
      type === terminalVncType ||
      type === terminalWebType ||
      type === terminalFtpType ||
      type === terminalSpiceType ||
      // 数据库页有自己的顶部工具条（引擎/目标/状态/只读/刷新），
      // 终端那条 SessionControl 的「本地/未连接/终端」对它没有意义，故一并归入"非终端"
      type === terminalDatabaseType
  }

  // SFTP 侧高度不再由 JS 给：外层是 flex 列（.term-sftp-box → Splitter →
  // .sftp-pane-wrap → .sftp-wrap），高度由浏览器分配。此前按布局高扣减的 px
  // 在分屏/全屏下都会和实际容器错位（全屏 SFTP 底部留白即由此而来）。
  calcSftpWidth = () => {
    const {
      width
    } = this.props
    if (!this.canSplitView() || !this.props.tab.sshSftpSplitView) {
      return width
    }
    const direction = this.getSplitDirection()
    const [, size2] = this.state.splitSize
    return direction === 'leftRight' ? size2 * width / 100 : width
  }

  calcTermWidthHeight = () => {
    const width = this.getWidth()
    const height = this.props.computeHeight(
      this.props.height
    )
    if (!this.canSplitView() || !this.props.tab.sshSftpSplitView) {
      return {
        width,
        height
      }
    }
    const direction = this.getSplitDirection()
    const [size1] = this.state.splitSize
    const w = direction === 'leftRight' ? size1 * width / 100 : width
    const h = direction === 'leftRight' ? height : size1 * height / 100
    return {
      width: w,
      height: h
    }
  }

  renderSftp = () => {
    const {
      sessionOptions,
      enableSftp,
      sftpPathFollowSsh,
      cwd
    } = this.state
    const { pane, id, sshSftpSplitView } = this.props.tab
    if (
      this.isNotTerminalType() ||
      this.isSftpDisabled()
    ) {
      return null
    }
    const cls = pane === paneMap.fileManager ||
    (sshSftpSplitView && this.canSplitView())
      ? ''
      : 'hide'
    const width = this.calcSftpWidth()
    const exts = {
      ...this.props,
      sftpPathFollowSsh,
      sshSftpSplitView,
      cwd,
      pid: id,
      enableSftp,
      sessionOptions,
      width,
      pane
    }
    return (
      <div className={classnames('sftp-pane-wrap', cls)}>
        <Sftp
          {...exts}
        />
      </div>
    )
  }

  handleFullscreen = () => {
    // Make this tab the active tab before fullscreening
    window.store.activeTabId = this.props.tab.id
    window.store.toggleSessFullscreen(true, this.props.tab.id)
  }

  toggleKeepalive = () => {
    const term = refs.get('term-' + this.props.tab.id)
    if (!term) {
      return
    }
    // The flag lives on the tab (not in this component's state) so the
    // toolbar icon and the MCP set_electerm_terminal_keepalive tool share
    // one source of truth — an MCP-driven change must light the icon up.
    const enabled = term.toggleKeepalive()
    this.editTab({ keepaliveEnabled: enabled })
  }

  handleExitGracefully = () => {
    refs.get('term-' + this.props.tab.id)?.exitGracefully()
  }

  handleOpenSearch = () => {
    refs.get('term-' + this.props.tab.id)?.toggleSearch()
  }

  // touch-only: the toolbar menu icon opens the same context menu a right
  // click (or a long press) does, anchored just below the icon itself
  handleOpenContextMenu = (evt) => {
    const term = refs.get('term-' + this.props.tab.id)
    if (!term) {
      return
    }
    const rect = evt.currentTarget.getBoundingClientRect()
    term.openContextMenuAtPoint(rect.left, rect.bottom)
  }

  handleZoomFontSize = (v) => {
    const term = refs.get('term-' + this.props.tab.id)
    if (!term?.term) {
      return
    }
    term.zoom(v)
    term.term.focus()
  }

  toggleWrap = () => {
    const termRef = refs.get('term-' + this.props.tab.id)
    if (!termRef?.term) {
      return
    }
    const next = !this.state.wrapDisabled
    // DECAWM escape sequence: ?7l = disable wrap, ?7h = enable wrap
    termRef.term.write(next ? '\x1b[?7l' : '\x1b[?7h')
    this.setState({ wrapDisabled: next })
  }

  fullscreenIcon = () => {
    const title = e('fullscreen')
    return (
      <Tooltip title={title} placement='bottomLeft'>
        <FullscreenOutlined
          className='mg1r icon-info iblock pointer spliter fullscreen-control-icon'
          onClick={this.handleFullscreen}
        />
      </Tooltip>
    )
  }

  isSsh = () => {
    const { tab } = this.props
    return tab.authType
  }

  onSplitResize = (sizes) => {
    const direction = this.getSplitDirection()
    const {
      width
    } = this.props
    // antd Splitter 的 onResize/onResizeEnd 给的是**像素**值，除以容器在该方向上
    // 的实际尺寸才是百分比。纵向分屏暂沿用 computeHeight(height)（普通窗口下与
    // flex 分配出的容器高一致）；全屏下的实测分母在 T4 一并替换
    const all = direction === 'leftRight'
      ? width
      : this.props.computeHeight(this.props.height)
    const size = sizes.map(d => d * 100 / all)
    this.setState({
      splitSize: size
    })
  }

  renderViews = () => {
    // 数据库页没有 sftp 分栏，与 RDP/Web 一样走「无分栏」路径
    if (this.isNotTerminalType()) {
      return this.renderTerminals()
    }
    const notSplitVew = !this.canSplitView() || !this.props.tab.sshSftpSplitView
    const { pane } = this.props.tab
    const show1 = notSplitVew && pane === paneMap.terminal
    const show2 = notSplitVew && pane === paneMap.fileManager
    const direction = this.getSplitDirection()
    const layout = direction === 'leftRight' ? 'horizontal' : 'vertical'
    const [size1, size2] = this.state.splitSize
    const splitterProps = {
      orientation: layout,
      onResize: this.onSplitResize,
      onResizeEnd: this.onSplitResize,
      className: notSplitVew ? 'not-split-view' : '',
      style: {
        width: this.props.width + 'px'
      }
    }
    const paneProps = {
      min: '20%',
      max: '80%',
      style: {
        overflow: 'hidden'
      }
    }
    const s1 = show1
      ? '100%'
      : show2
        ? '0%'
        : size1 + '%'
    const s2 = show2
      ? '100%'
      : show1
        ? '0%'
        : size2 + '%'
    const paneProps1 = {
      ...paneProps,
      size: s1
    }
    const paneProps2 = {
      ...paneProps,
      size: s2
    }
    return (
      <Splitter {...splitterProps}>
        <SplitterPane {...paneProps1}>
          {this.renderTerminals()}
        </SplitterPane>
        <SplitterPane {...paneProps2}>
          {this.renderSftp()}
        </SplitterPane>
      </Splitter>
    )
  }

  render () {
    const { pane } = this.props.tab
    // T5-4c: 录制中浮层。render 里读 recState 让 manate 追踪 (开/停录触发重渲染),
    // 仅终端类 tab 显示 (数据库/桌面/网页页无会话录制)
    const rec = window.store.recState[this.props.tab.id]
    // G1 广播：状态源在 store.broadcast（addon 扇出读同一份），此处只驱动顶栏灯态
    const broadcast = window.store.broadcast
    const broadcastActive = !!broadcast.on &&
      broadcast.sourceTabId === this.props.tab.id
    const recIndicator = this.isNotTerminalType()
      ? null
      : (
        <SessionRecIndicator
          recording={!!rec}
          paused={!!rec?.paused}
          startTime={rec?.startTime || 0}
          recPath={rec?.path}
          tabId={this.props.tab.id}
        />
        )
    const cls = classnames(
      'term-sftp-box',
      pane,
      {
        'is-transporting': this.props.tab.isTransporting
      },
      {
        'disable-ssh': this.props.tab.enableSsh === false
      }
    )
    const divProps = {
      className: cls,
      onDragEnter: this.onDragEnter,
      onDragLeave: this.onDragLeave,
      onDrop: this.onDrop,
      onDragEnd: this.onDragEnd,
      onClick: this.handleClick
    }
    return (
      <div
        ref={this.domRef}
        {...divProps}
      >
        <SessionControl
          tab={this.props.tab}
          isMobile={window.store.isMobile}
          isTouchDevice={window.store.isTouchDevice}
          isDisabled={this.isDisabled()}
          isSshDisabled={this.isSshDisabled()}
          isNotTerminalType={this.isNotTerminalType()}
          canSplitView={this.canSplitView()}
          sftpPathFollowSsh={this.state.sftpPathFollowSsh}
          keepaliveEnabled={!!this.props.tab.keepaliveEnabled}
          broadcastInput={broadcastActive}
          broadcastCount={broadcastActive ? broadcast.targets.length : 0}
          wrapDisabled={this.state.wrapDisabled}
          // T5-4d: 录制开关上顶栏, 状态在此读 recState (manate 追踪点) 传下去
          recording={!!rec}
          recPaused={!!rec?.paused}
          rightClickBehavior={getRightClickBehavior(this.props.config)}
          onChangePane={(pane) => this.onChangePane(pane)}
          toggleCheckSftpPathFollowSsh={this.toggleCheckSftpPathFollowSsh}
          onSshSftpSplitView={this.handleSshSftpSplitView}
          toggleKeepalive={this.toggleKeepalive}
          toggleBroadcastInput={() => window.store.toggleBroadcast()}
          toggleWrap={this.toggleWrap}
          toggleSessionRecord={() => window.store.toggleSessionRecord(this.props.tab.id)}
          toggleSessionRecordPause={() => window.store.toggleSessionRecordPause(this.props.tab.id)}
          onFullscreen={this.handleFullscreen}
          onZoomFontSize={this.handleZoomFontSize}
          searchOpen={!!window.store.termSearchOpen}
          onOpenSearch={this.handleOpenSearch}
          onOpenContextMenu={this.handleOpenContextMenu}
          onExitGracefully={this.handleExitGracefully}
        />
        {recIndicator}
        <Suspense fallback={null}>
          {this.renderViews()}
        </Suspense>
      </div>
    )
  }
}
