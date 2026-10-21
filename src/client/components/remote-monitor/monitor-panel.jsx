/**
 * 右面板「监控」页（对齐重设计草图 .card-r / .metric）
 * 复用既有远程监控采集（useMonitorDetails），渲染 CPU / 内存 / 磁盘 / 网络 四条指标。
 *
 * 采集策略：**默认关闭**——只有用户在本页手动开启开关后才开始采集（避免无谓的远端命令轮询）。
 * 开关状态存在 store.rightPanelMonitor（运行时状态，重启即回到默认关闭）。
 * 阈值配色：>70% 转 warn，>90% 转 error（对齐草图 .metric .bar i.warn）。
 */

import { auto } from 'manate/react'
import { Switch } from 'antd'
import { useMonitorDetails } from './use-monitor-details'
import { groupOf, formatBytes, formatRate, selectPrimaryNetwork } from './monitor-model'
import './monitor-panel.styl'

const e = window.translate
const ITEMS = ['cpu', 'memory', 'disks', 'network']

function pct (v) {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function level (p) {
  if (!Number.isFinite(p)) {
    return ''
  }
  if (p >= 90) {
    return 'error'
  }
  if (p >= 70) {
    return 'warn'
  }
  return ''
}

function Metric ({ label, value, percent, sub }) {
  const p = pct(percent)
  return (
    <div className='monitor-metric'>
      <span className='monitor-metric-lb'>{label}</span>
      <span className='monitor-metric-bar'>
        {
          p === null
            ? null
            : <i className={level(p)} style={{ width: `${p}%` }} />
        }
      </span>
      <span className='monitor-metric-vl'>{value == null ? '—' : value}</span>
      {sub ? <span className='monitor-metric-sub'>{sub}</span> : null}
    </div>
  )
}

export default auto(function MonitorPanel ({ store }) {
  // 默认关闭；仅在开关开启且当前就在监控页时才采集
  const monitorOn = !!store.rightPanelMonitor
  const enabled = monitorOn && store.rightPanelTab === 'monitor'
  const sessionId = store.activeTabId
  const { snapshot } = useMonitorDetails(sessionId, ITEMS, enabled)

  const cpu = pct(groupOf(snapshot, 'cpu').data)
  const memory = groupOf(snapshot, 'memory').data
  const disks = groupOf(snapshot, 'disks').data
  const network = groupOf(snapshot, 'network').data
  const primary = selectPrimaryNetwork(network)

  const firstDisk = Array.isArray(disks) ? disks[0] : null
  const diskPct = pct(firstDisk && firstDisk.percent)
  const memPct = pct(memory && memory.percent)

  return (
    <div className='monitor-panel'>
      <div className='monitor-panel-head'>
        <span>{e('systemLoad')}</span>
        <span className='monitor-panel-host'>{(store.currentTab && store.currentTab.host) || ''}</span>
        <Switch
          size='small'
          checked={monitorOn}
          onChange={v => { window.store.rightPanelMonitor = v }}
        />
      </div>
      {
        !monitorOn
          ? (
            <div className='monitor-panel-hint'>
              {e('monitorOffHint')}
            </div>
            )
          : (
            <>
              <Metric
                label='CPU'
                percent={cpu}
                value={cpu === null ? null : `${cpu.toFixed(0)}%`}
              />
              <Metric
                label='MEM'
                percent={memPct}
                value={memPct === null ? null : `${memPct.toFixed(0)}%`}
                sub={memory && Number.isFinite(memory.usedBytes)
                  ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`
                  : null}
              />
              <Metric
                label='DISK'
                percent={diskPct}
                value={diskPct === null ? null : `${diskPct.toFixed(0)}%`}
                sub={firstDisk && firstDisk.mount ? firstDisk.mount : null}
              />
              <Metric
                label='NET'
                percent={null}
                value={primary
                  ? `↑${formatRate(primary.txRate)} ↓${formatRate(primary.rxRate)}`
                  : null}
                sub={primary ? primary.name : null}
              />
              {
                !snapshot
                  ? <div className='monitor-panel-hint'>{e('monitorConnecting')}</div>
                  : null
              }
            </>
            )
      }
    </div>
  )
})
