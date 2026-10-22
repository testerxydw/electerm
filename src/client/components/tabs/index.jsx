/**
 * session tabs component
 */

import { Component } from 'manate/react/class-components'
import React from 'react'
import runIdle from '../../common/run-idle'
import { throttle } from 'lodash-es'
import TabTitle from './tab-title'
import {
  DownOutlined,
  LeftOutlined,
  RightOutlined
} from '@ant-design/icons'
import { Dropdown } from 'antd'
import Tab from './tab'
import LayoutMenu from './layout-menu'
import './tabs.styl'
import {
  tabWidth,
  tabMargin,
  extraTabWidth,
  windowControlWidth,
  getWindowControlsOverlayWidth,
  isMacJs,
  splitConfig
} from '../../common/constants'
import WindowControl from './window-control'
import AddBtn from './add-btn'
import AppDrag from './app-drag'
import NoSession from './no-session'
import classNames from 'classnames'

export default class Tabs extends Component {
  constructor (props) {
    super(props)
    this.tabsRef = React.createRef()
    this.domRef = React.createRef()
    this.state = {
      overflow: false,
      // tabs-wrapper 总宽（不含 extraTabWidth）：commit 后实测写入，
      // 未测前为 null，render 用保守估算兜底（见 getTabsWidthAll）
      wrapWidth: null,
      // 窗口角控件组是否压住本格子标签栏右缘（决定 166px 预留与
      // tabs-extra 让位是否需要），commit 后实测写入
      cornerOverlap: true
    }
    // 上次测量时的布局输入快照：只在真正影响标签宽度/角控件重叠的输入变化时重测
    this.measuredLayoutKey = ''
  }

  componentDidMount () {
    const {
      tabsRef
    } = this
    tabsRef.current.addEventListener('wheel', this.handleWheelEvent, {
      passive: false
    })
    this.measureWrapWidth()
    // Tab widths follow their titles, so they can change without a tab being
    // added or removed, such as on rename. Watch them to keep the wrapper width
    // and the overflow state in step with the tabs.
    this.resizeObserver = new ResizeObserver(this.handleTabsResize)
    this.observeTabs()
  }

  componentDidUpdate (prevProps) {
    // 标签标题变化由 ResizeObserver 驱动重测；这里只在数量/布局/面板/窗口
    // 变化时测量，避免每次父组件重渲染都做 querySelectorAll + 强制布局
    const { store } = window
    const layoutKey = [
      window.innerWidth,
      store.leftSideBarWidth,
      store.leftSidePanelWidth,
      store.openedSideBar ? 1 : 0,
      store.rightPanelVisible ? 1 : 0,
      store.rightPanelWidth,
      (this.props.tabs || []).length,
      this.props.isMobile ? 1 : 0,
      this.props.batch,
      this.props.width
    ].join('|')
    if (layoutKey !== this.measuredLayoutKey) {
      // 测量未就绪（移动端/首帧 DOM 未挂）时不记快照，下次 update 再试
      if (this.measureWrapWidth()) {
        this.measuredLayoutKey = layoutKey
      }
    }
    if (
      prevProps.currentBatchTabId !== this.props.currentBatchTabId ||
      prevProps.width !== this.props.width ||
      (prevProps.tabs || []).length !== (this.props.tabs || []).length
    ) {
      this.adjustScroll()
    }
    this.observeTabs()
  }

  componentWillUnmount () {
    this.resizeObserver.disconnect()
  }

  observeTabs = () => {
    const { resizeObserver, domRef } = this
    resizeObserver.disconnect()
    if (!domRef.current) {
      return
    }
    domRef.current.querySelectorAll('.tab').forEach(el => {
      resizeObserver.observe(el)
    })
  }

  // render reads the tab widths from the DOM before React commits the new
  // titles, so render again once the measured widths differ
  handleTabsResize = () => {
    if (this.tabsWidth() !== this.renderedTabsWidth) {
      this.setState({
        overflow: this.isOverflow()
      })
      // 本项目另有 wrapWidth 实测缓存（getTabsWidthAll 的数据源）：tab 宽度
      // 变化时一并重测。否则 overflow 恰好没变时 React 会 bail out 掉上面那次
      // setState，componentDidUpdate 不再跑，wrapper 宽度停留在旧值
      this.measureWrapWidth()
    }
  }

