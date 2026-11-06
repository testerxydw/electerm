/**
 * Local (node-pty) terminal monitor.
 *
 * Remote sessions collect metrics through the SSH exec channel
 * (session-monitor.js). A local pty has no exec channel at all, so every
 * exec-cmd would fail and CPU/MEM/DISK/NET stayed at '—'. This module builds
 * the very same snapshot shape from `window.pre.osInfo()` (a sync bridge to
 * node's os module) plus a few cheap local fs commands for disk / network /
 * process counters.
 *
 * Everything that turns raw readings into monitor data is a named pure export,
 * so it can be unit tested without Electron or a DOM.
 */

import { useEffect, useMemo, useState } from 'react'
import { isMac, isWin } from '../../common/platform.js'
import {
  REMOTE_MONITOR_INTERVALS,
  deriveNetworkRates,
  getUsageLevel,
  parseActivities,
  parseDisks,
  parseNetwork,
  parseUsers
} from './monitor-model.js'
import { createEmptyMonitorSnapshot } from './session-monitor.js'

const DEFAULT_PLATFORM = Object.freeze({ isWin, isMac })

// Local cadence follows the remote one. `ps` is the only command that can
// produce hundreds of rows, so it is deliberately slower than its remote twin;
// everything else is either the same interval or a sync osInfo() read (no
// shell at all).
export const LOCAL_MONITOR_INTERVALS = Object.freeze({
  ...REMOTE_MONITOR_INTERVALS,
  activities: Math.max(REMOTE_MONITOR_INTERVALS.activities, 15000)
})

const LOCAL_CPU_SAMPLE_DELAY = 120
const DISK_COMMAND = 'df -Pk'
const USERS_COMMAND = 'who'
const ACTIVITIES_COMMAND = 'ps -eo pid=,user=,pcpu=,rss=,args= --sort=-pcpu'
const LINUX_NETWORK_COMMAND = 'cat /proc/net/dev'
const MAC_NETWORK_COMMAND = 'netstat -ib'
// runWinCmd wraps the script in `powershell.exe -Command "..."`, so Windows
// scripts must not contain double quotes. Get-PSDrive reports Used/Free in
// bytes, Get-NetAdapterStatistics reports cumulative byte counters.
const WINDOWS_NETWORK_COMMAND = 'Get-NetAdapterStatistics | Select-Object Name, ReceivedBytes, SentBytes | ConvertTo-Json -Compress'
const WINDOWS_DISKS_COMMAND = 'Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free | ConvertTo-Json -Compress'

/** Convert one osInfo() [{k, v}] payload into a plain key -> value map. */
export function parseOsInfoEntries (list) {
  const map = {}
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry.k !== 'string') {
      continue
    }
    let value = entry.v
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch (err) {
        // An older bridge may hand over a raw string; keep it as-is.
      }
    }
    map[entry.k] = value
  }
  return map
}

function finiteNumber (value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null
  }
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function integerCounter (value) {
  const number = finiteNumber(value)
  return number !== null && number >= 0 && Number.isInteger(number) ? number : null
}

function asString (value) {
  return typeof value === 'string' ? value : ''
}

const CPU_TIME_KEYS = ['user', 'nice', 'sys', 'idle', 'irq']

/** Aggregate os.cpus() times across all cores. Returns null for bad input. */
export function sumCpuTimes (cpus) {
  if (!Array.isArray(cpus) || !cpus.length) {
    return null
  }
  const totals = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, total: 0 }
  let counted = 0
  for (const cpu of cpus) {
    const times = cpu && cpu.times
    if (!times) {
      continue
    }
    const fields = CPU_TIME_KEYS.map(key => finiteNumber(times[key]))
    if (fields.some(value => value === null)) {
      continue
    }
    CPU_TIME_KEYS.forEach((key, index) => {
      totals[key] += fields[index]
    })
    counted += 1
  }
  if (!counted) {
    return null
  }
  totals.total = CPU_TIME_KEYS.reduce((sum, key) => sum + totals[key], 0)
  return totals
}

