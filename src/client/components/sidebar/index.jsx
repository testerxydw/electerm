import { useEffect } from 'react'
import {
  InfoCircleOutlined,
  UpCircleOutlined,
  AimOutlined,
  MenuFoldOutlined
} from '@ant-design/icons'
import { Tooltip, Popover } from 'antd'
import SideBarPanel from './sidebar-panel'
import MenuBtn from '../sys-menu/menu-btn'
import {
  settingMap,
  modals
} from '../../common/constants'
import SideIcon from './side-icon'
import SidePanel from './side-panel'
import LeftSidebarIcons from './left-sidebar-icons'
import TransferList from './transfer-list'
import hasActiveInput from '../../common/has-active-input'
import './sidebar.styl'

const e = window.translate

export default function Sidebar (props) {
  const {
    upgradeInfo,
    settingTab,
    settingItem,
    isSyncingSetting,
    // expandable bookmarks/history panel
    leftSidePanelWidth,
    // far-left icon bar (43px; 0 when hidden)
    leftSideBarWidth,
    pinned,
    fileTransfers,
    openedSideBar,
    transferHistory,
    transferTab,
    showModal,
    showInfoModal,
    sidebarPanelTab,
    openWidgetsModal,
    zoom,
    leftSideBarIcons,
    widgetInstancesLength,
    isMobile
  } = props

  const { store } = window

  // pinned is desktop-only, like the right panel's: on mobile the panel spans
  // the viewport and there is no pin control to unpin it, so a pin persisted
  // from a desktop session must not turn into a mode the user cannot leave.
  const pinnedActive = pinned && !isMobile

  const handleClickOutside = (event) => {
    const { store } = window
    // Nothing to dismiss when the panel is closed or pinned; also ignore
    // clicks while typing in an input so the panel is not yanked away
    // mid-interaction. Read the pin live rather than from the render scope:
    // this listener is attached once, so a captured value would go stale.
    if (!store.openedSideBar || (store.pinned && !store.isMobile) || hasActiveInput()) {
      return
    }
    const target = event.target
    // Never treat the panel itself or the bookmark toggle button as "outside".
    // The very click that toggles the panel open lands on that button, so this
    // guard makes the toggle immune to event-ordering races — and, in dev hot
    // reloads, to stale listeners left behind by an older build.
    if (target.closest && (
      target.closest('.sidebar-panel') ||
      target.closest('.bookmark-sidebar-toggle')
    )) {
      return
    }
    store.setOpenedSideBar('')
  }

  // One always-on document listener for click-outside dismissal, attached
  // once. Previously the listener was added/removed from inside the bookmark
  // click handler, so it leaked when the panel was closed via the ✕ icon and
  // then instantly re-closed the panel on the next bookmark-icon click.
  useEffect(() => {
    document.addEventListener('click', handleClickOutside)
    return () => {
      document.removeEventListener('click', handleClickOutside)
    }
  }, [])

  const handleClickBookmark = () => {
    if (showModal) {
      store.showModal = 0
    }
    store.openLeftSidePanel()
  }

  const handleShowUpgrade = () => {
    window.store.upgradeInfo.showUpgradeModal = true
  }

  const handleZoomReset = () => {
    store.onZoomReset()
  }

  const handleToggleSidebar = () => {
    store.toggleLeftSideBar()
  }

  const {
    onNewSsh,
    openSetting,
    openAbout,
    openSettingSync,
    openTerminalThemes,
    setLeftSidePanelWidth
  } = store
  const {
    showUpgradeModal,
    upgradePercent,
    checkingRemoteVersion,
    shouldUpgrade
  } = upgradeInfo
  const showSetting = showModal === modals.setting
  const settingActive = showSetting && settingTab === settingMap.setting && settingItem.id === 'setting-common'
  const syncActive = showSetting && settingTab === settingMap.setting && settingItem.id === 'setting-sync'
  const themeActive = showSetting && settingTab === settingMap.terminalThemes
  const bookmarksActive = showSetting && settingTab === settingMap.bookmarks
  const widgetsActive = showSetting && settingTab === settingMap.widgets
  const sideProps = openedSideBar
    ? {
        className: 'sidebar-list',
        style: {
          width: `${leftSidePanelWidth}px`
        }
      }
    : {
        className: 'sidebar-list'
      }
  // 高度完全由 CSS 决定（top 0 + bottom 避让底部常显区），
  // 禁止内联 height：绝对定位下 top+height 会顶掉 bottom，导致底边多出标题栏高度
  const sidebarProps = {
    className: `sidebar type-${openedSideBar}${leftSideBarWidth === 0 ? ' collapsed' : ''}`,
    style: {
      width: leftSideBarWidth
    }
  }
  const transferProps = {
    fileTransfers,
    transferTab,
    transferHistory
  }
  return (
    <div {...sidebarProps}>
      <div className='sidebar-bar btns'>
        <div className='control-icon-wrap'>
          <MenuBtn store={store} config={store.config} />
        </div>
        <LeftSidebarIcons
          iconIds={leftSideBarIcons}
          handleClickBookmark={handleClickBookmark}
          onNewSsh={onNewSsh}
          openSetting={openSetting}
          openSettingSync={openSettingSync}
          openTerminalThemes={openTerminalThemes}
          openWidgetsModal={openWidgetsModal}
          bookmarksActive={bookmarksActive}
          themeActive={themeActive}
          settingActive={settingActive}
          syncActive={syncActive}
          widgetsActive={widgetsActive}
          isSyncingSetting={isSyncingSetting}
          widgetInstancesLength={widgetInstancesLength}
          rightPanelVisible={store.rightPanelVisible}
          rightPanelTab={store.rightPanelTab}
        />
        <TransferList {...transferProps} />
        <SideIcon
          title={e('about')}
          active={showInfoModal}
        >
          <InfoCircleOutlined
            className='iblock font16 control-icon open-about-icon'
            onClick={openAbout}
          />
        </SideIcon>
        <SideIcon
          title={e('hide')}
        >
          <MenuFoldOutlined
            className='iblock font16 control-icon hide-sidebar-icon'
            onClick={handleToggleSidebar}
          />
        </SideIcon>
        {
          Math.round((zoom ?? 1) * 100) !== 100
            ? (
              <SideIcon
                title={e('resetzoom')}
              >
                <AimOutlined
                  className='iblock font16 control-icon zoom-reset-icon'
                  onClick={handleZoomReset}
                />
              </SideIcon>
              )
            : null
        }
        {
          !checkingRemoteVersion && !showUpgradeModal && shouldUpgrade
            ? (
              <Tooltip
                title={`${e('upgrading')} ${upgradePercent || 0}%`}
                placement='right'
              >
                <div
                  className='control-icon-wrap'
                >
                  <UpCircleOutlined
                    className='iblock font18 control-icon upgrade-icon'
                    onClick={handleShowUpgrade}
                  />
                </div>
              </Tooltip>
              )
            : null
        }
        {/* 底部头像（对齐重设计草图 .rail .av）：用户名首字母；点击弹出账户菜单。
            margin-top:auto 使其吸附在图标栏底部（.sidebar-bar 为纵向 flex）。 */}
        <Popover
          content={
            <div className='sidebar-avatar-menu'>
              <div
                className='sidebar-avatar-menu-item'
                onClick={openSetting}
              >
                {e('setting')}
              </div>
              <div
                className='sidebar-avatar-menu-item'
                onClick={openSettingSync}
              >
                {e('settingSync')}
              </div>
              <div
                className='sidebar-avatar-menu-item'
                onClick={openTerminalThemes}
              >
                {e(settingMap.terminalThemes)}
              </div>
              <div
                className='sidebar-avatar-menu-item'
                onClick={openAbout}
              >
                {e('about')}
              </div>
            </div>
          }
          trigger='click'
          placement='rightTop'
        >
          <div
            className='sidebar-avatar'
            title={store.config.userName || store.config.name || 'electerm'}
          >
            {
              ((store.config.userName || store.config.name || 'e') + '')
                .trim()
                .charAt(0)
                .toUpperCase()
            }
          </div>
        </Popover>
      </div>
      <SidePanel
        sideProps={sideProps}
        setLeftSidePanelWidth={setLeftSidePanelWidth}
        leftSidePanelWidth={leftSidePanelWidth}
        leftSideBarWidth={leftSideBarWidth}
        isMobile={isMobile}
      >
        <SideBarPanel
          pinned={pinnedActive}
          sidebarPanelTab={sidebarPanelTab}
          isMobile={isMobile}
        />
      </SidePanel>
    </div>
  )
}