  modifier = (...args) => {
    runIdle(() => this.setState(...args))
  }

  handleNewTab = () => {
    window.store.addTab(undefined, undefined, this.props.batch)
  }

  handleNewSsh = () => {
    window.store.onNewSsh()
  }

  tabsWidth = () => {
    const { batch } = this.props
    return Array.from(
      document.querySelectorAll(`.v${batch + 1} .tab`)
    ).reduce((prev, c) => {
      return prev + c.clientWidth
    }, 0)
  }

  // commit 后实测 tabs-wrapper 总宽并写入 state；render 期间读 DOM 拿的是
  // 提交前的旧值——分屏挂载新格子时 .tab 尚未入 DOM（测到 0），wrapper 被
  // 写成 134px 的窄宽度导致 tab 换行、胶囊冒出标签条，直到下一次无关
  // 重渲染才自愈。只在 commit 后（componentDidMount/Update）测量可根治
  measureWrapWidth = () => {
    if (this.props.isMobile || !this.domRef.current) {
      return false
    }
    const len = (this.props.tabs || []).length
    const w = tabMargin * len + 10 + this.tabsWidth()
    if (w !== this.state.wrapWidth) {
      this.setState({ wrapWidth: w })
    }
    // 窗口角控件组(fixed)是否压住本格子标签栏右缘: 右面板打开会把终端区
    // 右缘推离窗口角, 此时 166px 预留与 tabs-extra 让位区域暴露为空白,
    // 需要释放; 面板关闭或标签栏横贯全宽(单格/全宽行布局)时仍需预留。
    // 未知时保守按重叠处理(渲染首帧), commit 后实测修正。
    // 实测坑：.tabs 本身横贯全宽（不随右面板收窄），"bar.right 贴窗口右缘"
    // 恒成立 → 预留从未释放。右面板(z 200)打开时窗口角控件(z 20)压在面板
    // 上方而非 tab 栏可见区，故可见右缘 = 面板左缘。
    const bar = this.tabsRef.current && this.tabsRef.current.getBoundingClientRect()
    const rightPanel = window.store.rightPanelVisible
      ? document.querySelector('.right-side-panel')
      : null
    const visibleRight = rightPanel && rightPanel.getBoundingClientRect().width > 0
      ? rightPanel.getBoundingClientRect().left
      : window.innerWidth
    const overlap = !bar
      ? true
      : Math.abs(bar.right - visibleRight) < 2
    if (overlap !== this.state.cornerOverlap) {
      this.setState({ cornerOverlap: overlap })
    }
    return true
  }

  // render 用：优先实测值；未测前按 tab 标称上限保守估算（偏大不换行）
  getTabsWidthAll = () => {
    if (this.state.wrapWidth !== null) {
      return this.state.wrapWidth
    }
    const len = (this.props.tabs || []).length
    return tabMargin * len + 10 + len * (tabWidth + 40)
  }

  isOverflow = () => {
    if (this.props.isMobile || !this.domRef.current) {
      return false
    }
    const { tabs = [] } = this.props
    const len = tabs.length
    const addBtnWidth = 22
    const tabsWidth = this.tabsWidth() + tabMargin * len + addBtnWidth
    const tabsInnerWidth = this.getInnerWidth()
    return tabsWidth > tabsInnerWidth
  }

  getInnerWidth = () => {
    const { batch } = this.props
    const cls = `.v${batch + 1} .tabs-inner`
    const inner = document.querySelector(cls)
    return inner ? inner.clientWidth : 0
  }

  handleAdd = e => {
    if (!e.target.className.includes('tabs-wrapper')) {
      return
    }
    window.store.addTab(
      undefined, undefined,
      this.props.batch
    )
  }

  handleTabAdd = () => {
    if (!window.store.hasNodePty) {
      window.store.onNewSsh()
      return
    }
    window.store.addTab(
      undefined, undefined,
      this.props.batch
    )
  }

