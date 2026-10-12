import { auto } from 'manate/react'
import classnames from 'classnames'
import {
  Select,
  Dropdown,
  Badge
} from 'antd'
import {
  BarChartOutlined,
  DashboardOutlined,
  TranslationOutlined,
  DoubleRightOutlined,
  FunctionOutlined,
  PlusOutlined,
  SettingOutlined,
  SearchOutlined,
  SwapOutlined
} from '@ant-design/icons'
import './footer.styl'
import { statusMap } from '../../common/constants'
import { statusText, typeText } from '../status-bar/format'
import BatchInput from './batch-input'
import encodes from '../bookmark-form/common/encodes'
import { refs } from '../common/ref'
import Qm from '../quick-commands/quick-commands-select'
import TriggerSessionModal from '../triggers/trigger-session-modal'
import AIIcon from '../icons/ai-icon'
import { isAIDisabled } from '../../common/ai-feature'
import CmdHistory from './cmd-history'

const e = window.translate

const {
  Option
} = Select

export default auto(function FooterEntry (props) {
  function handleInfoPanel () {
    window.store.toggleInfoPanel()
  }

  function batchInput (cmd, selectedTabIds) {
    selectedTabIds.map(id => {
      return refs.get('term-' + id)
    }).forEach(term => {
      term?.batchInput(cmd)
    })
  }

  function handleSwitchEncoding (encode) {
    const term = refs.get('term-' + props.store.activeTabId)
    if (term) {
      term.switchEncoding(encode)
    }
  }

  function isLoading () {
    const { currentTab } = props.store
    if (!currentTab) {
      return true
    }
    const {
      status
    } = currentTab
    return status !== statusMap.success
  }

  function renderBatchInputs () {
    const { store } = props
    const batchProps = {
      input: batchInput,
      tabs: store.tabs,
      batchInputSelectedTabIds: store.batchInputSelectedTabIds,
      activeTabId: store.activeTabId,
      isMobile: store.isMobile
    }
    return (
      <div className='terminal-footer-unit terminal-footer-center'>
        <BatchInput
          {...batchProps}
        />
      </div>
    )
  }

  function renderQuickCommands () {
    const { rightPanelVisible, rightPanelTab, quickCommandsInRightPanel, openQuickCommandBar } = props.store
    // the Q button only owns the right panel while the panel lives there; in
    // the footer it toggles the floating box instead, which shows its own state.
    // 浮动框打开时按钮同样点亮 (与 AI/传输/监控/信息的灯态契约一致)
    const active = quickCommandsInRightPanel
      ? rightPanelVisible && rightPanelTab === 'quickCommands'
      : openQuickCommandBar
    return (
      <div className='terminal-footer-unit terminal-footer-qm'>
        <Qm active={active} />
      </div>
    )
  }

  function renderTriggers () {
    const { store } = props
    const tab = store.currentTab
    let count = 0
    try {
      count = tab ? store.getEffectiveTriggers(tab).length : store.triggers.length
    } catch (err) {
      count = 0
    }
    return (
      <div className='terminal-footer-unit terminal-footer-triggers'>
        <Badge
          count={count}
          size='small'
          offset={[-2, 2]}
        >
          <FunctionOutlined
            onClick={() => store.toggleTriggerSessionModal(true)}
            className='pointer font14 terminal-trigger-icon'
            title={e('triggers')}
          />
        </Badge>
        <TriggerSessionModal store={store} />
      </div>
    )
  }

  function handleAIPanel () {
    window.store.toggleAIPanel()
  }

  function renderAIIcon () {
    const { rightPanelVisible, rightPanelTab } = props.store
    // same contract as the info icon: lit while its panel is open
    const active = rightPanelVisible && rightPanelTab === 'ai'
    return (
      <div className='terminal-footer-unit terminal-footer-ai'>
        <AIIcon
          onClick={handleAIPanel}
          className={active ? 'active' : ''}
        />
      </div>
    )
  }

  // 传输/监控：与 AI 同款灯态 toggle（与右面板页签/左侧图标栏相互补齐）
  function renderTransferIcon () {
    const { rightPanelVisible, rightPanelTab } = props.store
    const active = rightPanelVisible && rightPanelTab === 'transfer'
    return (
      <div className='terminal-footer-unit terminal-footer-transfer'>
        <SwapOutlined
          onClick={() => window.store.toggleTransferPanel()}
          className={'pointer font14 terminal-transfer-icon' + (active ? ' active' : '')}
          title='传输'
        />
      </div>
    )
  }

  function renderMonitorIcon () {
    const { rightPanelVisible, rightPanelTab } = props.store
    const active = rightPanelVisible && rightPanelTab === 'monitor'
    return (
      <div className='terminal-footer-unit terminal-footer-monitor'>
        <DashboardOutlined
          onClick={() => window.store.toggleMonitorPanel()}
          className={'pointer font14 terminal-monitor-icon' + (active ? ' active' : '')}
          title='监控'
        />
      </div>
    )
  }

  function renderEncodingInfo () {
    const selectProps = {
      style: {
        minWidth: 30
      },
      placeholder: e('encode'),
      defaultValue: props.store.currentTab?.encode,
      onSelect: handleSwitchEncoding,
      size: 'small',
      variant: 'borderless',
      popupMatchSelectWidth: false
    }
    if (props.store.isMobile) {
      const items = encodes.map(k => {
        return {
          key: k,
          label: k.toUpperCase(),
          onClick: () => handleSwitchEncoding(k)
        }
      })
      return (
        <div className='terminal-footer-unit terminal-footer-info'>
          <Dropdown
            menu={{ items }}
            placement='topRight'
            trigger={['click']}
          >
            <TranslationOutlined
              className='pointer font18 mobile-encode-trigger'
            />
          </Dropdown>
        </div>
      )
    }
    return (
      <div className='terminal-footer-unit terminal-footer-info'>
        <div className='fleft relative'>
          <Select
            {...selectProps}
          >
            {
              encodes.map(k => {
                return (
                  <Option key={k} value={k}>
                    {k.toUpperCase()}
                  </Option>
                )
              })
            }
          </Select>
        </div>
      </div>
    )
  }

  function renderInfoIcon () {
    const loading = isLoading()
    if (loading) {
      return null
    }
    const { rightPanelVisible, rightPanelTab } = props.store
    // keep the icon lit while its panel is open so it reads as "click to close"
    const active = rightPanelVisible && rightPanelTab === 'info'
    return (
      <div className='terminal-footer-unit terminal-footer-info'>
        <BarChartOutlined
          onClick={handleInfoPanel}
          className={'pointer font14 terminal-info-icon' + (active ? ' active' : '')}
          title={e('terminalLog')}
        />
      </div>
    )
  }

  function renderCmdHistory () {
    return (
      <div className='terminal-footer-unit terminal-footer-history'>
        <CmdHistory store={props.store} />
      </div>
    )
  }

  // 底栏三合一：左区会话状态（原 statusbar 内容并入）
  // 编码展示省略（右侧编码 Select 已承载），Ctrl+K 提示由全局组命令面板按钮承载
  function renderStatusInfo () {
    const { store } = props
    const currentTab = store.currentTab
    const ok = currentTab && currentTab.status === statusMap.success
    const hasTab = !!currentTab
    const tabCount = (store.tabs || []).length
    return (
      <div className='terminal-footer-status'>
        <span className='statusbar-unit'>
          <i className={classnames('statusbar-dot', { ok, err: hasTab && !ok })} />
          {statusText(currentTab && currentTab.status)}
          {
            hasTab && currentTab.host
              ? <b className='statusbar-host'>{currentTab.host}</b>
              : null
          }
        </span>
        {
          hasTab
            ? <span className='statusbar-unit'>{typeText(currentTab)}</span>
            : null
        }
        <span className='statusbar-unit'>{tabCount} tab{tabCount === 1 ? '' : 's'}</span>
      </div>
    )
  }

  // 底栏三合一：右区全局动作（原 app-kbar 去重后独有项——
  // AI/快捷命令/命令历史与中区终端按钮重复，保留中区版本）
  function renderGlobalActions () {
    const { store } = props
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '')
    const items = [
      {
        key: 'new',
        icon: <PlusOutlined />,
        title: e('new'),
        run: () => store.onNewSsh()
      },
      {
        key: 'palette',
        icon: <SearchOutlined />,
        title: `命令面板 (${isMac ? '⌘K' : 'Ctrl+K'})`,
        run: () => window.dispatchEvent(new Event('open-command-palette'))
      },
      {
        key: 'setting',
        icon: <SettingOutlined />,
        title: e('setting'),
        run: () => store.openSettingModal()
      }
    ]
    return (
      <div className='terminal-footer-global'>
        {
          items.map(item => (
            <span
              key={item.key}
              className='terminal-footer-global-item'
              onClick={() => item.run()}
              role='button'
              tabIndex={0}
              title={item.title}
              onKeyDown={ev => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault()
                  item.run()
                }
              }}
            >
              {item.icon}
            </span>
          ))
        }
      </div>
    )
  }

  function handleShowSidebar () {
    window.store.toggleLeftSideBar()
  }

  const {
    leftSidePanelWidth,
    leftSideBarWidth,
    openedSideBar,
    inActiveTerminal,
    isMobile
  } = props.store
  const w = leftSideBarWidth + leftSidePanelWidth
  // icon bar hidden: show a control on the left of the footer to bring the
  // sidebar back
  const showSidebarIcon = leftSideBarWidth === 0
    ? (
      <div className='terminal-footer-unit terminal-footer-show-sidebar'>
        <DoubleRightOutlined
          className='pointer font18 show-sidebar-icon'
          onClick={handleShowSidebar}
        />
      </div>
      )
    : null
  // The footer mirrors the space layout.jsx reserves on the left.
  // Left: reserve while the panel is open OR pinned. A pinned left panel is
  // always open, so this is a superset of the pin state — and it is what keeps
  // the footer from painting over the panel, which spans bottom 0 in both
  // states. Right: nothing to reserve — the right panel stops above the whole
  // bottom stack (right-side-panel.styl), so the footer keeps its full width
  // in both pin states.
  const footerStyle = {}
  if (openedSideBar && !isMobile) {
    footerStyle.left = `${w}px`
  }
  const sideProps = {
    className: 'main-footer',
    style: footerStyle
  }
  // 底栏三合一后单一路径：状态区与全局组常显（原 statusbar/kbar 语义，
  // 不受 inActiveTerminal 门控），终端级按钮仅活动终端时显示
  return (
    <div {...sideProps}>
      <div className='terminal-footer-flex'>
        {!isMobile && renderStatusInfo()}
        {showSidebarIcon}
        {inActiveTerminal && !isAIDisabled() && renderAIIcon()}
        {inActiveTerminal && !isAIDisabled() && renderTransferIcon()}
        {inActiveTerminal && !isAIDisabled() && renderMonitorIcon()}
        {inActiveTerminal && renderCmdHistory()}
        {inActiveTerminal && renderQuickCommands()}
        {inActiveTerminal && renderTriggers()}
        {inActiveTerminal && renderBatchInputs()}
        {inActiveTerminal && renderEncodingInfo()}
        {inActiveTerminal && renderInfoIcon()}
        {!isMobile && renderGlobalActions()}
      </div>
    </div>
  )
})
