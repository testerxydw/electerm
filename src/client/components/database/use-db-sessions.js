// N6：会话与状态查看（只读，最小版）。对标文档 N6 的边界：
//   只展示（MySQL information_schema.PROCESSLIST / PG pg_stat_activity），
//   绝不 kill（kill 属于 §10 永不做的分叉点，前端也不留任何入口）；
//   自动刷新默认关，开关交给用户（"刷新可关"是验收项）。
// 取数 = listSessions + getServerStatus 两个只读 op，令牌管"连点刷新旧响应不覆盖"。
import { useCallback, useEffect, useRef, useState } from 'react'
import { cleanDbError } from './db-conn-error'

// 自动刷新间隔（秒）。默认关；打开后固定节拍轮询，不做指数退避（会话页是低频查看场景）
const AUTO_REFRESH_SECONDS = 10

export const AUTO_REFRESH_MS = AUTO_REFRESH_SECONDS * 1000

export function useDbSessions ({ tabId }) {
  const [state, setState] = useState({
    loading: false,
    rows: [],
    status: null,
    error: '',
    loadedAt: 0
  })
  // 自动刷新开合（默认关）与轮询句柄
  const [auto, setAuto] = useState(false)
  const timerRef = useRef(null)
  // "连点刷新时旧响应不覆盖新响应"的令牌
  const tokenRef = useRef(0)

  const load = useCallback(() => {
    tokenRef.current++
    const token = tokenRef.current
    setState(s => ({ ...s, loading: true, error: '' }))
    Promise.all([
      window.pre.runGlobalAsync('dbClientOp', tabId, 'listSessions', {}),
      window.pre.runGlobalAsync('dbClientOp', tabId, 'getServerStatus', {})
    ]).then(([sess, st]) => {
      if (token !== tokenRef.current) {
        return
      }
      setState({
        loading: false,
        rows: (sess && sess.rows) || [],
        status: st || null,
        error: '',
        loadedAt: Date.now()
      })
    }).catch(err => {
      if (token !== tokenRef.current) {
        return
      }
      // 失败保留上一轮数据：刷新失败不该把还能看的会话表一起收走
      setState(s => ({
        ...s,
        loading: false,
        error: cleanDbError(err && err.message ? err.message : err)
      }))
    })
  }, [tabId])

  // 挂载拉一次（只读查询，页签 forceRender 所以打开连接页就有一次基线数据）
  useEffect(() => {
    load()
    return () => {
      tokenRef.current++
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [load])

  // 自动刷新开关：默认关；打开才起 interval，关闭/卸载即清
  useEffect(() => {
    if (!auto) {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      return undefined
    }
    timerRef.current = setInterval(load, AUTO_REFRESH_MS)
    return () => {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [auto, load])

  return {
    sessions: state,
    auto,
    setAuto,
    load
  }
}