  // desktop tabs bar renders pinned tabs first: stable partition that keeps
  // the original relative order inside the pinned and unpinned groups.
  // store.tabs order itself is untouched by pinning.
  getSortedTabs = () => {
    const { tabs = [] } = this.props
    return [
      ...tabs.filter(t => t.isPinned),
      ...tabs.filter(t => !t.isPinned)
    ]
  }

  adjustScroll = () => {
    if (this.props.isMobile || !this.domRef.current) {
      return
    }
    const { currentBatchTabId, batch } = this.props
    const tabs = this.getSortedTabs()
    const index = tabs.findIndex(t => t.id === currentBatchTabId)
    const tabsDomWith = Array.from(
      document.querySelectorAll(`.v${batch + 1} .tab`)
    ).slice(0, index + 2).reduce((prev, c) => {
      return prev + c.clientWidth
    }, 0)
    const w = (index + 1) * tabMargin + tabsDomWith
    const tabsInnerWidth = this.getInnerWidth()
    const scrollLeft = w > tabsInnerWidth
      ? w - tabsInnerWidth
      : 0
    this.domRef.current.scrollTo({ left: scrollLeft, behavior: 'smooth' })
    this.setState({
      overflow: this.isOverflow()
    })
  }

  handleScrollLeft = () => {
    if (!this.domRef.current) {
      return
    }
    let { scrollLeft } = this.domRef.current
    scrollLeft = scrollLeft - tabMargin - tabWidth
    if (scrollLeft < 0) {
      scrollLeft = 0
    }
    this.domRef.current.scrollTo({ left: scrollLeft, behavior: 'smooth' })
  }

  handleScrollRight = () => {
    if (!this.domRef.current) {
      return
    }
    let { scrollLeft } = this.domRef.current
    scrollLeft = scrollLeft + tabMargin + tabWidth
    if (scrollLeft < 0) {
      scrollLeft = 0
    }
    this.domRef.current.scrollTo({ left: scrollLeft, behavior: 'smooth' })
  }

  handleWheelEvent = throttle((e) => {
    if (this.isOverflow()) {
      if (e.deltaY < 0) {
        this.handleScrollLeft()
      } else {
        this.handleScrollRight()
      }
    }
  }, 100, { leading: true, trailing: true })

  handleClickMenu = ({ key }) => {
    const id = key.split('##')[1]
    window.store['activeTabId' + this.props.batch] = id
  }

  renderAddBtn = () => {
    const cls = classNames(
      'pointer tabs-add-btn font16',
      {
        empty: !this.props.tabs?.length
      }
    )
    return (
      <AddBtn
        className={cls}
        empty={!this.props.tabs?.length}
        batch={this.props.batch}
        addPanelWidth={this.props.addPanelWidth}
      />
    )
  }

  renderNoExtra () {
    return (
      <div className='tabs-extra pd1x'>
        {this.renderLayoutMenu()}
      </div>
    )
  }

  renderExtra () {
    const items = this.getSortedTabs().map((t, i) => {
      return {
        key: i + '##' + t.id,
        label: (
          <span><TabTitle tab={t} config={this.props.config} /></span>
        ),
        onClick: () => this.handleClickMenu({ key: i + '##' + t.id })
      }
    })
    const dropProps = {
      className: 'tabs-add-btn font16',
      menu: {
        items
      },
      placement: 'bottomRight'
    }
    return (
      <div className='tabs-extra pd1x'>
        {this.renderAddBtn()}
        <LeftOutlined
          className='mg1l iblock pointer font12 tab-scroll-icon'
          onClick={this.handleScrollLeft}
        />
        <RightOutlined
          className='mg1x iblock pointer font12 tab-scroll-icon'
          onClick={this.handleScrollRight}
        />
        <Dropdown
          {...dropProps}
        >
          <DownOutlined className='tabs-dd-icon' />
        </Dropdown>
        {
          this.renderLayoutMenu()
        }
      </div>
    )
  }

