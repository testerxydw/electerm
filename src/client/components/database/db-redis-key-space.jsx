/**
 * Redis 键空间面板（独立组件，设计 §6.2 聚类 #11 配套渲染）
 *
 * 与 db-session.jsx 里的 `redisArea` 内联渲染一一对应，仅把"键空间"这一职责收拢到此处。
 * 行为零变更：JSX 结构与 db-session.jsx 原 `redisArea` 一致。
 *
 * 句柄归属（AGENTS.md §5.2.4）：本组件不拥有任何键空间之外的状态。
 *   - 键空间状态 / 操作来自 useDbRedisKeys 的返回值（keys.*）
 *   - 输入框 / 树展开的 setter、网格列定义、详情渲染、分页尺寸选择、列宽工具、
 *     只读判定、总页数换算等属于其它聚类或会话页，一律由 owner 注入：
 *       setMatchInput / setTreeSep / setRedisKeySel / setTreeExpanded / treeSep
 *       redisKeyColumns / redisKeyRows / redisKeyRowSelection / selectRedisKey
 *       renderDetail / renderPageSizeSelect / colFitAllBtn / redisKeysWidths
 *       isReadonly / redisKeyTotal / redisKeyPagesShow / redisPageNoText / redisDb / redisKey
 *
 * 已接线：db-session.jsx 的 const redisArea = (...) 改为渲染本组件，21 个顶层 props 由 owner 注入。
 * keys 是 useDbRedisKeys 返回值与 7 个 owner state 的合成对象（直传返回值会白屏）。
 * 详情渲染走 renderDetail() 回调；JSX 与原内联块逐字等价（仅此一处差异）。
 */
import React, { useState, useEffect, useRef } from 'react'
import { Segmented, Input, Button, Tooltip, Tree, Empty, Modal, Alert, Space, Tag, Select, InputNumber } from 'antd'
import { CodeOutlined, DeleteOutlined, ReloadOutlined, DatabaseOutlined, PlayCircleOutlined, PauseCircleOutlined, CopyOutlined, ApiOutlined, SendOutlined, PlusOutlined } from '@ant-design/icons'
import DbGridTable from './db-grid-table'
import DbSplitPane from './db-split-pane'
import { DbGridPager } from './db-grid-pager'
import { REDIS_SPLIT_KEY, REDIS_TREE_MAX_KEYS, REDIS_PROFILER_VIEW_MAX } from '../../common/db-session-const'
import { scanBigKeys, startRedisProfiler, getRedisProfilerData, toggleRedisProfilerPause, stopRedisProfiler, startRedisPubSub, getRedisPubSubData, toggleRedisPubSubPause, stopRedisPubSub } from './use-db-redis-keys'
import { buildCreateKeyPlan } from '../../common/db-redis-create-key'
import { cleanDbError } from './db-conn-error'

const e = window.translate

