// #25 Redis 键浏览（cluster #25 of 设计-db-session拆分方案-N11b）。
//
// 这一簇是「Redis 键空间怎么被浏览与操作」这一个职责域，原先散在 db-session.jsx 的
// 三处（状态 546–615 / 取键详情与写键 2009–2102 / 传给 useDbRedisKeys 的 32 个形参），
// 彼此隔着上千行。本次把 state 与三个写路径 handler 收进一处。
//
// 搬入内容：
//   21 个 state   redisDb / keyList / matchInput / keyJumpInput / redisKeySel / redisDel /
//                 redisView / treeSep / keyTree / treeExpanded / redisInfo / redisSlowlog /
//                 redisKey / redisDetail / redisCell / detailLoading / ttlInput
//   4 个令牌 ref  keyJumpTokenRef / keyTreeTokenRef / redisInfoTokenRef / redisSlowlogTokenRef
//   3 个 handler  selectRedisKey（取键详情，支持 cursor/append 服务端分页）
//                 applyTtl（EXPIRE，写闸门 level=write）
//                 delSelectedKey（DEL，写闸门 level=dangerous）
//
// 为什么 state 必须回流（与 #22/#23 的「最小化返回值」不同）：这批 state 的消费者不在
// 本 hook 内 —— useDbRedisKeys 收 32 个、useDbRedisWrite 收 17 个、渲染层另有大量读取。
// 本簇的收益不在行数，而在「Redis 的三层（state / 逻辑 / 渲染）第一次分开」。
//
// TDZ：applyTtl / delSelectedKey 要用 loadRedisKeys（owner 第 745 行左右的 useDbRedisKeys
// 返回）与 loadTree（treeApi，第 695 行），两者都在本 hook 调用点之后 —— 一律由 owner
// 传惰性箭头进来，只在事件处理期求值，与搬迁前的处境一致。
//
// 行为零变更：三段逐字搬迁（546–588 / 603–615 / 2009–2102，共 43 + 13 + 94 = 150 行）。
import { useRef, useState } from 'react'
import message from '../common/message'
import { showErrorModal } from '../common/error-modal'
import { DEFAULT_SEPARATOR } from '../../common/db-key-tree'
import { REDIS_DETAIL_PAGE } from '../../common/db-session-const'

const e = window.translate

