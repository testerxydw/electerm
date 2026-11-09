// N5a · Redis 命令控制台的编排（整库/整实例级弹层，与 ER 图、结构对比同一族）。
//
// 句柄归属（AGENTS.md §5.2.4）：本 hook 只拥有控制台自己的状态（草稿、历史、命令表），
// 边界量的来源一律注入：
//   tabId             —— owner 的页签句柄，op 走它
//   getRedisDb        —— 当前 db index。用惰性 getter 而不是取值快照："打在哪个库"
//                        要在**执行那一刻**才确定（弹层开着时用户仍可能切库）
//   isReadonly        —— 顶栏那个开关的当前值（主进程还会按权威位再拦一道）
//   isProduction      —— 生产标记（确认闸门只在生产上生效）
//   confirmRedisWrite —— useDbGuard 的 Redis 确认闸门（§5.2.6：新写路径复用护栏）
//
// 四条不做的边界，写在这里是因为它们看起来"顺手就该做"：
//
// 1) **不猜命令名**。整行原文交给主进程，由 `redis-command-policy` 分词判定。
//    这里的 `consoleRisk` 只决定要不要弹确认，不参与任何放行。
// 2) **历史不持久化**。SQL 历史有主进程文件（localStorage 因 UI server 端口漂移
//    会跨启动隔离，见 db-sql-history.js 头注释），控制台不值得为它另开一条存储通道；
//    关掉页签即作废，重开是干净的历史。
// 3) **不自动刷新键列表**。控制台的写命令可以改任何键，把整个键空间重拉一遍
//    不是用户按回车时期待的事；历史条目上给"可能已改动数据"的标记，刷新仍是手动。
// 4) **不在 state 更新函数里发 IPC**。React StrictMode 下 updater 会被调用两次，
//    把 runGlobalAsync 写进去等于一条命令发两次 —— 读命令只是浪费一次往返，
//    写命令是把同一件事做两遍。因此"要在回调里读的当前值"（命令表）另有镜像 ref。
import { useCallback, useRef, useState } from 'react'
import { consoleRisk } from '../../common/db-redis-console'
import { cleanDbError } from './db-conn-error'

const e = window.translate

/** 历史上限：再多就不是"回头看两条"而是"翻记录"了，那属于另一件事 */
const HISTORY_MAX = 50

export function useDbRedisConsole ({
  tabId,
  getRedisDb,
  isReadonly,
  isProduction,
  confirmRedisWrite
}) {
  const [redisConsole, setRedisConsole] = useState({
    open: false,
    draft: '',
    history: [],
    entries: [],
    source: '',
    listLoading: false,
    listError: ''
  })
  // updater 必须是纯的（见头注释第 4 条），所以要读当前命令表的地方另有镜像 ref
  const entriesRef = useRef([])
  // 命令表只有一条在途才有意义：连点刷新时旧响应不该覆盖新响应。
  // 历史是逐条各自结算的（每条有 id），不用令牌
  const listTokenRef = useRef(0)
  const idRef = useRef(0)

  const loadRedisConsoleCommands = useCallback(force => {
    if (!force && entriesRef.current.length) {
      return
    }
    listTokenRef.current++
    const token = listTokenRef.current
    setRedisConsole(s => ({ ...s, listLoading: true, listError: '' }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'listRedisCommands', {
      dbIndex: getRedisDb(),
      // 用户点「重新取命令表」时要绕过主进程那份 60 秒属性缓存，否则按钮是空的
      force: force === true
    }).then(res => {
      if (token !== listTokenRef.current) {
        return
      }
      const entries = (res && res.entries) || []
      entriesRef.current = entries
      setRedisConsole(s => ({
        ...s,
        entries,
        source: (res && res.source) || '',
        listLoading: false,
        listError: ''
      }))
    }).catch(err => {
      if (token !== listTokenRef.current) {
        return
      }
      // 拿不到命令表只影响补全，不影响执行：控制台必须还能手敲
      setRedisConsole(s => ({
        ...s,
        listLoading: false,
        listError: cleanDbError(err && err.message ? err.message : err)
      }))
    })
  }, [tabId, getRedisDb])

  const openRedisConsole = useCallback(() => {
    setRedisConsole(s => ({ ...s, open: true }))
    loadRedisConsoleCommands()
  }, [loadRedisConsoleCommands])

  const closeRedisConsole = useCallback(() => {
    // 关闭只作废在途的命令表请求；历史与草稿留着 ——
    // 控制台的历史是"这一页我干了什么"，关掉再打开就没了反而更容易重复执行
    listTokenRef.current++
    setRedisConsole(s => ({ ...s, open: false, listLoading: false }))
  }, [])

  const setRedisConsoleDraft = useCallback(v => {
    const text = String(v === undefined || v === null ? '' : v)
    setRedisConsole(s => ({ ...s, draft: text }))
  }, [])

  const clearRedisConsoleHistory = useCallback(() => {
    setRedisConsole(s => ({ ...s, history: [] }))
  }, [])

  // 真正发出去。dbIndex 在执行那一刻取（打开弹层后用户可能又切了库）
  const send = useCallback((line, dbIndex) => {
    idRef.current++
    const id = idRef.current
    const entry = { id, line, at: Date.now(), pending: true, res: null, ipcError: '' }
    setRedisConsole(s => ({
      ...s,
      draft: '',
      history: [entry, ...s.history].slice(0, HISTORY_MAX)
    }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'runRedisCommand', {
      line,
      dbIndex
    }).then(res => {
      setRedisConsole(s => ({
        ...s,
        history: s.history.map(h => (h.id === id ? { ...h, pending: false, res: res || null } : h))
      }))
    }).catch(err => {
      // 连接/超时类失败也落进历史（不是 toast 一闪而过）：控制台的历史记的是
      // "这个实例上我做过哪些尝试"，失败的那次同样是做过
      const msg = cleanDbError(err && err.message ? err.message : err)
      setRedisConsole(s => ({
        ...s,
        history: s.history.map(h => (h.id === id
          ? { ...h, pending: false, res: null, ipcError: msg }
          : h))
      }))
    })
  }, [tabId])

  const runRedisConsole = useCallback(line => {
    const text = String(line === undefined || line === null ? '' : line)
    if (!text.trim()) {
      return
    }
    const dbIndex = getRedisDb()
    const risk = consoleRisk({
      line: text,
      entries: entriesRef.current,
      readOnly: isReadonly,
      isProduction
    })
    if (!risk) {
      send(text, dbIndex)
      return
    }
    // 确认闸门在执行之前：取消 = 一个 op 都不发，历史里也不留痕
    // （用户没同意的操作不该出现在"我干了什么"里）
    Promise.resolve(confirmRedisWrite({
      level: risk,
      text,
      note: e('dbRedisConsoleRiskNote')
    })).then(ok => {
      if (ok) {
        send(text, dbIndex)
      }
    })
  }, [getRedisDb, isReadonly, isProduction, confirmRedisWrite, send])

  return {
    redisConsole,
    openRedisConsole,
    closeRedisConsole,
    setRedisConsoleDraft,
    loadRedisConsoleCommands,
    clearRedisConsoleHistory,
    runRedisConsole
  }
}