  renderContent () {
    if (window.store.hasNativeTitleStrip) {
      return this.renderContentInner()
    }
    return (
      <AppDrag>
        {this.renderContentInner()}
      </AppDrag>
    )
  }

  renderContentInner () {
    const { width } = this.props
    const tabs = this.getSortedTabs()
    const len = tabs.length
    // 上游 #4623：render 期间记录本次渲染所依据的 tab 实测宽，供 ResizeObserver
    // 判断"宽度是否真的变了"；总宽仍走本项目的 getTabsWidthAll()（实测缓存，
    // 未测前按标称上限保守估算，避免分屏新格子首帧 wrapper 过窄导致换行）
    this.renderedTabsWidth = this.tabsWidth()
    const tabsWidthAll = this.getTabsWidthAll()
    const { overflow } = this.state
    const left = overflow
      ? '100%'
      : tabsWidthAll
    // 右侧控件区预留仅在窗口角控件组压住本格子标签栏右缘时需要；
    // 右面板打开时控件组在窗口角, 预留区域会暴露为空白, 全部释放。
    // 非主格子无窗口角控件, 维持上游恒扣 166px 的既有行为
    const isPrimary = this.shouldRenderWindowControl()
    const reserve = isPrimary && this.state.cornerOverlap !== false
    const w1 = reserve
      ? (isMacJs && (window.store.isSystemTitleBar || window.et.isWebApp) ? 30 : this.getExtraTabWidth())
      : 0
    const style = {
      width: width - w1 - (reserve || !isPrimary ? 166 : 0)
    }
    return (
      <div
        className='tabs-inner'
        ref={this.domRef}
        style={style}
      >
        <div
          style={{
            left
          }}
        />
        <div
          className='tabs-wrapper relative'
          style={{
            width: tabsWidthAll + extraTabWidth + 10
          }}
          onDoubleClick={this.handleAdd}
        >
          {
            tabs.map((tab, i) => {
              const isLast = i === len - 1
              const tabProps = {
                ...this.props,
                tab,
                isLast,
                addTab: this.handleTabAdd,
                tabIndex: i
              }
              return (
                <Tab
                  {...tabProps}
                  key={tab.id}
                />
              )
            })
          }
          {
            overflow
              ? null
              : this.renderAddBtn()
          }
        </div>
      </div>
    )
  }

  renderLayoutMenu = () => {
    // 系统标题栏模式没有可钉住的窗口顶带，布局菜单留在标签栏右缘；
    // 自定义标题栏 / WCO 模式下它移入窗口角控件组（renderCornerControls），
    // 两种模式互斥渲染，避免重复
    if (!window.store.hasNativeTitleStrip) {
      return null
    }
    return (
      <LayoutMenu
        layout={this.props.layout}
        visible={this.shouldRenderWindowControl()}
      />
    )
  }

  // 窗口角固定控件组：布局菜单 + 自绘窗口三键，fixed 定位恒在窗口右上角，
  // 不随右侧面板开合移动（面板打开时落在面板上方的标题装饰带上）。
  // 仅主格子渲染一份；系统标题栏模式不渲染（见 renderLayoutMenu 分流）
  renderCornerControls = () => {
    if (window.store.hasNativeTitleStrip || !this.shouldRenderWindowControl()) {
      return null
    }
    return (
      <div className='tabs-corner'>
        <LayoutMenu
          layout={this.props.layout}
          visible
        />
        <WindowControl
          store={window.store}
        />
      </div>
    )
  }

  shouldRenderWindowControl = () => {
    const { layout, batch } = this.props
    const batchToRender = {
      c1: 0,
      c2: 1,
      c3: 2,
      r2: 0,
      r3: 0,
      c2x2: 1,
      c1r2: 1,
      r1c2: 0
    }
    return batch === batchToRender[layout]
  }

  getExtraTabWidth = () => {
    if (!this.shouldRenderWindowControl()) {
      return 0
    }
    return window.store.isWindowControlsOverlay
      ? getWindowControlsOverlayWidth()
      : windowControlWidth
  }