export function DbRedisKeySpace ({
  redisDb,
  redisKey,
  treeSep,
  setMatchInput,
  setTreeSep,
  setRedisKeySel,
  treeExpanded,
  setTreeExpanded,
  redisKeyColumns,
  redisKeyRows,
  redisKeyRowSelection,
  selectRedisKey,
  renderDetail,
  renderPageSizeSelect,
  colFitAllBtn,
  redisKeysWidths,
  isReadonly,
  redisKeyTotal,
  redisKeyPagesShow,
  redisPageNoText,
  // N5b：大 Key 扫描需要 tabId 调 dbClientOp
  tabId,
  // 来自 useDbRedisKeys 的返回值
  keys
}) {
  const {
    redisView,
    keyList,
    keyTree,
    matchInput,
    keyJumpInput,
    setKeyJumpInput,
    redisKeySel,
    redisTreeNodes,
    redisTreeStatus,
    redisTreeSelected,
    onRedisTreeSelect,
    switchRedisView,
    applyRedisFilter,
    cancelKeyTree,
    loadRedisKeys,
    jumpRedisKeysPage,
    refreshRedisView,
    openRedisDel,
    // N5a：控制台入口（弹层本体挂在 owner 上，这里只出按钮）
    openRedisConsole
  } = keys

  // N5b：大 Key 扫描 Modal state。打开按钮 → loading → 结果表格/错误，关闭即清理。
  // 每次点按钮都是一次全新扫描，不保留上次结果（跟 INFO 弹层的"打开即刷新"同口径）
  const [bigKeyModal, setBigKeyModal] = useState({ open: false, loading: false, rows: [], scanned: 0, truncated: false, cancelled: false, error: '' })

  const openBigKeyScan = () => {
    // tabId 是 nanoid+时间戳字符串（tab.id），不能按 number 判——
    // 原来写成 typeof tabId !== 'number' 导致按钮永远点了没反应（CDP 实机抓到）
    if (!tabId || redisDb < 0) {
      return
    }
    setBigKeyModal({ open: true, loading: true, rows: [], scanned: 0, truncated: false, cancelled: false, error: '' })
    scanBigKeys(tabId, redisDb).then(res => {
      setBigKeyModal(s => ({
        ...s,
        loading: false,
        rows: (res && res.rows) || [],
        scanned: (res && res.scanned) || 0,
        truncated: !!(res && res.truncated),
        cancelled: !!(res && res.cancelled)
      }))
    }).catch(err => {
      setBigKeyModal(s => ({ ...s, loading: false, error: (err && err.message) || e('dbRedisBigKeysFailed') }))
    })
  }
  const closeBigKeyModal = () => setBigKeyModal(s => ({ ...s, open: false }))

  // ---- 新建键（页面建键）：string/hash/list/set/zset ----
  // 服务端写 op 全部齐备（T12 类型化写 + setKey + expireKey），且 Redis 写命令
  // 对不存在的键自动建键 —— 所以这里纯 UI 组装，不加任何 server op。
  // 值解析与调用序列下沉到 common/db-redis-create-key.js（纯模块，单测钉口径），
  // 本组件只负责收集输入、按计划顺序调 op、把机器码错误翻成人话。
  const [createKeyModal, setCreateKeyModal] = useState({ open: false, saving: false, error: '' })
  const [ckKey, setCkKey] = useState('')
  const [ckType, setCkType] = useState('string')
  const [ckValue, setCkValue] = useState('')
  const [ckTtl, setCkTtl] = useState('')

  const CK_VALUE_PLACEHOLDER = {
    string: 'hello electerm',
    hash: 'field1=value1\nfield2=value2',
    list: 'item1\nitem2\nitem3',
    set: 'member1\nmember2',
    zset: '90 alice\n85 bob'
  }

  const openCreateKey = () => {
    if (!tabId || redisDb < 0) {
      return
    }
    setCkKey('')
    setCkType('string')
    setCkValue('')
    setCkTtl('')
    setCreateKeyModal({ open: true, saving: false, error: '' })
  }

  const closeCreateKey = () => {
    // 保存中不允许 Esc/遮罩关掉（半路放弃会留下建了一半的键，不如让用户看到错误）
    if (createKeyModal.saving) return
    setCreateKeyModal(s => ({ ...s, open: false }))
  }

  const submitCreateKey = async () => {
    setCreateKeyModal(s => ({ ...s, saving: true, error: '' }))
    try {
      const plan = buildCreateKeyPlan({
        key: ckKey,
        type: ckType,
        value: ckValue,
        ttlSeconds: ckTtl
      })
      if (plan.error) {
        throw new Error(e(plan.error))
      }
      for (const c of plan.calls) {
        await window.pre.runGlobalAsync('dbClientOp', tabId, c.op, {
          dbIndex: redisDb,
          key: ckKey.trim(),
          ...c.args
        })
      }
      setCreateKeyModal({ open: false, saving: false, error: '' })
      refreshRedisView()
    } catch (err) {
      setCreateKeyModal(s => ({
        ...s,
        saving: false,
        error: cleanDbError((err && err.message) || String(err))
      }))
    }
  }

  // N5c：Profiler (MONITOR) —— 独立 monitor client + 渲染侧定时器 200ms 拉流
  // state 全在这里：handleId 主进程句柄，rows 全量累计（overwrite 时 reset），
  // lastSeq 下次拉取从哪开始，paused 过滤输入
  const [profiler, setProfiler] = useState({
    open: false,
    running: false,
    handleId: null,
    rows: [],
    lastSeq: -1,
    paused: false,
    filter: '',
    overflow: false,
    error: ''
  })
  const timerRef = useRef(null)
  // pull 循环里读 lastSeq 必须走 ref：setInterval 闭包捕获的是 startPulling
  // 调用时刻的 state，profiler.lastSeq 恒为 -1 → 每次 pull 都全量拉取并
  // concat 重复累计（CDP 实机实测 8720 条命令被累计成 4.5 万行）
  const profilerLastSeqRef = useRef(-1)

  // 渲染侧展示行数上限：新行追加在尾部，超出丢最老（与主进程环形同思路）
  const capRows = (rows) => rows.length > REDIS_PROFILER_VIEW_MAX
    ? rows.slice(-REDIS_PROFILER_VIEW_MAX)
    : rows

  // 拉流：200ms 一次 getRedisProfilerData，按 lastSeq diff 增量追加
  const startPulling = (handleId) => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(async () => {
      try {
        const res = await getRedisProfilerData(tabId, handleId, profilerLastSeqRef.current)
        // 主进程停了 / 连接断了 → 清定时器
        if (res && res.stopped) {
          clearInterval(timerRef.current)
          timerRef.current = null
          setProfiler(s => ({ ...s, running: false }))
          return
        }
        setProfiler(s => {
          const newRows = res.rows || []
          let newLastSeq = s.lastSeq
          // overflow：主进程环形覆盖了旧数据 → 全量替换 + lastSeq 重置
          if (res.overflow) {
            newLastSeq = Math.max(-1, ...newRows.map(r => r.id))
            profilerLastSeqRef.current = newLastSeq
            return { ...s, rows: capRows(newRows), lastSeq: newLastSeq, overflow: true }
          }
          // 增量追加，取新行最大 id 作为下次起点
          if (newRows.length) {
            const maxId = Math.max(...newRows.map(r => r.id))
            if (maxId > newLastSeq) newLastSeq = maxId
          }
          profilerLastSeqRef.current = newLastSeq
          return { ...s, rows: capRows(s.rows.concat(newRows)), lastSeq: newLastSeq, paused: !!res.paused }
        })
      } catch (_) { /* IPC 临时失败忽略，下轮继续 */ }
    }, 200)
  }

  const openProfilerModal = () => {
    profilerLastSeqRef.current = -1
    setProfiler({ open: true, running: false, handleId: null, rows: [], lastSeq: -1, paused: false, filter: '', overflow: false, error: '' })
  }
  const closeProfilerModal = async () => {
    // 关 Modal 前先停 profiler（主进程 handle 也清）
    if (profiler.handleId && profiler.running) {
      try { await stopRedisProfiler(tabId, profiler.handleId) } catch (_) {}
    }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    profilerLastSeqRef.current = -1
    setProfiler(s => ({ ...s, open: false, running: false, handleId: null, rows: [] }))
  }
  const startProfiler = async () => {
    try {
      const res = await startRedisProfiler(tabId, redisDb, profiler.filter)
      profilerLastSeqRef.current = -1
      setProfiler(s => ({ ...s, running: true, handleId: res.handleId, rows: [], lastSeq: -1, overflow: false, error: '' }))
      startPulling(res.handleId)
    } catch (err) {
      setProfiler(s => ({ ...s, error: (err && err.message) || e('dbRedisProfilerStopped') }))
    }
  }
  const stopProfiler = async () => {
    if (profiler.handleId) {
      try { await stopRedisProfiler(tabId, profiler.handleId) } catch (_) {}
    }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setProfiler(s => ({ ...s, running: false, handleId: null }))
  }
  const togglePause = async () => {
    if (!profiler.handleId) return
    const newPaused = !profiler.paused
    try {
      const realPaused = await toggleRedisProfilerPause(tabId, profiler.handleId, newPaused)
      setProfiler(s => ({ ...s, paused: realPaused }))
    } catch (_) {}
  }
  const copyAll = async () => {
    const text = profiler.rows.map(r => r.text).join('\n')
    try { await navigator.clipboard.writeText(text) } catch (_) {}
  }

  // unmount 时必须清理定时器 + stop profiler，否则主进程环形缓冲永远占内存
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (profiler.handleId) {
      stopRedisProfiler(tabId, profiler.handleId).catch(() => {})
    }
  }, [])

  // N5f：Pub/Sub —— 与 Profiler 同一套协议（独立订阅 client + 主进程环形缓冲 +
  // 200ms 拉流）。subscribing 的清单/失败项由 start 返回（订阅失败是服务端语义
  // 不抛异常，UI 必须显式展示）；publish 测试行走控制台策略通道（PUBLISH 不在
  // BLOCKED 名单，只读模式下策略层按 COMMAND flags 判定，可能被拒——拒了就显示）
  const [pubsub, setPubsub] = useState({
    open: false,
    running: false,
    handleId: null,
    rows: [],
    lastSeq: -1,
    paused: false,
    overflow: false,
    error: '',
    channels: '',
    patterns: '',
    subs: null, // { channels, patterns, errors } 服务端确认过的订阅清单
    pubChannel: '',
    pubMessage: '',
    pubResult: ''
  })
  const psTimerRef = useRef(null)
  const psLastSeqRef = useRef(-1)
  // unmount 清理要走 ref：useEffect([]) 闭包里的 pubsub.handleId 永远是挂载时的
  // null（state 闭包陷阱），ref 才能拿到"此刻真的在订阅"的句柄
  const psHandleRef = useRef(null)
  const pubChannelReady = !!String(pubsub.pubChannel || '').trim()

  const startPsPulling = (handleId) => {
    if (psTimerRef.current) clearInterval(psTimerRef.current)
    psTimerRef.current = setInterval(async () => {
      try {
        const res = await getRedisPubSubData(tabId, handleId, psLastSeqRef.current)
        if (res && res.stopped) {
          clearInterval(psTimerRef.current)
          psTimerRef.current = null
          setPubsub(s => ({ ...s, running: false, handleId: null }))
          return
        }
        setPubsub(s => {
          const newRows = res.rows || []
          let newLastSeq = s.lastSeq
          if (res.overflow) {
            newLastSeq = Math.max(-1, ...newRows.map(r => r.id))
            psLastSeqRef.current = newLastSeq
            return { ...s, rows: capRows(newRows), lastSeq: newLastSeq, overflow: true }
          }
          if (newRows.length) {
            const maxId = Math.max(...newRows.map(r => r.id))
            if (maxId > newLastSeq) newLastSeq = maxId
          }
          psLastSeqRef.current = newLastSeq
          return { ...s, rows: capRows(s.rows.concat(newRows)), lastSeq: newLastSeq, paused: !!res.paused }
        })
      } catch (_) { /* IPC 临时失败忽略，下轮继续 */ }
    }, 200)
  }

  const openPubsubModal = () => {
    if (!tabId || redisDb < 0) {
      return
    }
    psLastSeqRef.current = -1
    setPubsub(s => ({ ...s, open: true, running: false, handleId: null, rows: [], lastSeq: -1, paused: false, overflow: false, error: '', subs: null, pubResult: '' }))
  }
  const closePubsubModal = async () => {
    if (pubsub.handleId && pubsub.running) {
      try { await stopRedisPubSub(tabId, pubsub.handleId) } catch (_) {}
    }
    psHandleRef.current = null
    if (psTimerRef.current) { clearInterval(psTimerRef.current); psTimerRef.current = null }
    psLastSeqRef.current = -1
    setPubsub(s => ({ ...s, open: false, running: false, handleId: null, rows: [] }))
  }
  const startPubsub = async () => {
    try {
      const res = await startRedisPubSub(tabId, pubsub.channels, pubsub.patterns)
      psLastSeqRef.current = -1
      psHandleRef.current = res.handleId
      setPubsub(s => ({
        ...s,
        running: true,
        handleId: res.handleId,
        rows: [],
        lastSeq: -1,
        overflow: false,
        error: '',
        subs: { channels: res.channels || [], patterns: res.patterns || [], errors: res.errors || [] }
      }))
      startPsPulling(res.handleId)
    } catch (err) {
      setPubsub(s => ({ ...s, error: (err && err.message) || e('dbRedisPubSubStartFailed') }))
    }
  }
  const stopPubsub = async () => {
    if (pubsub.handleId) {
      try { await stopRedisPubSub(tabId, pubsub.handleId) } catch (_) {}
    }
    psHandleRef.current = null
    if (psTimerRef.current) { clearInterval(psTimerRef.current); psTimerRef.current = null }
    setPubsub(s => ({ ...s, running: false, handleId: null, paused: false }))
  }
  const togglePubsubPause = async () => {
    if (!pubsub.handleId) return
    const newPaused = !pubsub.paused
    try {
      const realPaused = await toggleRedisPubSubPause(tabId, pubsub.handleId, newPaused)
      setPubsub(s => ({ ...s, paused: realPaused }))
    } catch (_) {}
  }
  const copyPubsub = async () => {
    const text = pubsub.rows
      .map(r => `[${r.kind}] ${r.channel}: ${r.text}`)
      .join('\n')
    try { await navigator.clipboard.writeText(text) } catch (_) {}
  }
  const clearPubsubRows = () => {
    psLastSeqRef.current = pubsub.lastSeq
    setPubsub(s => ({ ...s, rows: [], overflow: false }))
  }
  // PUBLISH 测试行：走控制台策略通道（runRedisCommand），分词/黑白名单都在
  // 主进程判定一次。channel/message 带引号转义（tokenize 支持 " 与 \ 转义）。
  // 返回形状与控制台一致：{ status:'ok', reply } / { status:'blocked'|'error', reason|error }
  const quoteArg = s => '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  const sendPublish = async () => {
    if (!pubChannelReady) return
    setPubsub(s => ({ ...s, pubResult: '' }))
    try {
      const res = await window.pre.runGlobalAsync('dbClientOp', tabId, 'runRedisCommand', {
        line: `PUBLISH ${quoteArg(pubsub.pubChannel)} ${quoteArg(pubsub.pubMessage)}`,
        dbIndex: redisDb
      })
      if (res && res.status === 'ok') {
        const n = Array.isArray(res.reply) ? res.reply[0] : res.reply
        setPubsub(s => ({
          ...s,
          pubResult: `${e('dbRedisPubSubPublishOk')}${typeof n === 'number' ? ' · ' + n : ''}`
        }))
      } else {
        setPubsub(s => ({ ...s, pubResult: (res && (res.error || res.reason)) || e('dbRedisPubSubPublishFailed') }))
      }
    } catch (err) {
      setPubsub(s => ({ ...s, pubResult: (err && err.message) || e('dbRedisPubSubPublishFailed') }))
    }
  }

  // unmount 时清理 pubsub 定时器 + 订阅连接（句柄走 ref，见上）
  useEffect(() => () => {
    if (psTimerRef.current) clearInterval(psTimerRef.current)
    if (psHandleRef.current) {
      stopRedisPubSub(tabId, psHandleRef.current).catch(() => {})
    }
  }, [])
  return (
    <div className='db-redis-area'>
      {
        redisDb < 0
          ? <Empty description={e('dbSelectDb')} />
          : (
            <>
              <div className='db-redis-bar'>
                {/* H7a：同一份键空间两种看法。列表 = 游标分页（一页一次 IPC），
                    键树 = 全量抓取后分层；切换只换视图，不改任何数据写路径 */}
                <Segmented
                  size='small'
                  value={redisView}
                  onChange={switchRedisView}
                  options={[
                    { label: e('dbRedisViewList'), value: 'list' },
                    { label: e('dbRedisViewTree'), value: 'tree' }
                  ]}
                />
                <Input
                  size='small'
                  placeholder={e('dbMatchPlaceholder')}
                  value={matchInput}
                  onChange={ev => setMatchInput(ev.target.value)}
                  onPressEnter={applyRedisFilter}
                  className='db-redis-match'
                  allowClear
                />
                <Button
                  size='small'
                  onClick={applyRedisFilter}
                >
                  {e('filter')}
                </Button>
                {
                  redisView === 'tree'
                    ? (
                      <>
                        {/* 分隔符可配：改一下只重分层，不会重扫上万键（树在 useMemo 里算） */}
                        <span className='db-redis-tree-sep'>
                          <span className='db-redis-tree-sep-label'>{e('dbKeyTreeSep')}</span>
                          <Input
                            size='small'
                            className='db-redis-tree-sep-input'
                            value={treeSep}
                            maxLength={8}
                            onChange={ev => setTreeSep(ev.target.value)}
                          />
                        </span>
                        <span
                          className={'db-redis-tree-status' + (keyTree.truncated ? ' is-truncated' : '')}
                        >
                          {redisTreeStatus}
                          {
                            keyTree.truncated
                              ? ' · ' + e('dbKeyTreeTruncated').replace('{n}', REDIS_TREE_MAX_KEYS)
                              : ''
                          }
                        </span>
                        {
                          keyTree.loading
                            ? (
                              <Button size='small' onClick={cancelKeyTree}>
                                {e('cancel')}
                              </Button>
                              )
                            : null
                        }
                      </>
                      )
                    : (
                      <>
                        {/* H1a-4：分页条与数据页 / SQL 结果统一走 DbGridPager
                            （SCAN 无 offset：上一页走游标栈回退，下一页前向步进） */}
                        <DbGridPager
                          prevDisabled={keyList.stack.length === 0 || keyList.loading}
                          onPrev={() => {
                            const stack = keyList.stack
                            loadRedisKeys(
                              redisDb,
                              stack[stack.length - 1],
                              keyList.match,
                              stack.slice(0, -1)
                            )
                          }}
                          nextDisabled={!keyList.hasMore || keyList.loading}
                          onNext={() => loadRedisKeys(
                            redisDb,
                            keyList.nextCursor,
                            keyList.match,
                            [...keyList.stack, keyList.cursor]
                          )}
                          pageNoText={redisPageNoText}
                          // 页数是按键数换算的，把键数挂上去说明依据（键会随并发写入变化）
                          pageNoTitle={typeof redisKeyTotal === 'number'
                            ? e('dbKeysTotal').replace('{n}', redisKeyTotal)
                            : undefined}
                          // R1：键列表任意跳页（SCAN 无 offset，后端前向步进到目标页）
                          jump={{
                            numeric: false,
                            value: keyJumpInput,
                            onChange: ev => setKeyJumpInput(ev.target.value),
                            onPressEnter: () => jumpRedisKeysPage(keyJumpInput),
                            disabled: keyList.loading,
                            placeholder: redisKeyPagesShow ? '1-' + redisKeyPagesShow : e('dbPagePlaceholder')
                          }}
                          goDisabled={keyList.loading || !String(keyJumpInput).trim()}
                          onGo={() => jumpRedisKeysPage(keyJumpInput)}
                        />
                        {renderPageSizeSelect()}
                        {/* H1a-2：键名列宽工具（长键名加宽后一键回到按内容自适应） */}
                        {colFitAllBtn(redisKeysWidths)}
                        {/* H7b-3：跨页勾选后当前页可能一个都没选，需要常驻的"已选 N"提示
                            （否则翻一页就看不见自己选了什么，只剩按钮上的数字） */}
                        {
                          redisKeySel.length
                            ? (
                              <span className='db-redis-sel-chip'>
                                {e('dbRedisSelCount').replace('{n}', String(redisKeySel.length))}
                                <Button
                                  type='link'
                                  size='small'
                                  className='db-redis-sel-clear'
                                  onClick={() => setRedisKeySel([])}
                                >
                                  {e('dbRedisSelClear')}
                                </Button>
                              </span>
                              )
                            : null
                        }
                        {/* H7b-3：批量删键入口。只读时禁用并说明原因（主进程还会再拦一道） */}
                        <Tooltip title={isReadonly ? e('dbRedisDelKeysReadonly') : ''}>
                          <Button
                            size='small'
                            danger
                            icon={<DeleteOutlined />}
                            disabled={!redisKeySel.length || isReadonly || keyList.loading}
                            onClick={openRedisDel}
                          >
                            {e('dbRedisDelKeys')}{redisKeySel.length ? `(${redisKeySel.length})` : ''}
                          </Button>
                        </Tooltip>
                      </>
                      )
                }
                {/* 新建键：走 T12 类型化写 op（写命令对不存在的键自动建键）。
                    只读时禁用（主进程还会按权威只读位再拦一道）；未选 db 禁用 */}
                <Tooltip title={isReadonly ? e('dbRedisCreateKeyReadonly') : (redisDb < 0 ? e('dbSelectDb') : e('dbRedisCreateKey'))}>
                  <Button
                    size='small'
                    icon={<PlusOutlined />}
                    disabled={isReadonly || redisDb < 0}
                    onClick={openCreateKey}
                  >
                    {e('dbRedisCreateKey')}
                  </Button>
                </Tooltip>
                {/* 刷新放在翻页之后，与 MySQL 网格头一致；两种视图共用这一个入口 */}
                <Button
                  size='small'
                  icon={<ReloadOutlined />}
                  loading={redisView === 'tree' ? keyTree.loading : keyList.loading}
                  title={e('refresh')}
                  onClick={refreshRedisView}
                />
                {
                  // N5a：命令控制台。开在这里而不是顶栏，因为它打的是**当前 db**：
                  // 顶栏那个位置放的是"整实例"的事（INFO），两者混在一排会让人
                  // 以为控制台也是跨库的。禁用条件交给主进程（那边按权威只读位拦），
                  // 所以这里不设 disabled —— 只读下仍然能敲读命令
                  <Button
                    size='small'
                    icon={<CodeOutlined />}
                    className='db-redis-console-open'
                    onClick={openRedisConsole}
                  >
                    {e('dbRedisConsole')}
                  </Button>
                }
                {/* N5b：大 Key / MEMORY USAGE 扫描入口。只读可开（MEMORY USAGE 是只读命令），
                    跟控制台不同——控制台禁用是因为它可能跑写命令，这里只有 TYPE+STRLEN+MEMORY USAGE */}
                <Button
                  size='small'
                  icon={<DatabaseOutlined />}
                  className='db-redis-bigkeys-open'
                  onClick={openBigKeyScan}
                  disabled={redisDb < 0}
                >
                  {e('dbRedisBigKeys')}
                </Button>
                {/* N5c：Profiler (MONITOR) 入口。只读可开（MONITOR 是只读订阅命令）。
                    对生产有性能影响——Modal 打开时顶部会弹 Alert 警告 */}
                <Button
                  size='small'
                  icon={<PlayCircleOutlined />}
                  className='db-redis-profiler-open'
                  onClick={openProfilerModal}
                  disabled={redisDb < 0}
                >
                  {e('dbRedisProfiler')}
                </Button>
                {/* N5f：Pub/Sub 入口。订阅本身是只读命令，只读连接可开；
                    面板内的 PUBLISH 测试行走控制台策略通道，只读下可能被策略拒绝 */}
                <Button
                  size='small'
                  icon={<ApiOutlined />}
                  className='db-redis-pubsub-open'
                  onClick={openPubsubModal}
                  disabled={redisDb < 0}
                >
                  {e('dbRedisPubSub')}
                </Button>
              </div>
              <DbSplitPane
                storageKey={REDIS_SPLIT_KEY}
                top={
                  redisView === 'tree'
                    ? (
                      <div className='db-redis-tree'>
                        {
                          redisTreeNodes.length
                            ? (
                              <Tree
                                blockNode
                                selectable
                                treeData={redisTreeNodes}
                                expandedKeys={treeExpanded}
                                onExpand={ks => setTreeExpanded(ks)}
                                selectedKeys={redisTreeSelected}
                                onSelect={onRedisTreeSelect}
                                titleRender={node => (
                                  <span
                                    className='db-redis-tree-node'
                                    title={node.keyName || node.title}
                                  >
                                    <span className='db-redis-tree-title'>{node.title}</span>
                                    <span className='db-redis-tree-count'>{node.count}</span>
                                  </span>
                                )}
                              />
                              )
                            : (
                              <div className='db-redis-tree-empty'>
                                <Empty description={keyTree.loading ? e('dbLoading') : e('noData')} />
                              </div>
                              )
                        }
                      </div>
                      )
                    : (
                      <DbGridTable
                        className='db-redis-keys'
                        size='small'
                        loading={keyList.loading}
                        columns={redisKeyColumns}
                        dataSource={redisKeyRows}
                        rowKey='name'
                        pagination={false}
                        rowSelection={redisKeyRowSelection}
                        onRow={r => ({ onClick: () => selectRedisKey(r.name) })}
                        rowClassName={r => (r.name === redisKey ? 'db-row-selected' : '')}
                      />
                      )
                }
                bottom={
                  redisKey
                    ? renderDetail()
                    : (
                      <div className='db-redis-detail db-redis-detail-empty'>
                        <Empty description={e('dbSelectKey')} />
                      </div>
                      )
                }
              />
            </>
            )
      }
      {/* N5b：大 Key / MEMORY USAGE 扫描 Modal。独立于键空间面板，关闭即清理 */}
      <Modal
        open={bigKeyModal.open}
        title={e('dbRedisBigKeysTitle')}
        className='db-redis-bigkeys-modal'
        onCancel={closeBigKeyModal}
        footer={null}
        width={720}
        destroyOnClose
      >
        {bigKeyModal.loading
          ? <div className='db-redis-bigkeys-loading'>{e('dbLoading')}…</div>
          : bigKeyModal.error
            ? <div className='db-redis-bigkeys-error'>{bigKeyModal.error}</div>
            : bigKeyModal.rows.length
              ? (
                <>
                  <div className='db-redis-bigkeys-summary'>
                    {e('dbRedisBigKeysSummary')
                      .replace('{n}', String(bigKeyModal.scanned))
                      .replace('{m}', String(bigKeyModal.rows.length))}
                    {bigKeyModal.truncated ? ` · ${e('dbRedisBigKeysTruncated')}` : ''}
                    {bigKeyModal.cancelled ? ` · ${e('dbRedisBigKeysCancelled')}` : ''}
                  </div>
                  {/* 统一滚动通道：弹层表格区定高，表头吸顶 / 表体内部滚 / virtual
                      全由 DbGridTable 承担，弹层不再手写 scroll.y */}
                  <DbGridTable
                    height={460}
                    size='small'
                    pagination={false}
                    rowKey='name'
                    columns={[
                      { title: e('dbRedisBigKeysColName'), dataIndex: 'name', width: 420, ellipsis: true, copyable: true },
                      { title: e('dbRedisBigKeysColType'), dataIndex: 'type', width: 100 },
                      { title: e('dbRedisBigKeysColSize'), dataIndex: 'size', width: 140, render: v => Number(v).toLocaleString() }
                    ]}
                    dataSource={bigKeyModal.rows}
                    onRow={r => ({ onClick: () => { selectRedisKey(r.name); closeBigKeyModal() } })}
                  />
                </>
                )
              : <Empty description={e('dbRedisBigKeysEmpty')} />}
      </Modal>
      {/* 新建键 Modal：按类型给对应值编辑器，保存中禁关（避免半途留脏键） */}
      <Modal
        open={createKeyModal.open}
        title={e('dbRedisCreateKey')}
        onCancel={closeCreateKey}
        width={560}
        maskClosable={!createKeyModal.saving}
        footer={[
          <Button key='cancel' disabled={createKeyModal.saving} onClick={closeCreateKey}>
            {e('cancel')}
          </Button>,
          <Button
            key='ok'
            type='primary'
            loading={createKeyModal.saving}
            onClick={submitCreateKey}
          >
            {e('dbRedisCreateKeySave')}
          </Button>
        ]}
      >
        <div className='db-redis-create-key-form'>
          <div className='db-redis-create-key-row'>
            <span className='db-redis-create-key-label'>{e('dbRedisCreateKeyName')}</span>
            <Input
              value={ckKey}
              disabled={createKeyModal.saving}
              maxLength={1024}
              onChange={ev => setCkKey(ev.target.value)}
              placeholder='user:1001:name'
            />
          </div>
          <div className='db-redis-create-key-row'>
            <span className='db-redis-create-key-label'>{e('dbRedisCreateKeyType')}</span>
            <Select
              value={ckType}
              disabled={createKeyModal.saving}
              style={{ width: 160 }}
              onChange={v => setCkType(v)}
              options={[
                { value: 'string', label: 'string' },
                { value: 'hash', label: 'hash' },
                { value: 'list', label: 'list' },
                { value: 'set', label: 'set' },
                { value: 'zset', label: 'zset' }
              ]}
            />
            <span className='db-redis-create-key-label'>{e('dbRedisCreateKeyTtl')}</span>
            <InputNumber
              value={ckTtl === '' ? undefined : Number(ckTtl)}
              disabled={createKeyModal.saving}
              min={1}
              style={{ width: 120 }}
              placeholder={e('dbRedisCreateKeyTtlOptional')}
              onChange={v => setCkTtl(v === undefined || v === null ? '' : String(v))}
            />
          </div>
          <div className='db-redis-create-key-row'>
            <span className='db-redis-create-key-label'>{e('dbRedisCreateKeyValue')}</span>
            <Input.TextArea
              value={ckValue}
              disabled={createKeyModal.saving}
              rows={ckType === 'string' ? 6 : 8}
              onChange={ev => setCkValue(ev.target.value)}
              placeholder={CK_VALUE_PLACEHOLDER[ckType] || ''}
            />
          </div>
          {
            ckType !== 'string'
              ? <Alert type='info' showIcon message={e('dbRedisCreateKeyHint' + ckType)} style={{ marginTop: 4 }} />
              : null
          }
          {createKeyModal.error
            ? <Alert type='error' showIcon message={createKeyModal.error} style={{ marginTop: 8 }} />
            : null}
        </div>
      </Modal>
      {/* N5c：Profiler (MONITOR) Modal。顶部 Alert 警告 + 控制 Space + 过滤 + 实时 Table */}
      <Modal
        open={profiler.open}
        title={e('dbRedisProfilerTitle')}
        onCancel={closeProfilerModal}
        footer={null}
        width={880}
        destroyOnClose
      >
        <Alert type='warning' showIcon message={e('dbRedisProfilerWarn')} style={{ marginBottom: 12 }} />
        <Space style={{ marginBottom: 8 }}>
          {!profiler.running
            ? (
              <Button size='small' type='primary' icon={<PlayCircleOutlined />} onClick={startProfiler} disabled={redisDb < 0}>
                {e('dbRedisProfilerStart')}
              </Button>
              )
            : (
              <Button size='small' danger icon={<PlayCircleOutlined />} onClick={stopProfiler}>
                {e('dbRedisProfilerStop')}
              </Button>
              )}
          {profiler.running && (
            <Button size='small' icon={profiler.paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />} onClick={togglePause}>
              {profiler.paused ? e('dbRedisProfilerResume') : e('dbRedisProfilerPause')}
            </Button>
          )}
          <Button size='small' icon={<CopyOutlined />} onClick={copyAll} disabled={!profiler.rows.length}>
            {e('dbRedisProfilerCopy')}
          </Button>
          <Input.Search
            size='small'
            placeholder={e('dbRedisProfilerFilter')}
            allowClear
            style={{ width: 220 }}
            defaultValue={profiler.filter}
            onSearch={v => setProfiler(s => ({ ...s, filter: v }))}
          />
        </Space>
        {profiler.error && <div className='db-redis-profiler-error'>{profiler.error}</div>}
        {/* 统一滚动通道：MONITOR 高频流的定高 / 表头吸顶 / virtual 全由 DbGridTable
            承担（不虚拟化 20s 就 17 万节点，CDP 实机实测）；列宽固定以满足 virtual 前提 */}
        {profiler.running
          ? <DbGridTable
              height={400}
              size='small'
              pagination={false}
              rowKey='id'
              columns={[
                { title: '#', dataIndex: 'id', width: 60, render: v => v + 1 },
                { title: e('dbRedisProfilerFilter'), dataIndex: 'text', width: 560, ellipsis: true }
              ]}
              dataSource={profiler.rows}
            />
          : profiler.rows.length
            ? <DbGridTable
                height={400}
                size='small'
                pagination={false}
                rowKey='id'
                columns={[
                  { title: '#', dataIndex: 'id', width: 60, render: v => v + 1 },
                  { title: e('dbRedisProfilerFilter'), dataIndex: 'text', width: 560, ellipsis: true }
                ]}
                dataSource={profiler.rows}
              />
            : <Empty description={e('dbRedisProfilerEmpty')} />}
      </Modal>
      {/* N5f：Pub/Sub Modal。订阅输入（channels/patterns 逗号分隔）+ 控制 Space +
          消息流 Table + PUBLISH 测试行（走控制台策略通道，不绕过护栏） */}
      <Modal
        open={pubsub.open}
        title={e('dbRedisPubSubTitle')}
        className='db-redis-pubsub-modal'
        onCancel={closePubsubModal}
        footer={null}
        width={880}
        destroyOnClose
      >
        {!pubsub.running
          ? (
            <>
              <div className='db-redis-pubsub-form'>
                <Input
                  size='small'
                  placeholder={e('dbRedisPubSubChannels')}
                  value={pubsub.channels}
                  onChange={ev => setPubsub(s => ({ ...s, channels: ev.target.value }))}
                  className='db-redis-pubsub-input'
                  allowClear
                />
                <Input
                  size='small'
                  placeholder={e('dbRedisPubSubPatterns')}
                  value={pubsub.patterns}
                  onChange={ev => setPubsub(s => ({ ...s, patterns: ev.target.value }))}
                  className='db-redis-pubsub-input'
                  allowClear
                />
              </div>
              <div className='db-redis-pubsub-tip'>{e('dbRedisPubSubTip')}</div>
              <div style={{ marginBottom: 8 }}>
                <Button size='small' type='primary' icon={<ApiOutlined />} onClick={startPubsub} disabled={redisDb < 0}>
                  {e('dbRedisPubSubStart')}
                </Button>
              </div>
            </>
            )
          : (
            <Space style={{ marginBottom: 8 }} wrap>
              <Button size='small' danger icon={<ApiOutlined />} onClick={stopPubsub}>
                {e('dbRedisPubSubStop')}
              </Button>
              <Button size='small' icon={pubsub.paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />} onClick={togglePubsubPause}>
                {pubsub.paused ? e('dbRedisPubSubResume') : e('dbRedisPubSubPause')}
              </Button>
              <Button size='small' icon={<CopyOutlined />} onClick={copyPubsub} disabled={!pubsub.rows.length}>
                {e('dbRedisPubSubCopy')}
              </Button>
              <Button size='small' onClick={clearPubsubRows} disabled={!pubsub.rows.length}>
                {e('dbRedisPubSubClear')}
              </Button>
            </Space>
            )}
        {pubsub.subs && (
          <div className='db-redis-pubsub-subs'>
            {[
              ...(pubsub.subs.channels || []).map(c => ({ label: c, pat: false })),
              ...(pubsub.subs.patterns || []).map(c => ({ label: c, pat: true }))
            ].map(it => (
              <Tag key={(it.pat ? 'p:' : 'c:') + it.label} color={it.pat ? 'purple' : 'blue'}>
                {it.label}
              </Tag>
            ))}
            {(pubsub.subs.errors || []).length > 0 && (
              <span className='db-redis-pubsub-subs-error'>{pubsub.subs.errors.join('; ')}</span>
            )}
          </div>
        )}
        {pubsub.error && <div className='db-redis-pubsub-error'>{pubsub.error}</div>}
        {/* 统一滚动通道：定高/表头吸顶/virtual 全由 DbGridTable 承担（同 Profiler 纪律） */}
        {pubsub.rows.length
          ? <DbGridTable
              height={360}
              size='small'
              pagination={false}
              rowKey='id'
              columns={[
                { title: '#', dataIndex: 'id', width: 60, render: v => v + 1 },
                {
                  title: e('dbRedisPubSubColKind'),
                  dataIndex: 'kind',
                  width: 90,
                  render: v => (
                    <Tag color={v === 'pmessage' ? 'purple' : 'blue'} className='db-redis-pubsub-kind'>
                      {v === 'pmessage' ? e('dbRedisPubSubKindPmsg') : e('dbRedisPubSubKindMsg')}
                    </Tag>
                  )
                },
                { title: e('dbRedisPubSubColChannel'), dataIndex: 'channel', width: 180, ellipsis: true },
                { title: e('dbRedisPubSubColMessage'), dataIndex: 'text', width: 400, ellipsis: true }
              ]}
              dataSource={pubsub.rows}
            />
          : pubsub.running
            ? <Empty description={e('dbRedisPubSubWaiting')} />
            : <Empty description={e('dbRedisPubSubEmpty')} />}
        {/* PUBLISH 测试行：策略通道直达，只读模式下策略层可能拒绝（拒绝原文回显） */}
        <div className='db-redis-pubsub-publish'>
          <Input
            size='small'
            placeholder={e('dbRedisPubSubPubChannel')}
            value={pubsub.pubChannel}
            onChange={ev => setPubsub(s => ({ ...s, pubChannel: ev.target.value }))}
            className='db-redis-pubsub-pub-channel'
            allowClear
          />
          <Input
            size='small'
            placeholder={e('dbRedisPubSubPubMessage')}
            value={pubsub.pubMessage}
            onChange={ev => setPubsub(s => ({ ...s, pubMessage: ev.target.value }))}
            onPressEnter={sendPublish}
            className='db-redis-pubsub-pub-message'
            allowClear
          />
          <Button size='small' icon={<SendOutlined />} onClick={sendPublish} disabled={!pubChannelReady}>
            {e('dbRedisPubSubPublish')}
          </Button>
        </div>
        {pubsub.pubResult && <div className='db-redis-pubsub-pub-result'>{pubsub.pubResult}</div>}
      </Modal>
    </div>
  )
}
