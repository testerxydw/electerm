import { auto } from 'manate/react'
import { useEffect, useMemo, useState } from 'react'
import TerminalInfoBase from './base'
import MonitorDetails from '../remote-monitor/monitor-details'
import { getInfoPanelItems } from '../remote-monitor/monitor-model'
import { useMonitorDetails } from '../remote-monitor/use-monitor-details'
import { getRemoteMonitorTab } from '../remote-monitor/visibility'
import { statusMap } from '../../common/constants'
import { runCmd } from '../terminal/terminal-apis'
import resolveLocalInfo from './local-info-resolver'
import './terminal-info.styl'

/**
 * Local pty tab: same 7 filterable sections as a remote tab, but fed by the
 * local osInfo/fs collector instead of SSH exec-cmd. The hostname section
 * keeps using resolveLocalInfo() (os + shell + version) by merging it into
 * the local snapshot's sysinfo group.
 */
function LocalSystemInfo ({ tab, config }) {
  const items = getInfoPanelItems(config.terminalInfos)
  const [info, setInfo] = useState(null)
  useEffect(() => {
    let active = true
    resolveLocalInfo(tab.id)
      .then(res => {
        if (active) setInfo(res)
      })
      .catch(() => {
        if (active) setInfo(null)
      })
    return () => { active = false }
  }, [tab.id])
  const { snapshot, levels } = useMonitorDetails(tab.id, items, true, { isLocal: true })
  const merged = useMemo(() => {
    if (!info) {
      return snapshot
    }
    return {
      ...snapshot,
      groups: {
        ...snapshot.groups,
        sysinfo: {
          status: 'ready',
          data: info,
          updatedAt: Date.now(),
          error: null
        }
      }
    }
  }, [snapshot, info])
  return items.map(id => (
    <MonitorDetails
      key={id}
      id={id}
      snapshot={merged}
      levels={levels}
      tab={tab}
      config={config}
      includeActivity={false}
    />
  ))
}

function RemoteInfo ({ tab, config }) {
  const items = getInfoPanelItems(config.terminalInfos)
  const { snapshot, levels } = useMonitorDetails(tab.id, items, tab.status === statusMap.success)
  return items.map(id => (
    <MonitorDetails
      key={id}
      id={id}
      snapshot={snapshot}
      levels={levels}
      tab={tab}
      config={config}
      includeActivity={false}
      onKillProcess={pid => runCmd(tab.id, `kill ${pid}`)}
    />
  ))
}

export default auto(function TerminalInfo ({ store, ...props }) {
  const tab = getRemoteMonitorTab(store)
  if (store.rightPanelTab !== 'info' || props.pid !== tab?.id) return null
  const config = store.config
  return (
    <>
      <TerminalInfoBase {...props} terminalInfos={config.terminalInfos} />
      {props.isRemote
        ? <RemoteInfo key={tab.id} tab={tab} config={config} />
        : <LocalSystemInfo key={tab.id} tab={tab} config={config} />}
    </>
  )
})
