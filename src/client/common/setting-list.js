import {
  settingSyncId,
  settingShortcutsId,
  settingTerminalId,
  settingAiId,
  settingPasswordsId,
  settingSshKeyId,
  settingVaultId
} from '../common/constants'
import { isAIDisabled } from './ai-feature'

const e = window.translate

export default () => {
  const list = [
    {
      id: settingTerminalId,
      title: e('terminal')
    },
    {
      id: settingShortcutsId,
      title: e('settingShortcuts')
    },
    {
      id: settingSyncId,
      title: e('settingSync')
    },
    {
      id: settingAiId,
      title: 'AI'
    },
    {
      id: settingPasswordsId,
      title: e('password')
    },
    {
      id: settingSshKeyId,
      title: e('sshKeys')
    },
    {
      id: settingVaultId,
      title: e('vault')
    }
  ]
  let out = list
  if (isAIDisabled()) {
    out = out.filter(item => item.id !== settingAiId)
  }
  // 保险库是主进程能力（KEK/DEK 只在主进程内存里）：Web 版没有这条通道，
  // 摆一个点开只会报错的页签不如不摆
  if (window.et && window.et.isWebApp) {
    out = out.filter(item => item.id !== settingVaultId)
  }
  return out
}
