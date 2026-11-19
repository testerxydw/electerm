/**
 * 「完整输出」归档菜单 —— 顶栏入口。
 *
 * 归档本身由 session-server 的 TerminalOutputArchive 无条件落盘
 * （见 src/app/server/terminal-output-archive.js），这里只提供三个只读动作：
 * 打开归档目录 / 在文件夹中定位本会话分片 / 复制路径。
 *
 * 为什么不放右键菜单：右键行为可被配置成「粘贴」，此时上下文菜单根本
 * 不会出现（见 common/right-click-behavior.js），入口必须常驻顶栏。
 */
import { useCallback, useState } from 'react'
import { Dropdown, Tooltip } from 'antd'
import {
  FolderOpenOutlined,
  FileSearchOutlined,
  CopyOutlined,
  PlayCircleOutlined
} from '@ant-design/icons'
import { refs } from '../common/ref.js'
import { copy } from '../../common/clipboard.js'
import message from '../common/message'

const e = window.translate

const baseName = p => String(p || '').split(/[\\/]/).pop()

export default function TerminalArchiveMenu ({ tab }) {
  const [files, setFiles] = useState([])
  const [replaying, setReplaying] = useState(false)
  // 点击时才取：Term 实例的注册顺序晚于本栏首次渲染，渲染期读会拿到空
  const info = () => {
    const term = refs.get('term-' + tab.id)
    const res = term?.getArchiveInfo?.()
    return res || { dir: null, parts: [] }
  }
  const notReady = () => {
    message.warning(e('archiveNotReady'))
  }
  // 下拉展开时拉一次归档目录文件列表（losslessArchiveInfo.files 已含 name/size/mtimeMs）
  const loadFiles = useCallback(async () => {
    try {
      const stat = await window.pre.runGlobalAsync('losslessArchiveInfo')
      setFiles(Array.isArray(stat?.files) ? stat.files : [])
    } catch (err) {
      window.store.onError(err)
      setFiles([])
    }
  }, [])
  // 回放：分片读取 bin 原始字节 → 灌入当前 tab 渲染层（仅显示不执行）
  const replay = useCallback(async (name) => {
    if (replaying || !name) {
      return
    }
    const term = refs.get('term-' + tab.id)
    const addon = term?.attachAddon
    if (!addon) {
      return notReady()
    }
    setReplaying(true)
    try {
      let offset = 0
      let fed = 0
      let total = 0
      for (;;) {
        const part = await window.pre.runGlobalAsync('readLosslessArchive', name, { offset, size: 1024 * 1024 })
        if (!part || !part.bytes || !part.bytes.length) {
          break
        }
        total = part.total
        const res = await addon.replayArchive(part.bytes)
        if (!res?.ok) {
          if (res?.reason === 'busy') {
            message.warning(e('replayArchiveBusy'))
          }
          break
        }
        fed = part.offset + part.bytes.length
        offset = fed
        if (fed >= total) {
          break
        }
      }
      message.success(e('replayArchiveDone'))
    } catch (err) {
      window.store.onError(err)
    } finally {
      setReplaying(false)
    }
  }, [replaying, tab.id])
  const onClick = ({ key }) => {
    if (key === 'openDir') {
      window.pre.runGlobalAsync('openLosslessArchiveDir')
        .catch(window.store.onError)
      return
    }
    const { dir, parts } = info()
    if (key === 'reveal') {
      const latest = parts.length ? parts[parts.length - 1] : null
      if (!latest) {
        return notReady()
      }
      window.pre.runGlobalAsync('revealLosslessArchive', baseName(latest))
        .catch(window.store.onError)
      return
    }
    if (key === 'copy') {
      const txt = parts.length ? parts.join('\n') : dir
      if (!txt) {
        return notReady()
      }
      copy(txt)
    }
    if (String(key).startsWith('replay:')) {
      replay(String(key).slice('replay:'.length))
    }
  }
  const fmtSize = n => n > 1024 * 1024
    ? (n / 1024 / 1024).toFixed(1) + ' MB'
    : (n / 1024).toFixed(0) + ' KB'
  const replayItems = files.map(f => ({
    key: 'replay:' + f.name,
    label: baseName(f.name) + ' (' + fmtSize(f.size) + ')',
    disabled: replaying
  }))
  replayItems.push({ type: 'divider' })
  replayItems.push({
    key: 'replay-desc',
    label: e('replayArchiveDisclaimer'),
    disabled: true
  })
  const items = [
    {
      key: 'openDir',
      icon: <FolderOpenOutlined />,
      label: e('openArchiveDir')
    },
    {
      key: 'reveal',
      icon: <FileSearchOutlined />,
      label: e('revealArchiveFile')
    },
    {
      key: 'copy',
      icon: <CopyOutlined />,
      label: e('copyArchivePath')
    },
    { type: 'divider' },
    {
      key: 'replay-group',
      icon: <PlayCircleOutlined />,
      label: e('replayArchive'),
      children: replayItems
    }
  ]
  return (
    <Dropdown
      menu={{ items, onClick, onOpenChange: open => { if (open) loadFiles() } }}
      trigger={['click']}
      placement='bottomLeft'
    >
      <Tooltip title={e('losslessArchive')} placement='bottomLeft'>
        <FolderOpenOutlined className='mg1r icon-info iblock pointer spliter archive-menu-icon' />
      </Tooltip>
    </Dropdown>
  )
}