/** CPU usage (%) between two os.cpus() samples, mirroring parseCpu(). */
export function computeCpuUsage (previousCpus, currentCpus) {
  const previous = sumCpuTimes(previousCpus)
  const current = sumCpuTimes(currentCpus)
  if (!previous || !current) {
    return null
  }
  const totalDelta = current.total - previous.total
  if (totalDelta <= 0) {
    return null
  }
  const idleDelta = current.idle - previous.idle
  if (idleDelta < 0) {
    return null
  }
  const usedDelta = Math.max(0, totalDelta - idleDelta)
  return Math.max(0, Math.min(100, usedDelta * 100 / totalDelta))
}

/**
 * Rough CPU% from the 1-minute load average. os.cpus() times can be identical
 * across two very close samples (idle host / coarse timer), which would leave
 * the CPU group in an error state; loadavg gives a usable fallback.
 */
export function estimateCpuFromLoadAvg (loadavg, cpuCount) {
  const load = Array.isArray(loadavg) ? finiteNumber(loadavg[0]) : null
  const cores = finiteNumber(cpuCount)
  if (load === null || load < 0 || cores === null || cores <= 0) {
    return null
  }
  return Math.max(0, Math.min(100, load * 100 / cores))
}

/** Memory shape consumed by monitor-details.jsx / monitor-panel.jsx. */
export function buildMemoryData (osMap) {
  const map = osMap || {}
  const totalBytes = finiteNumber(map.totalmem)
  const freeBytes = finiteNumber(map.freemem)
  if (totalBytes === null || freeBytes === null || totalBytes <= 0) {
    return null
  }
  const availableBytes = Math.max(0, Math.min(totalBytes, freeBytes))
  const usedBytes = totalBytes - availableBytes
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    freeBytes: availableBytes,
    swapTotalBytes: null,
    swapUsedBytes: null,
    percent: usedBytes * 100 / totalBytes,
    // os.freemem() is "free", not "available": same compatibility mode
    // parseMemory() uses when MemAvailable is missing.
    compatibilityMode: true
  }
}

export function buildUptimeData (osMap, sampleTimestamp) {
  const seconds = finiteNumber(osMap && osMap.uptime)
  if (seconds === null || seconds < 0) {
    return null
  }
  const timestamp = finiteNumber(sampleTimestamp)
  return {
    seconds,
    bootTime: timestamp === null ? null : timestamp - seconds * 1000
  }
}

export function formatLocalOsName (osMap) {
  const map = osMap || {}
  const release = asString(map.release)
  const platform = asString(map.platform)
  const type = asString(map.type) || platform
  if (platform === 'win32' || type === 'Windows_NT') {
    const parts = release.split('.')
    const major = parseInt(parts[0], 10)
    const build = parseInt(parts[2], 10)
    if (major >= 10) {
      return Number.isFinite(build) && build >= 22000
        ? `Windows 11 (${release})`
        : `Windows 10 (${release})`
    }
    return `Windows (${release})`.trim()
  }
  if (platform === 'darwin' || type === 'Darwin') {
    return 'macOS'
  }
  if (platform === 'linux' || type === 'Linux') {
    return `Linux ${release}`.trim()
  }
  return type || release || 'Local'
}

/** sysinfo group data (the info panel replaces it with resolveLocalInfo). */
export function buildSysInfoData (osMap) {
  const map = osMap || {}
  const hostname = asString(map.hostname)
  const sysname = asString(map.type) || asString(map.platform)
  const kernel = asString(map.release)
  const arch = asString(map.arch)
  if (!hostname && !sysname && !kernel && !arch) {
    return null
  }
  return {
    os: formatLocalOsName(map),
    sysname,
    hostname,
    kernel,
    arch,
    shell: '',
    shellVersion: ''
  }
}

/** Fallback users group when `who` is unavailable (Windows / web app). */
export function buildUsersData (osMap) {
  const info = osMap && osMap.userInfo
  const user = info && typeof info === 'object' ? asString(info.username) : ''
  if (!user) {
    return null
  }
  return {
    users: [user],
    sessions: [{ user, terminal: null, loginTime: null, source: null }]
  }
}

