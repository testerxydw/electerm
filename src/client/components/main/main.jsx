import { auto } from 'manate/react'
import { lazy, Suspense, useEffect } from 'react'
import Layout from '../layout/layout'
import FileInfoModal from '../sftp/file-info-modal'
import FileCompareModal from '../sftp/file-compare-modal'
import FilePreviewModal from '../sftp/file-preview-modal'
import RemoteArchiveModal from '../sftp/remote-archive-modal'
import UpdateCheck from './upgrade'
import SettingModal from '../setting-panel/setting-modal'
import TextEditor from '../text-editor/text-editor-entry'
import Sidebar from '../sidebar'
import CssOverwrite from '../bg/css-overwrite'
import UiTheme from './ui-theme'
import TitleBarOverlay from './title-bar-overlay'
import CustomCss from '../bg/custom-css.jsx'
import TerminalInteractive from '../terminal/terminal-interactive'
import ConfirmModalStore from '../file-transfer/conflict-resolve.jsx'
import TransferQueue from '../file-transfer/transfer-queue'
import Remote2RemoteHandlers from '../file-transfer/remote2remote-handlers.jsx'
import TerminalCmdSuggestions from '../terminal/terminal-command-dropdown'
import TransportsActionStore from '../file-transfer/transports-action-store.jsx'
import classnames from 'classnames'
import ShortcutControl from '../shortcuts/shortcut-control.jsx'
import {
  footerHeight,
  isMac,
  isWin,
  quickCommandBoxHeight,
  remoteMonitorBarHeight,
  shortcutBarHeight,
  terminalRdpType,
  terminalSpiceType,
  terminalVncType,
  textTerminalBgValue
} from '../../common/constants'
import { isAIDisabled } from '../../common/ai-feature'
import { resolveBottomStack } from '../../common/bottom-stack'
import { ConfigProvider } from 'antd'
import { NotificationContainer } from '../common/notification'
import RightSidePanel from '../side-panel-r/side-panel-r'
import CmdHistory from '../footer/cmd-history'
import QuickCommandsFooterBox from '../quick-commands/quick-commands-box'
import ConnectionHoppingWarning from './connection-hopping-warnning'
import SshConfigLoadNotify from '../ssh-config/ssh-config-load-notify'
import LoadSshConfigs from '../ssh-config/load-ssh-configs'
import AIChat from '../ai/ai-chat-entry'
import MoveItemModal from '../tree-list/move-item-modal'
import InputContextMenu from '../common/input-context-menu'
import WorkspaceSaveModal from '../tabs/workspace-save-modal'
import BookmarkFromHistoryModal from '../bookmark-form/bookmark-from-history-modal'
import AutoSync from '../setting-sync/auto-sync'
import BatchOpRunner from '../batch-op/batch-op-runner'
import UnixTimestampTooltip from '../terminal/unix-timestamp-tooltip'
import ImportProgress from '../common/import-progress.jsx'
import { pick } from 'lodash-es'
import './wrapper.styl'
import TerminalInfo from '../terminal-info/terminal-info-entry'
import ShortcutBarEntry from '../terminal/shortcut-bar-entry'
import LazyBoundary from '../common/lazy-boundary'
import CommandPalette from '../command-palette'
import MonitorPanel from '../remote-monitor/monitor-panel'
import TransferPanel from '../file-transfer/transfer-panel'
import { isRemoteMonitorBarVisible } from '../remote-monitor/visibility'
import { normalizeLeftSideBarIcons } from '../../common/left-sidebar-icon-defs'
import '../../common/fs.js'
import './term-fullscreen.styl'

const Resolutions = lazy(() => import('../rdp/resolution-edit'))
const InfoModal = lazy(() => import('../sidebar/info-modal.jsx'))
const AuditCenter = lazy(() => import('../terminal/audit-center.jsx'))
const AIConfigModal = lazy(() => import('../ai/ai-config-modal'))
// window opacity is electron-only: lazy so the web app never loads the chunk
const Opacity = lazy(() => import('../common/opacity'))

