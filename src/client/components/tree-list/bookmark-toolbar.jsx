import {
  BookOutlined,
  FolderOutlined,
  ImportOutlined,
  ExportOutlined,
  CodeOutlined,
  MenuOutlined,
  EditOutlined,
  ApiOutlined,
  CopyOutlined
} from '@ant-design/icons'
import { useState } from 'react'
import { Badge, Button, Space, Dropdown, Flex, Modal, Input } from 'antd'
import copy from 'json-deep-copy'
import time from '../../common/time'
import download from '../../common/download'
import Upload from '../common/upload'
import { beforeBookmarkUpload } from './bookmark-upload'
import { parseDbUri } from '../../common/db-uri'
import { countDuplicateBookmarks } from '../../common/bookmark-dedup'
import DuplicateBookmarksModal from './duplicate-bookmarks-modal'
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
  // B4：拦得住新的，拦不掉已有的 —— 存量重复给一条看得见的路。
  // 徽标数的是"多出来的条数"（3 条同名同连接 = 2），和导入时报的数是同一个口径。
  const [dupOpen, setDupOpen] = useState(false)
  const dupCount = countDuplicateBookmarks(bookmarks || [])
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
    },
    {
      label: e('dupBookmarks'),
      onClick: () => setDupOpen(true),
      icon: <CopyOutlined />
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
            <Badge count={dupCount} size='small' offset={[-2, 4]}>
              <Button
                icon={<CopyOutlined />}
                onClick={() => setDupOpen(true)}
                title={e('dupBookmarks')}
                className='dup-bookmarks-entry'
              />
            </Badge>
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
      {
        // B4 存量重复清单：关掉即卸载，下次打开重新按"留第一条、勾其余"起算，
        // 不会把上一轮没清完的勾选当成这一轮的默认
        dupOpen
          ? (
            <DuplicateBookmarksModal
              open={dupOpen}
              bookmarks={bookmarks}
              bookmarkGroups={bookmarkGroups}
              onClose={() => setDupOpen(false)}
            />
            )
          : null
      }
    </div>
  )
}
