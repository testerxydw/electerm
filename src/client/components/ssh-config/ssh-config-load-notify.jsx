import React, { useEffect } from 'react'
import { Button } from 'antd'
import { notification } from '../common/notification'
import * as ls from '../../common/safe-local-storage'
import {
  sshConfigKey,
  sshConfigLoadKey
} from '../../common/constants'
import { pickNewSshConfigItems, sshConfigGroupId } from '../../common/ssh-config-import'

const e = window.translate

function handleLoad () {
  window.store.showSshConfigModal = true
  notification.destroy('sshConfigNotify')
}

function handleIgnore () {
  ls.setItem(sshConfigKey, 'yes')
  notification.destroy('sshConfigNotify')
}

/** 这批本地配置里还有没有"没导入过"的：一条都没有就别再提示导入 */
function hasNewSshConfig (sshConfigs) {
  const { store } = window
  const group = (store.bookmarkGroups || []).find(d => d.id === sshConfigGroupId)
  return pickNewSshConfigItems(sshConfigs, store.bookmarks, group).length > 0
}

function showNotification () {
  notification.info({
    message: e('loadSshConfigs'),
    duration: 0,
    placement: 'bottom',
    key: 'sshConfigNotify',
    description: (
      <>
        <p>{e('sshConfigNotice')}</p>
        <Button type='primary' onClick={handleLoad} className='mg1r mg1b'>
          {e('import')}
        </Button>
        <Button onClick={handleIgnore} className='mg1r mg1b'>
          {e('ignore')}
        </Button>
      </>
    )
  })
}

export default function SshConfigLoadNotify (props) {
  const { settingTab, showModal, sshConfigs } = props

  useEffect(() => {
    const ignoreSshConfig = ls.getItem(sshConfigKey)
    const sshConfigLoaded = ls.getItem(sshConfigLoadKey)
    const shouldShow =
      sshConfigs.length &&
      hasNewSshConfig(sshConfigs) &&
      ignoreSshConfig !== 'yes' &&
      settingTab === 'bookmarks' &&
      showModal &&
      sshConfigLoaded !== 'yes' &&
      window.store.hasNodePty

    if (shouldShow) {
      showNotification()
    }
  }, [settingTab, showModal, sshConfigs.length])

  return null
}