  // The pane that owns the window-level corner controls (.tabs-corner: layout
  // menu + custom window buttons) gets .has-corner, so its tabs-extra reserves
  // their width (see tabs.styl). Native title strip
  // modes keep the layout menu inside tabs-extra instead — there is no
  // window-owned top strip to pin the corner controls to.
  tabsClassName = (extra) => {
    return classNames('tabs', extra, {
      // still used by the mobile WCO rule (mobile.styl)
      'wco-bar': window.store.isWindowControlsOverlay && this.shouldRenderWindowControl(),
      // has-corner 同时驱动 tabs-extra 的让位宽度（tabs.styl）；窗口角控件组
      // 不压住本格子右缘（右面板挤压终端区）时无需让位，避免暴露空白
      'has-corner': !this.props.isMobile &&
        !window.store.hasNativeTitleStrip &&
        this.shouldRenderWindowControl() &&
        this.state.cornerOverlap !== false
    })
  }

  renderWindowControl = () => {
    if (this.shouldRenderWindowControl()) {
      return (
        <WindowControl
          store={window.store}
        />
      )
    }
    return null
  }

  renderMobileTabsDropdown (items) {
    return (
      <Dropdown
        menu={{ items }}
        placement='bottomRight'
        trigger={['click']}
      >
        <DownOutlined className='tabs-dd-icon' />
      </Dropdown>
    )
  }

  renderMobileTabsExtra (items) {
    return (
      <div className='mobile-tabs-extra'>
        {this.renderAddBtn()}
        {
          items && items.length
            ? this.renderMobileTabsDropdown(items)
            : null
        }
      </div>
    )
  }

  renderMobileTabsInner (currentTabEl) {
    const inner = (
      <div className='tabs-inner mobile-tabs-inner'>
        {currentTabEl}
      </div>
    )
    if (window.store.hasNativeTitleStrip) {
      return inner
    }
    return (
      <AppDrag>
        {inner}
      </AppDrag>
    )
  }

  renderMobileTabs () {
    const { tabs = [], currentBatchTabId } = this.props
    const currentTab = tabs.find(t => t.id === currentBatchTabId)
    const items = tabs.map((t, i) => {
      return {
        key: i + '##' + t.id,
        label: (
          <span><TabTitle tab={t} config={this.props.config} /></span>
        ),
        onClick: () => this.handleClickMenu({ key: i + '##' + t.id })
      }
    })
    const tabProps = {
      ...this.props,
      tab: currentTab,
      isLast: true,
      addTab: this.handleTabAdd,
      tabIndex: 0
    }
    const currentTabEl = currentTab
      ? <Tab {...tabProps} key={currentTab.id} />
      : null
    return (
      <div className={this.tabsClassName('mobile-tabs')} ref={this.tabsRef}>
        {this.renderMobileTabsInner(currentTabEl)}
        {this.renderMobileTabsExtra(items)}
        {this.renderWindowControl()}
      </div>
    )
  }

  renderTabs () {
    const { overflow } = this.state
    if (this.props.isMobile) {
      return this.renderMobileTabs()
    }
    return (
      <div className={this.tabsClassName()} ref={this.tabsRef}>
        {this.renderContent()}
        {this.renderCornerControls()}
        {
          overflow
            ? this.renderExtra()
            : this.renderNoExtra()
        }
      </div>
    )
  }

  renderNoSession = () => {
    const { layout, batch } = this.props
    // 走到这里说明本窗格没有 tab；单窗格布局下没有"关闭此窗格"的概念
    const multiPane = ((splitConfig[layout] && splitConfig[layout].children) || 1) > 1
    return (
      <NoSession
        height={this.props.height}
        onNewTab={this.handleNewTab}
        onNewSsh={this.handleNewSsh}
        batch={batch}
        onClosePane={multiPane ? () => window.store.closePane(batch) : undefined}
      />
    )
  }

  render () {
    const {
      tabs
    } = this.props
    if (!tabs || !tabs.length) {
      return (
        <div className='tabs-outer'>
          {this.renderTabs()}
          {this.renderNoSession()}
        </div>
      )
    }
    return this.renderTabs()
  }
}
