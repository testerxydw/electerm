/**
 * Session control bar — pane tabs and action icons.
 * On mobile a menu icon is shown; clicking it toggles the control icons.
 */
import {
  PaperClipOutlined,
  ApartmentOutlined,
  MoreOutlined,
  MenuOutlined,
  ColumnWidthOutlined,
  LogoutOutlined,
  PlusOutlined,
  MinusOutlined,
  PlayCircleFilled,
  PauseCircleFilled,
  StopOutlined
} from '@ant-design/icons'
import { Tooltip, Popover } from 'antd'
import classnames from 'classnames'
import { statusText, typeText } from '../status-bar/format'
import {
  paneMap,
  connectionMap,
  terminalSerialType,
  statusMap
} from '../../common/constants'
import { SplitViewIcon } from '../icons/split-view'
import { HeartbeatIcon } from '../icons/heartbeat'
import { rightClickBehaviors } from '../../common/right-click-behavior'
import SessionBarActions from '../common/session-bar-actions'
import SessionBarStatus from '../common/session-bar-status'
import TermSearch from '../terminal/term-search'
import './session-control.styl'

const e = window.translate

export default function SessionControl (props) {
  const {
    tab,
    isMobile,
    isTouchDevice,
    isDisabled,
    isSshDisabled,
    isNotTerminalType,
    canSplitView,
    sftpPathFollowSsh,
    keepaliveEnabled,
    broadcastInput,
    wrapDisabled,
    recording,
    recPaused,
    rightClickBehavior,
    onChangePane,
    toggleCheckSftpPathFollowSsh,
    onSshSftpSplitView,
    toggleKeepalive,
    toggleBroadcastInput,
    toggleWrap,
    toggleSessionRecord,
    toggleSessionRecordPause,
    onFullscreen,
    searchOpen,
    onOpenSearch,
    onOpenContextMenu,
    onExitGracefully,
    onZoomFontSize
  } = props

  if (isNotTerminalType) {
    return null
  }

  const isSsh = !!tab.authType
  const isLocal = !isSsh && (tab.type === connectionMap.local || !tab.type)
  const showSshFeatures = isSsh || isLocal

  // ---- sub-renderers ----

  // 连接信息（host + 状态点 + 状态胶囊）——内容区顶部的"面包屑"（对齐草图 .crumb）
  function renderConnInfo () {
    const { host, status } = tab
    if (!host && !status) {
      return null
    }
    const ok = status === statusMap.success
    return (
      <div className='session-conn-info fleft'>
        <i
          className={classnames(
            'conn-dot',
            ok ? 'ok' : (status ? 'err' : '')
          )}
        />
        <b className='conn-host elli'>{host || e('local')}</b>
        {
          status
            ? (
              <span className={classnames('conn-badge', ok ? 'ok' : 'err')}>
                {statusText(status)}
              </span>
              )
            : null
        }
        {/* 连接类型徽标（对齐草图 .crumb 的 `SSH / zsh` 那一枚；远端 shell 需数据管线，暂只显示类型） */}
        {
          typeText(tab)
            ? <span className='conn-badge'>{typeText(tab)}</span>
            : null
        }
      </div>
    )
  }

  function renderPaneControl () {
    if (isDisabled) {
      return null
    }
    const { sshSftpSplitView, pane } = tab
    if (sshSftpSplitView && canSplitView) {
      return null
    }
    const types = [
      paneMap.terminal,
      paneMap.fileManager
    ]
    const controls = [
      isSsh ? paneMap.ssh : paneMap.terminal
    ]
    if (isSsh || isLocal) {
      controls.push(isSsh ? paneMap.sftp : paneMap.fileManager)
    }
    return (
      <div className='term-sftp-tabs fleft'>
        {
          controls.map((type, i) => {
            const cls = classnames(
              'type-tab',
              type,
              {
                active: types[i] === pane
              }
            )
            return (
              <span
                className={cls}
                key={type + '_' + i}
                onClick={() => onChangePane(types[i])}
              >
                <span className='type-tab-txt'>
                  {e(type)}
                  <span className='type-tab-line' />
                </span>
              </span>
            )
          })
        }
      </div>
    )
  }

  function renderSftpPathFollowControl () {
    if (isDisabled) {
      return null
    }
    const { enableSsh } = tab
    const checkTxt = e('sftpPathFollowSsh')
    const checkProps = {
      onClick: toggleCheckSftpPathFollowSsh,
      className: classnames(
        'sftp-follow-ssh-icon sess-icon pointer',
        {
          active: sftpPathFollowSsh
        }
      )
    }
    return (
      <>
        {
          (isSsh && enableSsh) || isLocal
            ? (
              <Tooltip title={checkTxt}>
                <span {...checkProps}>
                  <PaperClipOutlined />
                </span>
              </Tooltip>
              )
            : null
        }
      </>
    )
  }

  function renderSplitToggle () {
    if (isMobile) {
      return null
    }
    if (!canSplitView || isNotTerminalType || !showSshFeatures) {
      return null
    }
    const title = e('sshSftpSplitView')
    const { sshSftpSplitView } = tab
    const cls = classnames(
      'pointer sess-icon split-view-toggle',
      {
        active: sshSftpSplitView
      }
    )
    return (
      <Tooltip title={title} placement='bottomLeft'>
        <span
          className={cls}
          onClick={onSshSftpSplitView}
        >
          <SplitViewIcon />
        </span>
      </Tooltip>
    )
  }

  function renderKeepaliveIcon () {
    if (isSshDisabled || !showSshFeatures) {
      return null
    }
    const title = e('keepalive')
    const iconProps = {
      className: classnames('sess-icon pointer keepalive-icon', {
        active: keepaliveEnabled
      }),
      onClick: toggleKeepalive
    }
    return (
      <Tooltip title={title}>
        <HeartbeatIcon {...iconProps} />
      </Tooltip>
    )
  }

  function renderBroadcastIcon () {
    if (isSshDisabled || !showSshFeatures) {
      return null
    }
    const title = e('broadcastInput')
    const iconProps = {
      className: classnames('sess-icon pointer broadcast-icon', {
        active: broadcastInput
      }),
      onClick: toggleBroadcastInput
    }
    return (
      <Tooltip title={title}>
        <ApartmentOutlined {...iconProps} />
      </Tooltip>
    )
  }

  // T5-4d/T5-4f: 录制开关上顶栏 (与 keepalive/broadcast 同形态)。状态源 store.recState
  // (父级 session.jsx render 读取后传 recording/recPaused prop, manate 追踪在父级);
  // 三态: 未录制 Play 开始 / 录制中 Stop 停止+Pause 暂停 / 暂停中 Stop 停止+Play 继续,
  // 图标只做快捷控制, 不打开终端日志页。
  function renderRecordIcon () {
    const title = e(recording ? 'stopRecord' : 'record')
    const iconProps = {
      className: classnames('sess-icon pointer session-record-toggle', {
        active: recording
      }),
      onClick: toggleSessionRecord
    }
    const pauseTitle = window.capitalizeFirstLetter(e(recPaused ? 'resume' : 'pause'))
    return (
      <>
        <Tooltip title={title}>
          {recording ? <StopOutlined {...iconProps} /> : <PlayCircleFilled {...iconProps} />}
        </Tooltip>
        {
          recording
            ? (
              <Tooltip title={pauseTitle}>
                {
                  recPaused
                    ? (
                      <PlayCircleFilled
                        className='sess-icon pointer session-record-pause'
                        onClick={toggleSessionRecordPause}
                      />
                      )
                    : (
                      <PauseCircleFilled
                        className='sess-icon pointer session-record-pause'
                        onClick={toggleSessionRecordPause}
                      />
                      )
                }
              </Tooltip>
              )
            : null
        }
      </>
    )
  }

  function renderWrapIcon () {
    const title = e(wrapDisabled ? 'enableWrap' : 'disableWrap')
    const iconProps = {
      className: classnames('sess-icon pointer wrap-toggle-icon', {
        active: wrapDisabled
      }),
      onClick: toggleWrap
    }
    return (
      <Tooltip title={title}>
        <ColumnWidthOutlined {...iconProps} />
      </Tooltip>
    )
  }

  function renderExitGracefullyIcon () {
    if (tab.type !== terminalSerialType) {
      return null
    }
    const title = e('exitGracefully')
    return (
      <Tooltip title={title}>
        <LogoutOutlined
          className='sess-icon pointer exit-gracefully-icon'
          onClick={onExitGracefully}
        />
      </Tooltip>
    )
  }

  // S1：查找/全屏改走共享动作组件（三页同位置同口径）
  function renderBarActions () {
    return (
      <SessionBarActions
        searchOpen={searchOpen}
        onToggleSearch={onOpenSearch}
        onFullscreen={onFullscreen}
      />
    )
  }

  // T5-2d：会话信息三段（ssh2 算法 / zsh 版本 / ↑↓ 速率），公共组件一行调用
  function renderBarStatus () {
    return (
      <SessionBarStatus tab={tab} />
    )
  }

  function renderFontSizeIcons () {
    // touch screens have no ctrl +/- shortcut to resize the terminal font,
    // so the icons only show there — driven by store.isTouchDevice, which
    // follows the input the user is actually using (see main.jsx).
    if (!isTouchDevice) {
      return null
    }
    const cls = 'mg1r icon-info iblock pointer spliter font-size-control-icon'
    return (
      <>
        <MinusOutlined
          className={cls}
          onClick={() => onZoomFontSize(-1)}
        />
        <PlusOutlined
          className={cls}
          onClick={() => onZoomFontSize(1)}
        />
      </>
    )
  }

  /**
   * Touch devices have no right click, so the terminal's context menu needs a
   * visible way in: this icon, next to the fullscreen icon on the desktop
   * toolbar and next to the three-dot toggle in the mobile one (see below).
   * Hidden when there is no menu to open — right click behaviour 'paste' and
   * 'passthrough' both drop the menu (see right-click-behavior.js), and the
   * setting only ever acts on the terminal pane.
   */
  function renderContextMenuIcon (inMobileBar) {
    if (
      !isTouchDevice ||
      rightClickBehavior !== rightClickBehaviors.context ||
      tab.pane !== paneMap.terminal
    ) {
      return null
    }
    const cls = classnames(
      'iblock pointer spliter context-menu-control-icon',
      inMobileBar ? 'mobile-context-menu-toggle' : 'mg1r icon-info'
    )
    return (
      <MenuOutlined
        className={cls}
        onClick={onOpenContextMenu}
      />
    )
  }

  function renderTermControls (skipContextMenuIcon) {
    const { pane } = tab
    if (pane !== paneMap.terminal) {
      return null
    }
    return (
      <div className='fright term-controls'>
        {/* 统一查找条：顶栏内联展开，位于查找按钮左侧（与数据库页同形态） */}
        <TermSearch tab={tab} />
        {renderFontSizeIcons()}
        {skipContextMenuIcon ? null : renderContextMenuIcon()}
        {renderBarActions()}
      </div>
    )
  }

  // ---- mobile ----

  if (isMobile) {
    const extraIcons = (
      <div className='mobile-control-icons'>
        {renderSftpPathFollowControl()}
        {renderKeepaliveIcon()}
        {renderBroadcastIcon()}
        {renderRecordIcon()}
        {renderWrapIcon()}
        {renderExitGracefullyIcon()}
        {renderTermControls(true)}
      </div>
    )
    return (
      <div className='terminal-control mobile-session-control'>
        {renderPaneControl()}
        {renderContextMenuIcon(true)}
        <Popover
          content={extraIcons}
          trigger='click'
          placement='bottomRight'
        >
          <MoreOutlined className='mobile-control-toggle pointer' />
        </Popover>
      </div>
    )
  }

  // ---- desktop ----
  return (
    <div className='terminal-control fix'>
      {renderConnInfo()}
      {renderPaneControl()}
      {renderBarStatus()}
      {renderSftpPathFollowControl()}
      {renderSplitToggle()}
      {renderKeepaliveIcon()}
      {renderBroadcastIcon()}
      {renderRecordIcon()}
      {renderWrapIcon()}
      {renderExitGracefullyIcon()}
      {renderTermControls()}
    </div>
  )
}
