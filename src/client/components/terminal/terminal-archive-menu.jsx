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
import { Dropdown, Tooltip } from 'antd'
import {
  FolderOpenOutlined,
  FileSearchOutlined,
  CopyOutlined
} from '@ant-design/icons'
import { refs } from '../common/ref.js'
import { copy } from '../../common/clipboard.js'
import message from '../common/message'

const e = window.translate

const baseName = p => String(p || '').split(/[\\/]/).pop()

export default function TerminalArchiveMenu ({ tab }) {
  // 点击时才取：Term 实例的注册顺序晚于本栏首次渲染，渲染期读会拿到空
  const info = () => {
    const term = refs.get('term-' + tab.id)
    const res = term?.getArchiveInfo?.()
    return res || { dir: null, parts: [] }
  }
  const notReady = () => {
    message.warning(e('archiveNotReady'))
  }
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
  }
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
    }
  ]
  return (
    <Dropdown
      menu={{ items, onClick }}
      trigger={['click']}
      placement='bottomLeft'
    >
      <Tooltip title={e('losslessArchive')} placement='bottomLeft'>
        <FolderOpenOutlined className='mg1r icon-info iblock pointer spliter archive-menu-icon' />
      </Tooltip>
    </Dropdown>
  )
}
