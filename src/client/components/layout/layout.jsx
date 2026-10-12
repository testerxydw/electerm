import { auto } from 'manate/react'
import Layouts from './layouts'
import TabsWrap from '../tabs/index'
import {
  splitConfig,
  quickCommandBoxHeight,
  footerHeight,
  remoteMonitorBarHeight,
  shortcutBarHeight
} from '../../common/constants'
import layoutAlg from './layout-alg'
import calcSessionSize from './session-size-alg'
import TermSearch from '../terminal/term-search'
import Footer from '../footer/footer-entry'
import RemoteMonitorBar from '../remote-monitor/remote-monitor-bar-entry'
import { isRemoteMonitorBarVisible } from '../remote-monitor/visibility'
import SessionsWrap from '../session/sessions'
import QuickCommandsFooterBox from '../quick-commands/quick-commands-box'
import pixed from './pixed'
import { pick } from 'lodash-es'
import './layout.styl'

export default auto(function Layout (props) {
  const { store } = props
  const {
    layout, config, currentTab
  } = store
  const conf = splitConfig[layout]

  const handleMousedown = (e) => {

  }

  const calcLayoutStyle = () => {
    const {
      width,
      height,
      isMobile,
      pinnedQuickCommandBar,
      quickCommandsInRightPanel,
      leftSidePanelWidth,
      leftSideBarWidth,
      openedSideBar,
      rightPanelVisible,
      rightPanelWidth,
      resizeTrigger,
      inActiveTerminal,
      shortcutBarVisible,
      shortcutBarKbOffset
    } = props.store
    const monitorHeight = isRemoteMonitorBarVisible(props.store) ? remoteMonitorBarHeight : 0
    // a pin left on while the panel is docked in the right side panel reserves
    // nothing: the footer box is not rendered then (quick-commands-box.jsx)
    const qmPinnedHeight = inActiveTerminal &&
      pinnedQuickCommandBar &&
      !quickCommandsInRightPanel
      ? quickCommandBoxHeight
      : 0
    // 底栏三合一：底部常显区仅剩一条 footer（statusbar/kbar 已并入）
    const h = height - footerHeight - monitorHeight - qmPinnedHeight - (shortcutBarVisible ? shortcutBarHeight + shortcutBarKbOffset : 0) + resizeTrigger
    // 左面板可见即预留宽度（无论是否停靠）：面板列独占左侧，终端不被遮挡。
    // 停靠(pin)仅保留"点击外部不关闭"的行为差异，不再差遮挡行为
    const l = openedSideBar && !isMobile ? leftSideBarWidth + leftSidePanelWidth : leftSideBarWidth
    // 右面板可见即预留宽度（无论是否固定）：面板列独占右侧，终端始终不被遮挡。
    // 固定与不固定仅差快捷命令寄居位置，不再差遮挡行为
    const r = rightPanelVisible && !isMobile ? rightPanelWidth : 0
    return {
      height: h,
      top: 0,
      left: l,
      width: Math.max(0, width - l - r)
    }
  }

  const layoutSize = calcLayoutStyle()
  const {
    width,
    height
  } = layoutSize
  const pixedLayoutStyle = pixed(layoutSize)
  const styles = layoutAlg(layout, width, height)
  const layoutProps = {
    layout,
    ...styles,
    layoutStyle: pixedLayoutStyle,
    handleMousedown
  }
  const sizes = calcSessionSize(layout, width, height)

  function renderSessions (conf, layout) {
    const {
      store
    } = props
    const { tabs } = store
    const tabsBatch = {}
    for (const tab of tabs) {
      let { batch } = tab
      // Guard against tabs with missing/invalid batch (e.g. created by
      // MCP/AI operations before sanitization). Route them to pane 0
      // instead of crashing or disappearing.
      batch = Number(batch)
      if (!Number.isInteger(batch) || batch < 0 || batch >= sizes.length) {
        batch = 0
      }
      if (!tabsBatch[batch]) {
        tabsBatch[batch] = []
      }
      tabsBatch[batch].push(tab)
    }
    return sizes.map((v, i) => {
      const sessProps = {
        batch: i,
        layout,
        currentBatchTabId: store[`activeTabId${i}`],
        ...v,
        tabs: tabsBatch[i] || [],
        ...pick(store, [
          'isMaximized',
          'config',
          'resolutions',
          'fileOperation',
          'pinnedQuickCommandBar',
          'tabsHeight',
          'appPath',
          'leftSidePanelWidth',
          'addPanelWidth',
          'pinned',
          'openedSideBar',
          'isMobile'
        ])
      }
      return (
        <TabsWrap
          key={'sess' + i}
          {...sessProps}
        />
      )
    })
  }

  const termProps = {
    currentTab,
    config,
    ...pick(store, [
      'activeTabId',
      'termSearchOpen',
      'termSearch',
      'termSearchOptions',
      'termSearchMatchCount',
      'termSearchMatchIndex'
    ])
  }
  const footerProps = {
    store
  }
  const qmProps = {
    store
  }
  const sessionsProps = {
    styles: styles.wrapStyles,
    sizes,
    width,
    height,
    layoutStyle: pixedLayoutStyle,
    ...pick(store, [
      'activeTabId',
      'activeTabId0',
      'activeTabId1',
      'activeTabId2',
      'activeTabId3',
      'batch',
      'resolutions',
      'fileOperation',
      'file',
      'pinnedQuickCommandBar',
      'tabsHeight',
      'appPath',
      'leftSidePanelWidth',
      'pinned',
      'openedSideBar',
      'config',
      'fullscreen'
    ]),
    tabs: store.tabs,
    layout
  }
  return [
    <Layouts {...layoutProps} key='layouts'>
      {renderSessions(conf, layout)}
    </Layouts>,
    <SessionsWrap key='SessionsWrap' {...sessionsProps} />,
    <TermSearch
      key='TermSearch'
      {...termProps}
    />,
    <QuickCommandsFooterBox
      key='QuickCommandsFooterBox'
      {...qmProps}
    />,
    <RemoteMonitorBar
      key='RemoteMonitorBar'
      store={store}
      style={{ left: layoutSize.left, width, height: remoteMonitorBarHeight }}
    />,
    <Footer
      key='Footer'
      {...footerProps}
    />
  ]
})
