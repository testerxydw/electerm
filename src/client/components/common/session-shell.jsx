/**
 * Shared shell for remote desktop sessions (RDP / VNC / SPICE).
 *
 * Layout is a plain flex column:
 *
 *   [ control bar ]   auto height, wraps when the window is narrow
 *   [ viewport    ]   flex: 1, holds the remote surface
 *
 * The control bar owns a real height instead of being positioned over the
 * surface, so the old "- 10 / - 80" guesses are gone and the surface can
 * never be covered by the bar.
 *
 * The viewport is measured with a ResizeObserver rather than derived from
 * the layout props, because in fullscreen the session is re-parented to the
 * whole window by term-fullscreen.styl and those props are stale. Measured
 * size is what lets the remote surface scale up to fill the screen.
 *
 * The control bar is contracted here (N3), not by each protocol. Left, in
 * order: the connection info, then the session actions - the `onReconnect`
 * icon and the protocol's bar items (`displayItems`: light action icons plus
 * the display controls, and for RDP the file-transfer icons). Right: the
 * fullscreen icon and the `⋮` menu, which stays a list of actions - it is not
 * a settings page, so the controls a user has to see before deciding are not
 * hidden behind it (2026-11-03 decision).
 *
 * The order is the A → B → C contract: "where am I" reads before "what I do
 * to it". Anything that acts on the remote session belongs to the left group;
 * only window-scoped actions (fullscreen, the `⋮` menu) go right. Items are
 * spaced by the group's `column-gap` and sized to sit inside one 32px row
 * (`--session-bar-h`): a narrow window still wraps the bar, but every protocol
 * wraps the same way, so the viewport height stays comparable.
 * See doc/分析-远程会话顶栏差异与统一-2026-10-30.md §3/§5.
 */
import { PureComponent, createRef } from 'react'
import { Spin } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import classnames from 'classnames'
import SessionInfo from './session-info'
import RemoteFloatControl from './remote-float-control'
import './session-shell.styl'

export default class SessionShell extends PureComponent {
  constructor (props) {
    super(props)
    this.viewRef = createRef()
    this.state = {
      width: 0,
      height: 0
    }
  }

  componentDidMount () {
    this.observeViewport()
  }

  componentDidUpdate () {
    // the viewport node is stable, this only re-observes if React swapped it
    this.observeViewport()
  }

  componentWillUnmount () {
    this.unobserveViewport()
  }

  observeViewport = () => {
    const el = this.viewRef.current
    if (!el || this.viewEl === el) {
      return
    }
    this.unobserveViewport()
    this.viewEl = el
    this.observer = new ResizeObserver(this.measureViewport)
    this.observer.observe(el)
    this.measureViewport()
  }

  unobserveViewport = () => {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = null
    }
    this.viewEl = null
  }

  measureViewport = () => {
    const el = this.viewRef.current
    if (!el) {
      return
    }
    const { clientWidth: width, clientHeight: height } = el
    const { width: prevWidth, height: prevHeight } = this.state
    if (width === prevWidth && height === prevHeight) {
      return
    }
    this.setState({
      width,
      height
    })
    this.props.onViewportResize?.(width, height)
  }

  // measured viewport box, 0 until the first layout pass
  getViewportSize = () => {
    const { width, height } = this.state
    return {
      width,
      height
    }
  }

  // the same menu renders twice: inline in the bar (windowed) and floating
  // (fullscreen) - the bar itself is hidden in fullscreen
  getFloatProps = () => {
    const {
      fullscreen,
      onSendCtrlAltDel
    } = this.props
    return {
      isFullScreen: !!fullscreen,
      onSendCtrlAltDel
    }
  }

  render () {
    const {
      loading,
      fit,
      wrapClassName,
      onReconnect,
      info,
      displayItems,
      fullscreenIcon,
      overlay,
      children
    } = this.props
    const cls = classnames(
      'remote-session-wrap',
      'session-v-wrap',
      wrapClassName,
      {
        fit: !!fit
      }
    )
    const floatProps = this.getFloatProps()
    return (
      <Spin
        spinning={!!loading}
        className='remote-session-spin'
      >
        <div className={cls}>
          <div className='remote-session-control session-v-info'>
            <div className='remote-session-control-left'>
              <SessionInfo {...info} />
              <ReloadOutlined
                onClick={onReconnect}
                className='pointer'
              />
              {displayItems}
            </div>
            <div className='remote-session-control-right'>
              {
                fullscreenIcon
                  ? fullscreenIcon()
                  : null
              }
              <RemoteFloatControl
                {...floatProps}
                fixedPosition={false}
                showExitFullscreen={false}
              />
            </div>
          </div>
          <div
            className='remote-session-viewport'
            ref={this.viewRef}
          >
            {children}
          </div>
          {overlay}
          <RemoteFloatControl {...floatProps} />
        </div>
      </Spin>
    )
  }
}