export function useDbRedisBrowse ({
  tabId,
  confirmRedisWrite,
  loadRedisKeys,
  loadTree
}) {
  // Redis 键空间状态（db 节点 → SCAN 键列表 → 类型化键详情）
  const [redisDb, setRedisDb] = useState(-1)
  // SCAN 用「游标」分页：cursor 为当前页游标，nextCursor 用于推进；
  // stack 记录已访问的游标，用于回退上一页（长度即当前页序号）。
  const [keyList, setKeyList] = useState({
    loading: false,
    rows: [],
    cursor: '0',
    nextCursor: '0',
    hasMore: false,
    match: '*',
    stack: []
  })
  const [matchInput, setMatchInput] = useState('')
  // R1：键列表跳页输入（页码，1 基）与过期请求令牌
  const [keyJumpInput, setKeyJumpInput] = useState('')
  const keyJumpTokenRef = useRef(0)
  // H7b-3：键列表多选存**键名**而不是行下标 —— 翻页/改过滤后下标全指向别的键
  const [redisKeySel, setRedisKeySel] = useState([])
  // 批量删键弹层：keys 是"点开时冻结的那批"，done 只由 unlink 的实际删除数累加
  const [redisDel, setRedisDel] = useState({ open: false, keys: [], running: false, done: 0, error: '' })
  // H7a：键树视图。列表走游标分页（一页一次 IPC），树必须看到全部键名，
  // 所以是"渲染侧驱动的多轮 SCAN"（keysOnly 只要名字，不发 TYPE/TTL）。
  // scanned 是进度（已收唯一键数），truncated 表示撞到 REDIS_TREE_MAX_KEYS 就停手。
  const [redisView, setRedisView] = useState('list')
  const [treeSep, setTreeSep] = useState(DEFAULT_SEPARATOR)
  const [keyTree, setKeyTree] = useState({
    loading: false,
    scanned: 0,
    total: 0,
    truncated: false,
    names: [],
    match: '*'
  })
  const [treeExpanded, setTreeExpanded] = useState([])
  // 同一把令牌管"取消 + 丢弃在途响应"：主进程没有 SCAN 中断通道（dbClientOp 只有
  // 单次超时），能做的就是在渲染侧不再采纳这一轮之后的结果
  const keyTreeTokenRef = useRef(0)
  // H7a-4：服务器信息（INFO）。只在打开弹层时拉一次 + 手动刷新按钮再拉，不做轮询：
  // INFO 要遍历实例统计，常驻轮询等于给每台连着的 Redis 挂了个定时任务，
  // 而这份数据没人盯着看。令牌管"连点刷新时旧响应不覆盖新响应"。
  const [redisInfo, setRedisInfo] = useState({ open: false, loading: false, text: '', error: '' })
  const redisInfoTokenRef = useRef(0)

  // H7b-2：慢日志与 INFO 同层弹层、不同命令，状态也分开：
  // INFO 失败不该让慢日志看起来失败，反之亦然。entries=null 是"从没拉过"，[] 是"拉过、空的"
  const [redisSlowlog, setRedisSlowlog] = useState({ loading: false, error: '', entries: null })
  const redisSlowlogTokenRef = useRef(0)
  const [redisKey, setRedisKey] = useState('')
  const [redisDetail, setRedisDetail] = useState(null)
  // Redis 详情四张表（hash/list/set/zset）"选中的那一格"：{ col, label, rowKey, rowNo }。
  // 悬停预览卡下线后，这里只剩双击进写路径这一条看全文的路（只读连接连这条都没有），
  // 所以按数据页/SQL 结果的同一交互补上：单击数据格 → 详情区下面展开只读值面板。
  // rowNo 单独存：zset 的 rowKey 是扁平数组下标（0/2/4），拿它 +1 报行号会错
  const [redisCell, setRedisCell] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [ttlInput, setTtlInput] = useState(undefined)

  // cursor/append 供 hash/set 服务端分页：append 时把新一页合并进已加载详情，
  // 不再把整个键一次性搬进内存
  const selectRedisKey = (key, cursor = '0', append = false) => {
    if (!append) {
      setRedisKey(key)
      // 换键 = 换一份详情，上一键那一格的选中必须清掉：面板标题写的是旧键的
      // 「列名 · 第 N 行」，行号在新键里指的是另一行数据
      setRedisCell(null)
    }
    setDetailLoading(true)
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getKeyDetail', {
      dbIndex: redisDb,
      key,
      cursor: String(cursor || '0'),
      pageSize: REDIS_DETAIL_PAGE
    }).then(res => {
      const next = res || null
      setRedisDetail(prev => {
        if (!append || !prev || !next) {
          return next
        }
        return {
          ...next,
          fields: [...(prev.fields || []), ...(next.fields || [])],
          rows: next.type === 'hash'
            ? { ...(prev.rows || {}), ...(next.rows || {}) }
            : [...(prev.rows || []), ...(next.rows || [])]
        }
      })
      if (!append) {
        setTtlInput(res && res.ttl > 0 ? res.ttl : undefined)
      }
      setDetailLoading(false)
    }).catch(err => {
      if (!append) {
        setRedisDetail(null)
      }
      setDetailLoading(false)
      showErrorModal({ error: err })
    })
  }

  const applyTtl = async () => {
    if (!redisKey) {
      return
    }
    const seconds = Number(ttlInput) || 0
    const ok = await confirmRedisWrite({
      level: 'write',
      text: 'EXPIRE ' + redisKey + ' ' + seconds,
      note: e('dbTtlUpdated')
    })
    if (!ok) {
      return
    }
    window.pre.runGlobalAsync('dbClientOp', tabId, 'expireKey', {
      dbIndex: redisDb,
      key: redisKey,
      seconds
    }).then(() => {
      message.success(e('dbTtlUpdated'))
      loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
      selectRedisKey(redisKey)
    }).catch(err => {
      showErrorModal({ error: err })
    })
  }

  const delSelectedKey = async () => {
    if (!redisKey) {
      return
    }
    const ok = await confirmRedisWrite({
      level: 'dangerous',
      text: 'DEL ' + redisKey,
      note: e('dbDeleted')
    })
    if (!ok) {
      return
    }
    window.pre.runGlobalAsync('dbClientOp', tabId, 'delKey', {
      dbIndex: redisDb,
      key: redisKey
    }).then(() => {
      message.success(e('dbDeleted'))
      setRedisKey('')
      setRedisDetail(null)
      loadRedisKeys(redisDb, '0', keyList.match)
      // 键数变了 → 同步刷新左侧各 db 的键个数
      loadTree()
    }).catch(err => {
      showErrorModal({ error: err })
    })
  }
  return {
    redisDb,
    setRedisDb,
    keyList,
    setKeyList,
    matchInput,
    setMatchInput,
    keyJumpInput,
    setKeyJumpInput,
    keyJumpTokenRef,
    redisKeySel,
    setRedisKeySel,
    redisDel,
    setRedisDel,
    redisView,
    setRedisView,
    treeSep,
    setTreeSep,
    keyTree,
    setKeyTree,
    treeExpanded,
    setTreeExpanded,
    keyTreeTokenRef,
    redisInfo,
    setRedisInfo,
    redisInfoTokenRef,
    redisSlowlog,
    setRedisSlowlog,
    redisSlowlogTokenRef,
    redisKey,
    setRedisKey,
    redisDetail,
    setRedisDetail,
    redisCell,
    setRedisCell,
    detailLoading,
    setDetailLoading,
    ttlInput,
    setTtlInput,
    selectRedisKey,
    applyTtl,
    delSelectedKey
  }
}
