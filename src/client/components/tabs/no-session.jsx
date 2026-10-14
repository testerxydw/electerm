import { Button, Popconfirm } from 'antd'
import { RobotOutlined, CloseOutlined } from '@ant-design/icons'
import LogoElem from '../common/logo-elem.jsx'
import HistoryPanel from '../sidebar/history'
import QuickConnect from './quick-connect'
import { isAIDisabled } from '../../common/ai-feature'
import './no-session.styl'

const e = window.translate

export default function NoSessionPanel ({ height, onNewTab, onNewSsh, batch, onClosePane }) {
  const props = {
    style: {
      height: height + 'px'
    }
  }
  const handleClick = () => {
    window.openTabBatch = batch
  }

  const handleCreateAIBookmark = () => {
    window.store.onNewSshAI()
  }

  const newTabDom = window.store.hasNodePty
    ? (
      <Button
        onClick={onNewTab}
        className='add-new-tab-btn'
      >
        {e('newTab')}
      </Button>
      )
    : null
  return (
    <div className='no-sessions electerm-logo-bg' {...props}>
      <div className='no-session-btns'>
        {newTabDom}
        {
          // 本窗格为空且当前是多窗格布局时，给出收起入口（二次确认，避免误触后
          // 分屏结构突然变化）
          onClosePane
            ? (
              <Popconfirm
                title={e('closeThisPane')}
                description={e('closeThisPaneHint')}
                okText={e('yes')}
                cancelText={e('no')}
                onConfirm={onClosePane}
              >
                <Button icon={<CloseOutlined />}>
                  {e('closeThisPane')}
                </Button>
              </Popconfirm>
              )
            : null
        }
        <Button
          onClick={onNewSsh}
        >
          {e('newBookmark')}
        </Button>
        {!isAIDisabled() && (
          <Button
            onClick={handleCreateAIBookmark}
            icon={<RobotOutlined />}
          >
            {e('createBookmarkByAI')}
          </Button>
        )}
        <QuickConnect batch={batch} />
      </div>
      <div className='no-session-logo'>
        <LogoElem />
      </div>
      <div className='no-session-history' onClick={handleClick}>
        <HistoryPanel sort />
      </div>
    </div>
  )
}
