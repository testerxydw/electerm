import {
  BookOutlined,
  FolderOutlined,
  ImportOutlined,
  ExportOutlined,
  CodeOutlined,
  MenuOutlined,
  EditOutlined,
  ApiOutlined
} from '@ant-design/icons'
import { useState } from 'react'
import { Button, Space, Dropdown, Flex, Modal, Input } from 'antd'
import copy from 'json-deep-copy'
import time from '../../common/time'
import download from '../../common/download'
import Upload from '../common/upload'
import { beforeBookmarkUpload } from './bookmark-upload'
import { parseDbUri } from '../../common/db-uri'
import { dbTypeLabelMap } from '../../common/constants'
import newTerm from '../../common/new-terminal'

const e = window.translate

export default function BookmarkToolbar (props) {
  const {
    onNewBookmark,
    onNewBookmarkGroup,
    onExport,
    onSshConfigs,
    bookmarkGroups,
    bookmarks
  } = props
  const beforeUpload = beforeBookmarkUpload

  const handleDownload = () => {
    const txt = JSON.stringify({
      bookmarkGroups: copy(bookmarkGroups || []),
      bookmarks: copy(bookmarks || [])
    }, null, 2)
    const stamp = time(undefined, 'YYYY-MM-DD-HH-mm-ss')
    download('bookmarks-' + stamp + '.json', txt)
  }
  const handleToggleEdit = () => {
    window.store.bookmarkSelectMode = true
  }

  // A5 数据库快速连接：URI → 临时 tab（不写书签；密码不进日志/标题）
  const [quickUri, setQuickUri] = useState('')
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickErr, setQuickErr] = useState('')

  const openQuickConnect = () => {
    setQuickUri('')
    setQuickErr('')
    setQuickOpen(true)
  }

  const submitQuickConnect = () => {
    let parsed
    try {
      parsed = parseDbUri(quickUri)
    } catch (err) {
      setQuickErr(err && err.message ? err.message : String(err))
      return
    }
    // 标题只含 主机/端口/库，不含密码
    const suffix = parsed.dbType === 'redis'
      ? String(parsed.dbIndex ?? 0)
      : (parsed.dbName || '')
    const label = dbTypeLabelMap[parsed.dbType] || parsed.dbType
    window.store.addTab({
      // 与书签打开路径同构：newTerm 供基础字段，db-session 挂载后 openDbTab 建连
      ...newTerm(true, true),
      type: 'database',
      from: 'quick-connect',
      title: `${label} ${parsed.dbUser}@${parsed.dbHost}:${parsed.dbPort}/${suffix}`,
      ...parsed,
      batch: window.openTabBatch ?? window.store.currentLayoutBatch
    })
    delete window.openTabBatch
    setQuickOpen(false)
  }
  const titleNew = `${e('new')} ${e('bookmarks')}`
  const titleEdit = `${e('new')} ${e('bookmarkCategory')}`
  const items = [
    {
      label: titleNew,
      onClick: onNewBookmark,
      icon: <BookOutlined />
    },
    {
      label: titleEdit,
      onClick: onNewBookmarkGroup,
      icon: <FolderOutlined />
    },
    {
      label: e('edit'),
      onClick: handleToggleEdit,
      icon: <EditOutlined />
    },
    {
      label: e('import'),
      onClick: () => {
        const fileInput = document.querySelector('.upload-bookmark-icon')
        if (fileInput) {
          fileInput.click()
        }
      },
      icon: <ImportOutlined />
    },
    {
      label: e('export'),
      onClick: onExport,
      icon: <ExportOutlined />
    },
    {
      label: e('loadSshConfigs'),
      onClick: onSshConfigs,
      icon: <CodeOutlined />
    }
  ]

  const ddProps = {
    menu: {
      items
    }
  }

  return (

    <div className='pd1b pd1r'>
      <Flex justify='space-between' align='center'>
        <div>
          <Space.Compact>
            <Button onClick={onNewBookmark}>
              <BookOutlined className='with-plus' />
            </Button>
            <Button onClick={onNewBookmarkGroup}>
              <FolderOutlined className='with-plus' />
            </Button>
            <Button
              icon={<EditOutlined />}
              onClick={handleToggleEdit}
              title={e('edit')}
            />
            <Button
              icon={<ExportOutlined />}
              onClick={handleDownload}
              title={e('export')}
              className='download-bookmark-icon'
            />
            <Upload
              beforeUpload={beforeUpload}
              fileList={[]}
              className='upload-bookmark-icon'
            >
              <Button
                icon={<ImportOutlined />}
                title={e('importFromFile')}
              />
            </Upload>
            <Button onClick={onSshConfigs}>
              <CodeOutlined />
            </Button>
            <Button
              icon={<ApiOutlined />}
              onClick={openQuickConnect}
              title={e('dbQuickConnect')}
            />
          </Space.Compact>
        </div>
        <div>
          <Dropdown {...ddProps}>
            <MenuOutlined />
          </Dropdown>
        </div>
      </Flex>
      {
        // A5 快速连接弹窗：URI 密码掩码（Input.Password 自带可见切换），错误显式展示
        quickOpen
          ? (
            <Modal
              open={quickOpen}
              title={e('dbQuickConnect')}
              onCancel={() => setQuickOpen(false)}
              onOk={submitQuickConnect}
              okText={e('connect')}
              width={520}
            >
              <Input.Password
                value={quickUri}
                placeholder={e('dbQuickConnectPlaceholder')}
                onChange={ev => {
                  setQuickUri(ev.target.value)
                  setQuickErr('')
                }}
                onPressEnter={submitQuickConnect}
                autoFocus
              />
              {
                quickErr
                  ? <div className='db-uri-err'>{quickErr}</div>
                  : null
              }
              <div className='db-uri-tip'>{e('dbQuickConnectTip')}</div>
            </Modal>
            )
          : null
      }
    </div>
  )
}