export default auto(function Index (props) {
  useEffect(() => {
    const { store } = props
    window.addEventListener('resize', store.onResize)
    // store.height 初值是占位的 500，挂载后校准一次实测窗口高度
    setTimeout(store.onResize, 200)
    const { ipcOnEvent } = window.pre
    ipcOnEvent('checkupdate', store.onCheckUpdate)
    ipcOnEvent('open-about', store.openAbout)
    ipcOnEvent('new-ssh', store.onNewSsh)
    ipcOnEvent('add-tab-from-command-line', store.addTabFromCommandLine)
    ipcOnEvent('open-tab', (e, parsed) => store.ipcOpenTab(parsed))
    ipcOnEvent('openSettings', store.openSetting)
    ipcOnEvent('selectall', store.selectall)
    ipcOnEvent('focused', store.focus)
    ipcOnEvent('blur', store.onBlur)
    ipcOnEvent('zoom-reset', store.onZoomReset)
    ipcOnEvent('zoomin', store.onZoomIn)
    ipcOnEvent('zoomout', store.onZoomout)
    ipcOnEvent('confirm-exit', store.beforeExitApp)

    document.addEventListener('drop', function (e) {
      e.preventDefault()
      e.stopPropagation()
    })
    document.addEventListener('dragover', function (e) {
      e.preventDefault()
      e.stopPropagation()
    })
    window.addEventListener('offline', store.setOffline)
    // 网络恢复时复位被 offline 误报标成"连接失败"但仍活着的会话
    window.addEventListener('online', store.restoreOnline)
    // 退出/刷新前自动保存会话快照, 供下次启动恢复上次 tab 页。
    // 桌面端原无 onbeforeunload (退出确认走主进程), 这里仅保存快照不碰 returnValue;
    // webapp 端同时走 beforeExit 的退出确认。
    window.onbeforeunload = evt => {
      store.saveLastWorkspace()
      if (window.et.isWebApp) {
        store.beforeExit(evt)
      }
    }
    store.isSecondInstance = window.pre.runSync('isSecondInstance')
    store.initData()
    store.checkForDbUpgrade()
    store.handleGetSerials()
    store.checkPendingDeepLink()
    store.checkPendingVvFile()
  }, [])

  // Track the actual input modality rather than a static capability probe:
  // a touch-capable laptop is a mouse machine until a real touch happens,
  // and a tablet stays touch even though it can also pair a mouse. Stored in
  // `store.isTouchDevice` (seeded false — no upfront probe, which only says
  // the screen *can* be touched, not what the user operates with); the
  // `is-touch-device` class drives always-visible hover-only action icons, so
  // it must follow the device the user is actually operating.
  useEffect(() => {
    const { store } = window
    const handlePointer = (e) => {
      if (e.pointerType === 'mouse') {
        store.isTouchDevice = false
      } else if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        store.isTouchDevice = true
      }
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('pointermove', handlePointer)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('pointermove', handlePointer)
    }
  }, [])

  const { store } = props
  const {
    configLoaded,
    config,
    fullscreen,
    pinned,
    isSecondInstance,
    pinnedQuickCommandBar,
    quickCommandsInRightPanel,
    installSrc,
    fileTransfers,
    uiThemeConfig,
    transferHistory,
    transferToConfirm,
    openResolutionEdit,
    rightPanelTitle,
    rightPanelTab,
    widgetInstances
  } = store
  // 这些 props 只被下游读取；浅拷贝即可得到新引用触发 memo/PureComponent 更新，
  // 无需递归深拷贝（嵌套字段均只读）
  const upgradeInfo = { ...store.upgradeInfo }
  const remoteMonitorBarVisible = isRemoteMonitorBarVisible(store)
  // GUI 远程桌面页（rdp/vnc/spice）：inTerminalTab 为底栏可见性把它与终端
  // 同等对待，但全屏时底栏不能保留（否则压住远程桌面下缘）
  const guiRemoteTab = [
    terminalRdpType,
    terminalVncType,
    terminalSpiceType
  ].includes(store.currentTab?.type)
  const cls = classnames({
    loaded: configLoaded,
    'not-webapp': !window.et.isWebApp,
    // the frame is the system one (macOS traffic lights, Linux/Windows title
    // bar). Also true in Windows WCO mode, where the caption buttons are drawn
    // over the tab bar and there is no title strip: the UI asks "is there a
    // strip?" via store.hasNativeTitleStrip, not via this class.
    'system-ui': store.isSystemTitleBar,
    'not-system-ui': !store.isSystemTitleBar,
    wco: store.isWindowControlsOverlay,
    'is-mac': isMac,
    'not-mac': !isMac,
    'is-win': isWin,
    // The left sidebar dock is desktop-only (see sidebar/index.jsx). This
    // class drives the docked-layout CSS — the footer's left offset and the
    // sidebar panel's top padding — so it has to follow the same gate as the
    // layout maths in layout.jsx, or a pin persisted from a desktop session
    // would restyle the mobile layout.
    pinned: pinned && !store.isMobile,
    'not-win': !isWin,
    // the pinned quick-command box only shapes the layout while it is actually
    // in the footer — docked in the right panel it renders there instead
    'qm-pinned': pinnedQuickCommandBar && !quickCommandsInRightPanel,
    fullscreen,
    // terminal fullscreen keeps the footer visible (rdp/vnc/spice fullscreen
    // does not: their tab type is excluded above, the footer would cover the
    // remote desktop)
    'fs-with-footer': fullscreen && store.inActiveTerminal && !guiRemoteTab,
    'is-main': !isSecondInstance,
    'is-mobile': store.isMobile,
    'is-desktop': !store.isMobile,
    'is-touch-device': store.isTouchDevice,
    'remote-monitor-bar-on': remoteMonitorBarVisible
  })
  // 底栏避让与 layout.jsx 同一个和式：浮层各取一个派生值，不再各挑子集
  const monitorHeight = remoteMonitorBarVisible ? remoteMonitorBarHeight : 0
  const qmPinnedHeight = pinnedQuickCommandBar &&
    !quickCommandsInRightPanel &&
    store.inActiveTerminal
    ? quickCommandBoxHeight
    : 0
  const bottomStack = resolveBottomStack({
    footer: footerHeight,
    monitor: monitorHeight,
    qm: qmPinnedHeight,
    shortcut: store.shortcutBarVisible ? shortcutBarHeight : 0,
    kbOffset: store.shortcutBarVisible ? store.shortcutBarKbOffset : 0
  })
  const ext1 = {
    className: cls,
    style: {
      '--left-side-bar-width': store.leftSideBarWidth + 'px',
      // 过渡期保留（T3 后清理）：底栏三合一后的常显区与钉住的快捷命令带
      '--footer-stack-height': `${footerHeight + monitorHeight}px`,
      '--qm-bar-h': `${qmPinnedHeight}px`,
      // 新口径：footer / 监控条 / 侧栏等浮层各取对应派生值
      '--below-footer-h': `${bottomStack.belowFooter}px`,
      '--below-monitor-h': `${bottomStack.belowMonitor}px`,
      '--bottom-reserved-h': `${bottomStack.reserved}px`
    }
  }
  // Get active tab IDs
  const activeTabIds = [
    store.activeTabId0,
    store.activeTabId1,
    store.activeTabId2,
    store.activeTabId3
  ].filter(Boolean) // Remove empty strings

  const bgTabs = config.terminalBackgroundImagePath === 'index' ||
                  config.terminalBackgroundImagePath === 'randomShape' ||
                  config.terminalBackgroundImagePath === textTerminalBgValue
    ? store.getTabs().filter(tab => activeTabIds.includes(tab.id))
    : store.getTabs().filter(tab =>
      activeTabIds.includes(tab.id) && tab.terminalBackground?.terminalBackgroundImagePath
    )
  const confsCss = {
    ...Object.keys(config)
      .filter(d => d.startsWith('terminalBackground'))
      .reduce((p, k) => ({
        ...p,
        [k]: config[k]
      }), {}),
    activeTabIds,
    tabs: bgTabs.map(tab => {
      return {
        tabCount: tab.tabCount,
        terminalBackground: tab.terminalBackground,
        id: tab.id
      }
    })
  }
  const themeProps = {
    themeConfig: store.getUiThemeConfig()
  }
  // 传输列表/历史每项只做顶层浅拷贝：Transfer 组件会写 transfer.toPath，
  // 浅拷贝已隔离该写入；深层字段（路径/配置）下游只读
  const copiedTransfer = fileTransfers.map(t => ({ ...t }))
  const copiedHistory = transferHistory.map(t => ({ ...t }))
  // TransportsActionStore 只关心「谁、是否已初始化/暂停、方向」；
  // 用它做变更键，避免每次渲染对整份传输列表 JSON.stringify
  const fileTransferChanged = copiedTransfer
    .map(t => `${t.id}:${t.typeFrom}:${t.typeTo}:${t.inited ? 1 : 0}:${t.pausing ? 1 : 0}`)
    .join('|')
  const sidebarProps = {
    ...pick(store, [
      'activeItemId',
      'history',
      'showModal',
      'showInfoModal',
      'openedSideBar',
      'height',
      'settingTab',
      'settingItem',
      'isSyncingSetting',
      'leftSidePanelWidth',
      'leftSideBarWidth',
      'transferTab',
      'sidebarPanelTab',
      'openWidgetsModal'
    ]),
    zoom: config.zoom,
    fileTransfers: copiedTransfer,
    transferHistory: copiedHistory,
    upgradeInfo,
    pinned,
    isMobile: store.isMobile,
    // 过 normalize: 清洗未知 id + 存量旧默认配置迁移 (补右面板页签入口)
    leftSideBarIcons: normalizeLeftSideBarIcons(config.leftSideBarIcons),
    widgetInstancesLength: widgetInstances.length
  }

  const infoModalProps = {
    ...pick(store, [
      'infoModalTab',
      'showInfoModal',
      'commandLineHelp'
    ]),
    installSrc,
    upgradeInfo: store.upgradeInfo
  }
  const conflictStoreProps = {
    fileTransferChanged,
    fileTransfers: copiedTransfer
  }
  const resProps = {
    // 编辑弹窗只读列表（增删都走 store），浅拷贝数组即可
    resolutions: store.resolutions.slice(),
    openResolutionEdit
  }

  const rightPanelProps = {
    rightPanelVisible: store.rightPanelVisible,
    rightPanelPinned: store.rightPanelPinned,
    rightPanelWidth: store.rightPanelWidth,
    title: rightPanelTitle,
    rightPanelTab,
    isMobile: store.isMobile,
    // 终端日志页签可用性（终端类页才显示，与底栏按钮同口径但不含弹窗因素）
    inTerminalTab: store.inTerminalTab,
    // 监控页签/按钮可用性（有 shell 会话的页才可采集）
    hasShellSession: store.hasShellSession,
    // 双 home 工具 (命令历史/快捷命令) 寄居右面板时, 顶栏据此出现动态页签
    cmdHistoryInRightPanel: store.cmdHistoryInRightPanel,
    quickCommandsInRightPanel: store.quickCommandsInRightPanel
  }
  const sshConfigProps = {
    ...pick(store, [
      'settingTab',
      'showModal',
      'sshConfigs'
    ])
  }
  const warningProps = {
    hasOldConnectionHoppingBookmark: store.hasOldConnectionHoppingBookmark,
    configLoaded
  }
  const aiChatProps = {
    aiChatHistory: store.aiChatHistory,
    config,
    selectedTabIds: store.batchInputSelectedTabIds,
    tabs: store.getTabs(),
    activeTabId: store.activeTabId,
    showAIConfig: store.showAIConfig,
    rightPanelTab,
    agentRunning: store.agentRunning,
    aiContextInfo: store.aiContextInfo,
    // 外部递交给面板的一句话（终端解释输出 / 数据库页 AI 解释），面板挂载后消费
    pendingAiPrompt: store.pendingAiPrompt,
    aiAutoCompress: store.aiAutoCompress,
    currentChatSessionId: store.currentChatSessionId,
    showChatSessions: store.showChatSessions
  }
  const cmdSuggestionsProps = {
    suggestions: store.terminalCommandSuggestions
  }
  return (
    <ConfigProvider
      theme={uiThemeConfig}
    >
      <div {...ext1}>
        <InputContextMenu />
        <ShortcutControl config={config} />
        <CssOverwrite
          {...confsCss}
          configLoaded={configLoaded}
        />
        {window.et.isWebApp
          ? null
          : (
            <LazyBoundary>
              <Suspense fallback={null}>
                <Opacity opacity={config.opacity} />
              </Suspense>
            </LazyBoundary>
            )}
        <TerminalInteractive />
        <UiTheme
          {...themeProps}
        />
        {store.isWindowControlsOverlay && (
          <TitleBarOverlay {...themeProps} />
        )}
        <CustomCss customCss={config.customCss} configLoaded={configLoaded} />
        {store.textEditorRequested && (
          <TextEditor />
        )}
        <UpdateCheck
          skipVersion={config.skipVersion}
          upgradeInfo={upgradeInfo}
          installSrc={installSrc}
        />
        <FileInfoModal />
        <FileCompareModal />
        <FilePreviewModal />
        <RemoteArchiveModal />
        <SettingModal store={store} />
        <MoveItemModal store={store} />
        <div
          id='outside-context'
        >
          <Sidebar {...sidebarProps} />
          <Layout
            store={store}
          />
        </div>
        <ConfirmModalStore
          transferToConfirm={transferToConfirm}
        />
        <TransportsActionStore
          {...conflictStoreProps}
          config={config}
        />
        <Remote2RemoteHandlers />
        {openResolutionEdit && (
          <LazyBoundary>
            <Suspense fallback={null}>
              <Resolutions {...resProps} />
            </Suspense>
          </LazyBoundary>
        )}
        {store.showInfoModal && (
          <LazyBoundary>
            <Suspense fallback={null}>
              <InfoModal {...infoModalProps} />
            </Suspense>
          </LazyBoundary>
        )}
        {/* G8 审计中心：三来源合并在组件里做，这里只给两份历史（store 的代理数组可直接读） */}
        {store.showAuditCenter && (
          <LazyBoundary>
            <Suspense fallback={null}>
              <AuditCenter
                open={store.showAuditCenter}
                history={store.history}
                transferHistory={store.transferHistory}
                onClose={() => store.closeAuditCenter()}
              />
            </Suspense>
          </LazyBoundary>
        )}
        <RightSidePanel {...rightPanelProps}>
          {!isAIDisabled() && <AIChat {...aiChatProps} />}
          {
            store.rightPanelTab === 'transfer' && (
              <TransferPanel store={store} />
            )
          }
          {
            store.rightPanelTab === 'monitor' && (
              <MonitorPanel store={store} />
            )
          }
          <TerminalInfo key={store.activeTabId} store={store} {...store.terminalInfoProps} />
          {/* the cmd history panel has two homes; the footer popover is the
              other one, and both are the same component (see cmd-history.jsx) */}
          <CmdHistory store={store} inline />
          {/* same for the quick command panel: the footer box is the other home
              (see quick-commands-box.jsx) */}
          <QuickCommandsFooterBox store={store} inline />
        </RightSidePanel>
        <SshConfigLoadNotify {...sshConfigProps} />
        <LoadSshConfigs
          showSshConfigModal={store.showSshConfigModal}
          sshConfigs={store.sshConfigs}
        />
        <ConnectionHoppingWarning {...warningProps} />
        <TerminalCmdSuggestions {...cmdSuggestionsProps} />
        <TransferQueue />
        <AutoSync config={config} />
        <WorkspaceSaveModal store={store} />
        <BookmarkFromHistoryModal />
        <NotificationContainer />
        <CommandPalette store={store} />
        <BatchOpRunner />
        <ImportProgress />
        <ShortcutBarEntry store={store} />
        {!isAIDisabled() && store.showAIConfigModal && (
          <LazyBoundary>
            <Suspense fallback={null}>
              <AIConfigModal store={store} />
            </Suspense>
          </LazyBoundary>
        )}
        <UnixTimestampTooltip />
      </div>
    </ConfigProvider>
  )
})
