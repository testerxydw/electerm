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
    layout
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
    // 面板宽只挤压终端区（.sessions + session 尺寸）；.layout-wrap 仅让位常驻
    // 图标栏并保持全宽 —— 标签栏横贯（面板 top = --tabs-bar-h，与其不重叠），
    // 标题栏不再随面板"避让"变窄
    return {
      height: h,
      top: 0,
      left: leftSideBarWidth,
      width: Math.max(0, width - leftSideBarWidth),
      termLeft: l,
      termWidth: Math.max(0, width - l - r)
    }
  }

  const layoutSize = calcLayoutStyle()
  const {
    height,
    termLeft,
    termWidth
  } = layoutSize
  // 标签栏层容器恒全宽（仅让位常驻图标栏）—— 标题栏永不随面板收缩。
  // 格子定位分两种:
  //  - 单格: 全宽格子, 标签栏横贯(含右侧面板上方, 面板 top = --tabs-bar-h 不重叠)
  //  - 多格: 格子取终端列网格(termStyles)并平移到容器坐标系, 保证每个
  //    格子的标签栏贴在其终端正上方; 面板上方空隙由 .layout-wrap::before
  //    顶部装饰带补齐(layout.styl), 视觉上标题栏仍横贯
  const paneCount = (splitConfig[layout] && splitConfig[layout].children) || 1
  const isSinglePane = paneCount === 1
  const pixedLayoutStyle = pixed({
    height: layoutSize.height,
    top: layoutSize.top,
    left: layoutSize.left,
    width: layoutSize.width
  })
  const pixedTermStyle = pixed({
    height: layoutSize.height,
    top: layoutSize.top,
    left: termLeft,
    width: termWidth
  })
  const styles = layoutAlg(layout, layoutSize.width, height)
  const termStyles = layoutAlg(layout, termWidth, height)
  const shift = termLeft - layoutSize.left
  const paneGap = layoutSize.width - termWidth
  const shiftNum = (v, delta) => (typeof v === 'number' ? v + delta : `calc(${v} + ${delta}px)`)
  // 终端列在容器坐标系中占据 [shift, shift+termWidth]，右缘距容器右缘
  // = paneGap - shift（即纯右面板宽）。right 多加左面板宽会把每格
  // 压缩一个 leftSidePanelWidth（左面板打开+多格分屏时标签条/空窗格变半宽）
  const paneWrapStyles = termStyles.wrapStyles.map(s => ({
    ...s,
    left: typeof s.left !== 'undefined' ? shiftNum(s.left, shift) : s.left,
    right: typeof s.right !== 'undefined' ? shiftNum(s.right, paneGap - shift) : s.right
  }))
  const paneHandleStyles = termStyles.handleStyles.map(h => ({
    ...h,
    left: typeof h.left !== 'undefined' ? shiftNum(h.left, shift) : h.left
  }))
  const layoutProps = {
    layout,
    wrapStyles: isSinglePane ? styles.wrapStyles : paneWrapStyles,
    handleStyles: isSinglePane ? styles.handleStyles : paneHandleStyles,
    layoutStyle: pixedLayoutStyle,
    handleMousedown
  }
  const sizes = calcSessionSize(layout, termWidth, height)

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
          'addPanelWidth',
          'pinned',
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

  const footerProps = {
    store
  }
  const qmProps = {
    store
  }
  const sessionsProps = {
    styles: isSinglePane ? styles.wrapStyles : termStyles.wrapStyles,
    sizes,
    width: termWidth,
    height,
    layoutStyle: pixedTermStyle,
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
      'pinned',
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
    <QuickCommandsFooterBox
      key='QuickCommandsFooterBox'
      {...qmProps}
    />,
    <RemoteMonitorBar
      key='RemoteMonitorBar'
      store={store}
      style={{ left: termLeft, width: termWidth, height: remoteMonitorBarHeight }}
    />,
    <Footer
      key='Footer'
      {...footerProps}
    />
  ]
})