/** Linux /proc/net/dev: 8 receive counters followed by 8 transmit counters. */
export function parseProcNetDev (text) {
  const result = []
  for (const line of asString(text).split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index < 1) {
      continue
    }
    const name = line.slice(0, index).trim()
    const fields = line.slice(index + 1).trim().split(/\s+/)
    if (!name || fields.length < 16) {
      continue
    }
    const rxBytes = integerCounter(fields[0])
    const txBytes = integerCounter(fields[8])
    if (rxBytes === null || txBytes === null) {
      continue
    }
    result.push({ name, rxBytes, txBytes })
  }
  return result
}

/** macOS `netstat -ib` <Link#N> rows: Ipkts Ierrs Ibytes Opkts Oerrs Obytes. */
export function parseNetstatIb (text) {
  const result = []
  for (const line of asString(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || !/<Link#/i.test(trimmed)) {
      continue
    }
    const fields = trimmed.split(/\s+/)
    const linkIndex = fields.findIndex(field => /^<Link#/i.test(field))
    if (linkIndex < 0) {
      continue
    }
    const numeric = []
    for (const field of fields.slice(linkIndex + 1)) {
      const value = integerCounter(field)
      if (value !== null) {
        numeric.push(value)
      }
    }
    if (numeric.length < 6) {
      continue
    }
    result.push({ name: fields[0], rxBytes: numeric[2], txBytes: numeric[5] })
  }
  return result
}

/** Windows Get-NetAdapterStatistics JSON. */
export function parseWindowsNetworkCounters (text) {
  let parsed
  try {
    parsed = JSON.parse(asString(text).trim())
  } catch (err) {
    return []
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const result = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const name = asString(entry.Name || entry.name)
    const rxBytes = integerCounter(entry.ReceivedBytes ?? entry.rxBytes)
    const txBytes = integerCounter(entry.SentBytes ?? entry.txBytes)
    if (!name || rxBytes === null || txBytes === null) {
      continue
    }
    result.push({ name, rxBytes, txBytes })
  }
  return result
}

/** Windows Get-PSDrive JSON -> the disk shape parseDisks() produces. */
export function parseWindowsDisks (text) {
  let parsed
  try {
    parsed = JSON.parse(asString(text).trim())
  } catch (err) {
    return null
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const disks = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const usedBytes = finiteNumber(entry.Used ?? entry.usedBytes)
    const availableBytes = finiteNumber(entry.Free ?? entry.availableBytes)
    const mount = asString(entry.Name || entry.name)
    if (usedBytes === null || availableBytes === null || !mount) {
      continue
    }
    const used = Math.max(0, usedBytes)
    const available = Math.max(0, availableBytes)
    const totalBytes = used + available
    if (totalBytes <= 0) {
      continue
    }
    disks.push({
      filesystem: mount,
      mount,
      totalBytes,
      usedBytes: used,
      availableBytes: available,
      percent: used * 100 / totalBytes
    })
  }
  return disks.length ? disks : null
}

/** First public IPv4 address per interface from os.networkInterfaces(). */
export function pickOsInterfaces (networkInterfaces) {
  const result = {}
  if (!networkInterfaces || typeof networkInterfaces !== 'object' || Array.isArray(networkInterfaces)) {
    return result
  }
  for (const [name, addresses] of Object.entries(networkInterfaces)) {
    if (!Array.isArray(addresses)) {
      continue
    }
    const ipv4 = addresses.find(addr => addr &&
      (addr.family === 'IPv4' || addr.family === 4) &&
      !addr.internal &&
      typeof addr.address === 'string'
    )
    if (ipv4) {
      result[name] = ipv4.address
    }
  }
  return result
}

function isLoopbackName (name) {
  return typeof name === 'string' &&
    (name === 'lo' || name.startsWith('lo:') || /^lo\d+$/.test(name))
}

export function parseLocalNetworkCounters (text, platform = DEFAULT_PLATFORM) {
  if (platform.isWin) {
    return parseWindowsNetworkCounters(text)
  }
  if (platform.isMac) {
    return parseNetstatIb(text)
  }
  return parseProcNetDev(text)
}

/**
 * Build a raw network sample in the shape parseNetwork() returns. The
 * counters only exist in local command output; IPv4 addresses come from
 * osInfo(), so a missing bridge still yields interfaces with null rates.
 */
export function buildNetworkSample (osMap, countersText, platform = DEFAULT_PLATFORM) {
  const map = osMap || {}
  const addresses = pickOsInterfaces(map.networkInterfaces)
  const byName = new Map()
  for (const counter of parseLocalNetworkCounters(countersText, platform)) {
    if (!counter || !counter.name || isLoopbackName(counter.name)) {
      continue
    }
    byName.set(counter.name, counter)
  }
  const names = [...new Set([...Object.keys(addresses), ...byName.keys()])]
    .filter(name => name && !isLoopbackName(name))
    .sort()
  if (!names.length) {
    return null
  }
  const lines = []
  for (const name of names) {
    const counter = byName.get(name)
    const rx = counter ? counter.rxBytes : null
    const tx = counter ? counter.txBytes : null
    lines.push([
      'iface',
      name,
      `state=${counter ? 'up' : 'unknown'}`,
      `ipv4=${addresses[name] || ''}`,
      `rx=${rx === null ? '' : rx}`,
      `tx=${tx === null ? '' : tx}`
    ].join('\t'))
  }
  // Prefer an interface that has both a public IPv4 and byte counters. An
  // address-only interface (virtual NIC, stale osInfo entry) would win the
  // defaultInterface slot otherwise and selectPrimaryNetwork() would keep
  // reporting '—' even though another interface has real rates.
  const ranked = names.map(name => ({
    name,
    hasCounters: byName.has(name),
    hasIpv4: !!addresses[name]
  }))
  const preferred = (
    ranked.find(item => item.hasCounters && item.hasIpv4) ||
    ranked.find(item => item.hasCounters) ||
    ranked.find(item => item.hasIpv4) ||
    ranked[0]
  ).name
  lines.unshift(`default\t${preferred}`)
  return parseNetwork(lines.join('\n'))
}

/** Apply one successful sample, keeping cpuHistory and levels in sync. */
export function applyLocalSample (snapshot, name, data, sampleTimestamp) {
  const groups = {
    ...snapshot.groups,
    [name]: {
      ...(snapshot.groups[name] || {}),
      status: 'ready',
      data,
      updatedAt: sampleTimestamp,
      error: null
    }
  }
  let cpuHistory = snapshot.cpuHistory
  if (name === 'cpu' && Number.isFinite(data)) {
    cpuHistory = [...cpuHistory, { timestamp: sampleTimestamp, value: data }].slice(-60)
  }
  const levels = { ...snapshot.levels }
  if (name === 'cpu') {
    levels.cpu = getUsageLevel(data, levels.cpu)
  }
  if (name === 'memory' && data) {
    levels.memory = getUsageLevel(data.percent, levels.memory)
  }
  if (name === 'disks' && Array.isArray(data)) {
    const disks = { ...levels.disks }
    for (const disk of data) {
      disks[disk.mount] = getUsageLevel(disk.percent, disks[disk.mount])
    }
    levels.disks = disks
  }
  return { ...snapshot, groups, cpuHistory, levels }
}

export function markLocalGroupError (snapshot, name, message, hadData) {
  return {
    ...snapshot,
    groups: {
      ...snapshot.groups,
      [name]: {
        ...(snapshot.groups[name] || {}),
        status: hadData ? 'stale' : 'error',
        error: message
      }
    }
  }
}

/** Web app (no osInfo bridge): empty groups plus a friendly unavailable state. */
export function createUnsupportedLocalSnapshot (sessionId, message) {
  const snapshot = createEmptyMonitorSnapshot(sessionId)
  return {
    ...snapshot,
    groups: Object.fromEntries(Object.entries(snapshot.groups).map(([name, group]) => [
      name,
      { ...group, status: 'unsupported', error: message || null }
    ]))
  }
}

export function isLocalMonitorSupported () {
  return typeof window !== 'undefined' &&
    !!window.pre &&
    typeof window.pre.osInfo === 'function'
}

function readLocalOsInfo () {
  const pre = typeof window !== 'undefined' ? window.pre : null
  if (!pre || typeof pre.osInfo !== 'function') {
    return {}
  }
  try {
    return parseOsInfoEntries(pre.osInfo())
  } catch (err) {
    return {}
  }
}

function normalizeCommandOutput (result) {
  if (typeof result === 'string') {
    return result
  }
  if (result && typeof result === 'object' && typeof result.stdout === 'string') {
    return result.stdout
  }
  return ''
}

// window.fs is installed by src/client/common/fs.js (imported for side effects
// by main.jsx). Access it lazily so this module can be imported in plain Node
// unit tests without a browser global bootstrap.
async function runLocalCommand (command, platform) {
  const bridge = typeof window !== 'undefined' ? window.fs : null
  if (!bridge) {
    throw new Error('Local fs bridge is unavailable')
  }
  if (platform.isWin) {
    if (typeof bridge.runWinCmd !== 'function') {
      throw new Error('Local Windows command bridge is unavailable')
    }
    return normalizeCommandOutput(await bridge.runWinCmd(command))
  }
  if (typeof bridge.run !== 'function') {
    throw new Error('Local command bridge is unavailable')
  }
  return normalizeCommandOutput(await bridge.run(command))
}

const monitors = new Map()
let subscriptionSequence = 0

/**
 * One collector per local session, shared between the info panel and the
 * monitor panel so a tab never runs two copies of the same local command.
 */
export class LocalMonitor {
  constructor (sessionId, options = {}) {
    this.sessionId = sessionId
    this.readOsInfo = options.readOsInfo || readLocalOsInfo
    this.runCommand = options.runCommand || runLocalCommand
    this.platform = options.platform || DEFAULT_PLATFORM
    this.intervals = { ...LOCAL_MONITOR_INTERVALS, ...(options.intervals || {}) }
    this.delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.snapshot = createEmptyMonitorSnapshot(sessionId)
    this.subscriptions = new Map()
    this.runners = new Map()
    this.networkSample = null
    this.cpuSample = null
    this.paused = false
    this.visibilityHandler = null
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          this.pause()
        } else {
          this.resume()
        }
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
    }
  }

  subscribe (groups, listener) {
    const id = ++subscriptionSequence
    const valid = (Array.isArray(groups) ? groups : [])
      .filter(name => Object.prototype.hasOwnProperty.call(this.intervals, name))
    this.subscriptions.set(id, { groups: new Set(valid), listener })
    listener(this.snapshot)
    this.reconcile()
    return () => {
      this.subscriptions.delete(id)
      if (!this.subscriptions.size) {
        this.destroy()
        if (monitors.get(this.sessionId) === this) {
          monitors.delete(this.sessionId)
        }
      } else {
        this.reconcile()
      }
    }
  }

  requestedGroups () {
    // sysinfo is a pure osInfo() read: always available, and used as the
    // hostname fallback by the monitor panel.
    const requested = new Set(['sysinfo'])
    for (const subscription of this.subscriptions.values()) {
      for (const group of subscription.groups) {
        requested.add(group)
      }
    }
    return requested
  }

  reconcile () {
    if (this.paused) {
      return
    }
    const requested = this.requestedGroups()
    for (const name of [...this.runners.keys()]) {
      if (!requested.has(name)) {
        this.stopGroup(name)
      }
    }
    for (const name of requested) {
      this.startGroup(name)
    }
  }

  startGroup (name) {
    if (this.paused || this.runners.has(name) || !this.snapshot.groups[name]) {
      return
    }
    const current = this.snapshot.groups[name]
    const interval = this.intervals[name]
    if (interval === 0 && current.status === 'ready') {
      return
    }
    if (current.status === 'unsupported') {
      return
    }
    const runner = { timer: null, failures: 0 }
    this.runners.set(name, runner)
    this.runGroup(name, runner).catch(error => {
      // runGroup already handles collection errors; this only guards against
      // an unexpected throw outside its try/catch.
      if (this.runners.get(name) === runner) {
        this.snapshot = markLocalGroupError(this.snapshot, name, error.message, false)
        this.emit()
      }
    })
  }

  stopGroup (name) {
    const runner = this.runners.get(name)
    if (!runner) {
      return
    }
    clearTimeout(runner.timer)
    this.runners.delete(name)
    if (name === 'network') {
      this.networkSample = null
    }
    if (name === 'cpu') {
      this.cpuSample = null
    }
  }

  pause () {
    this.paused = true
    for (const name of [...this.runners.keys()]) {
      this.stopGroup(name)
    }
  }

  resume () {
    if (!this.paused) {
      return
    }
    this.paused = false
    this.reconcile()
  }

  updateGroup (name, update) {
    this.snapshot = {
      ...this.snapshot,
      groups: {
        ...this.snapshot.groups,
        [name]: {
          ...this.snapshot.groups[name],
          ...update
        }
      }
    }
    this.emit()
  }

  emit () {
    for (const subscription of this.subscriptions.values()) {
      subscription.listener(this.snapshot)
    }
  }

  async runGroup (name, runner) {
    if (this.runners.get(name) !== runner) {
      return
    }
    const previous = this.snapshot.groups[name] || {}
    const hadData = previous.data !== null && previous.data !== undefined
    if (!hadData) {
      this.updateGroup(name, { status: 'loading', error: null })
    }
    try {
      const data = await this.collect(name)
      if (this.runners.get(name) !== runner) {
        return
      }
      if (data === null || data === undefined) {
        throw new Error('Local monitor data is unavailable')
      }
      this.snapshot = applyLocalSample(this.snapshot, name, data, Date.now())
      runner.failures = 0
      this.emit()
    } catch (error) {
      if (this.runners.get(name) !== runner) {
        return
      }
      runner.failures += 1
      this.snapshot = markLocalGroupError(
        this.snapshot,
        name,
        error && error.message ? error.message : String(error),
        hadData
      )
      this.emit()
    }
    if (this.runners.get(name) !== runner) {
      return
    }
    const interval = this.intervals[name]
    if (interval > 0 || runner.failures > 0) {
      const base = interval || 5000
      const backoff = Math.min(base * (2 ** runner.failures), 60000)
      runner.timer = setTimeout(() => this.runGroup(name, runner), backoff)
    } else {
      this.runners.delete(name)
    }
  }

  async collect (name) {
    // Command-only groups do not need a sync osInfo() IPC round trip.
    if (name === 'disks') return this.collectDisks()
    if (name === 'activities') return this.collectActivities()
    const osMap = this.readOsInfo()
    const timestamp = Date.now()
    if (name === 'sysinfo') return buildSysInfoData(osMap)
    if (name === 'memory') return buildMemoryData(osMap)
    if (name === 'uptime') return buildUptimeData(osMap, timestamp)
    if (name === 'cpu') return this.collectCpu(osMap)
    if (name === 'network') return this.collectNetwork(osMap, timestamp)
    if (name === 'users') return this.collectUsers(osMap)
    return null
  }

  async collectCpu (osMap) {
    let previous = this.cpuSample
    if (!previous) {
      previous = Array.isArray(osMap.cpus) ? osMap.cpus : null
      if (!previous) {
        return null
      }
      // First sample has no baseline: take a second osInfo() read a moment
      // later instead of leaving the panel blank for a full interval.
      await this.delay(LOCAL_CPU_SAMPLE_DELAY)
    }
    const currentMap = this.readOsInfo()
    const cpus = Array.isArray(currentMap.cpus) ? currentMap.cpus : null
    if (!cpus) {
      return null
    }
    this.cpuSample = cpus
    const usage = computeCpuUsage(previous, cpus)
    if (Number.isFinite(usage)) {
      return usage
    }
    return estimateCpuFromLoadAvg(currentMap.loadavg, cpus.length)
  }

  async collectNetwork (osMap, timestamp) {
    let command = LINUX_NETWORK_COMMAND
    if (this.platform.isWin) {
      command = WINDOWS_NETWORK_COMMAND
    } else if (this.platform.isMac) {
      command = MAC_NETWORK_COMMAND
    }
    let text = ''
    try {
      text = await this.runCommand(command, this.platform)
    } catch (err) {
      text = ''
    }
    const sample = buildNetworkSample(osMap, text, this.platform)
    if (!sample) {
      return null
    }
    const raw = { ...sample, sampleTimestamp: timestamp }
    const data = deriveNetworkRates(this.networkSample, raw, timestamp)
    this.networkSample = raw
    return data
  }

  async collectDisks () {
    const command = this.platform.isWin ? WINDOWS_DISKS_COMMAND : DISK_COMMAND
    const text = await this.runCommand(command, this.platform)
    return this.platform.isWin ? parseWindowsDisks(text) : parseDisks(text)
  }

  async collectUsers (osMap) {
    if (!this.platform.isWin) {
      let text = ''
      try {
        text = await this.runCommand(USERS_COMMAND, this.platform)
      } catch (err) {
        text = ''
      }
      const parsed = text ? parseUsers(text) : null
      if (parsed) {
        return parsed
      }
    }
    return buildUsersData(osMap)
  }

  async collectActivities () {
    if (this.platform.isWin) {
      return null
    }
    const text = await this.runCommand(ACTIVITIES_COMMAND, this.platform)
    return parseActivities(text)
  }

  destroy () {
    for (const name of [...this.runners.keys()]) {
      this.stopGroup(name)
    }
    this.subscriptions.clear()
    this.networkSample = null
    this.cpuSample = null
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
    }
    this.visibilityHandler = null
  }
}

