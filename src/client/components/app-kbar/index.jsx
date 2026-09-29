/**
 * 应用快捷键条（对齐重设计草图 .kbar）
 * —— 常显在 footer 之上、终端之下；显示「按键 + 动作」，点击即执行。
 * 键位只在**确有绑定**时显示（当前仅命令面板 Ctrl/Cmd+K 有全局绑定），
 * 其余条目只显示动作名，避免展示不存在的快捷键。
 */

import { auto } from 'manate/react'
import './index.styl'

const isMac = typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

export default auto(function AppKbar (props) {
  const { store } = props
  if (store.isMobile) {
    return null
  }
  const items = [
    {
      key: 'palette',
      kbd: isMac ? '⌘K' : 'Ctrl+K',
      label: '命令面板',
      run: () => window.dispatchEvent(new Event('open-command-palette'))
    },
    {
      key: 'new',
      label: '新建会话',
      run: () => store.onNewSsh()
    },
    {
      key: 'ai',
      label: 'AI 助手',
      run: () => {
        store.rightPanelVisible = true
        store.rightPanelTab = 'ai'
      }
    },
    {
      key: 'quickCommands',
      label: '快捷命令',
      run: () => {
        store.rightPanelVisible = true
        store.rightPanelTab = 'quickCommands'
      }
    },
    {
      key: 'cmdHistory',
      label: '命令历史',
      run: () => {
        store.rightPanelVisible = true
        store.rightPanelTab = 'cmdHistory'
      }
    },
    {
      key: 'setting',
      label: '设置',
      run: () => store.openSettingModal()
    }
  ]
  return (
    <div className='app-kbar'>
      {
        items.map(item => (
          <span
            key={item.key}
            className='app-kbar-item'
            onClick={() => item.run()}
            role='button'
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                item.run()
              }
            }}
          >
            {
              item.kbd
                ? <kbd>{item.kbd}</kbd>
                : null
            }
            {item.label}
          </span>
        ))
      }
    </div>
  )
})
