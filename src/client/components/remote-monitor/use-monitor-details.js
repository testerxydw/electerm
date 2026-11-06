import { useMemo } from 'react'
import { MONITOR_ITEM_GROUP } from './monitor-model'
import { useRemoteMonitor } from './session-monitor'
import { useLocalMonitor } from './local-monitor'

/**
 * Resolve the monitor snapshot for one session.
 *
 * `options.isLocal` routes local pty tabs to the osInfo/fs based collector:
 * those sessions have no SSH exec channel, so sending exec-cmd would only
 * produce permanent '—' values. Remote tabs keep the original exec channel
 * path untouched. Both hooks are always called (React hook rules); the unused
 * one is disabled and never subscribes.
 */
export function useMonitorDetails (sessionId, items, enabled, options = {}) {
  const isLocal = options.isLocal === true
  const itemsKey = items.join(',')
  const groups = useMemo(() => [...new Set(items.map(id => MONITOR_ITEM_GROUP[id]).filter(Boolean))], [itemsKey])
  const remoteSnapshot = useRemoteMonitor(sessionId, groups, enabled && !isLocal)
  const localSnapshot = useLocalMonitor(sessionId, groups, enabled && isLocal)
  const snapshot = isLocal ? localSnapshot : remoteSnapshot
  return { snapshot, levels: snapshot.levels }
}