function getLocalMonitor (sessionId) {
  let monitor = monitors.get(sessionId)
  if (!monitor) {
    monitor = new LocalMonitor(sessionId)
    monitors.set(sessionId, monitor)
  }
  return monitor
}

export function subscribeLocalMonitor (sessionId, groups, listener) {
  return getLocalMonitor(sessionId).subscribe(groups, listener)
}

/** Explicit cleanup hook (tests / hot reload). */
export function destroyLocalMonitor (sessionId) {
  const monitor = monitors.get(sessionId)
  if (monitor) {
    monitor.destroy()
    monitors.delete(sessionId)
  }
}

function documentIsVisible () {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function translate (key) {
  return typeof window !== 'undefined' && typeof window.translate === 'function'
    ? window.translate(key)
    : key
}

/**
 * React counterpart of useRemoteMonitor(): stops the subscription when the
 * panel is disabled/unmounted or the document is hidden, so no timer survives.
 */
export function useLocalMonitor (sessionId, groups, enabled = true) {
  const supported = isLocalMonitorSupported()
  const [visible, setVisible] = useState(documentIsVisible)
  const [snapshot, setSnapshot] = useState(() => supported
    ? createEmptyMonitorSnapshot(sessionId)
    : createUnsupportedLocalSnapshot(sessionId, translate('localMonitorUnavailable')))
  const groupKey = useMemo(
    () => [...new Set(Array.isArray(groups) ? groups : [])].sort().join(','),
    [groups]
  )

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }
    const onVisibilityChange = () => setVisible(documentIsVisible())
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  useEffect(() => {
    setSnapshot(supported
      ? createEmptyMonitorSnapshot(sessionId)
      : createUnsupportedLocalSnapshot(sessionId, translate('localMonitorUnavailable')))
    if (!enabled || !visible || !sessionId || !groupKey || !supported) {
      return
    }
    return subscribeLocalMonitor(
      sessionId,
      groupKey.split(',').filter(Boolean),
      setSnapshot
    )
  }, [enabled, groupKey, sessionId, supported, visible])

  if (snapshot.sessionId === sessionId) {
    return snapshot
  }
  return supported
    ? createEmptyMonitorSnapshot(sessionId)
    : createUnsupportedLocalSnapshot(sessionId, translate('localMonitorUnavailable'))
}
