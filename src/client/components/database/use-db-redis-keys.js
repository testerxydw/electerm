/**
 * Redis 键空间（列表 SCAN 分页 / 键树抓取 / 视图切换 / 过滤 / 刷新 / INFO 弹层 /
 * H7b-3 批量删键：预览 → 确认（生产再过 E1）→ 分批 UNLINK → 进度）
 *
 * 从 db-session.jsx 的「// ---- Redis 键空间 ----」段 + H7b-3 批量删键块原样搬出
 * （设计 doc/设计-db-session拆分方案-N11a-2026-11-06.md §6.2 聚类 #11，行为零变更）。
 *
 * 边界（AGENTS.md §5.2.4 句柄归属）：页面级 ref / 状态由会话页（DbSession）持有并注入，
 * 这里不自建、不回流。下列每一项都是 owner 注入的依赖：
 *   - 状态值 + setter：keyList / redisView / treeSep / keyTree / treeExpanded /
 *     redisInfo / redisDel / redisDb / redisKeySel / matchInput / keyJumpInput /
 *     redisKey 等（owner = DbSession 的 useState / useRef）
 *   - 令牌 ref：keyJumpTokenRef / keyTreeTokenRef / redisInfoTokenRef /
 *     redisSlowlogTokenRef（owner = DbSession 的 useRef，这里只 ++ 与读取）
 *   - 回调：onOpError / loadTree / confirmRedisWrite / selectRedisKey
 *     以及 set* 系列（setKeyList / setRedisKeySel / setRedisView / setKeyTree /
 *     setTreeExpanded / setRedisInfo / setRedisDel / setKeyJumpInput / setRedisKey / setRedisDetail …）
 *
 * 纯逻辑（无 React、无状态）走 common/db-* 复用，不在此处复制：
 *   buildRedisKeyTree / collectFolderKeys / ancestorKeys（db-key-tree）
 *   buildKeyPathIndex / getDbPageSize / REDIS_* 常量（db-session-const）
 *   chunkRedisKeys / delPreview / delCommandText（db-redis-del）
 *   cleanDbError（db-conn-error）
 */
import { useEffect, useMemo } from 'react'
import { Modal } from 'antd'
import message from '../common/message'
import { cleanDbError } from './db-conn-error'
import {
  buildRedisKeyTree,
  collectFolderKeys,
  ancestorKeys
} from '../../common/db-key-tree'
import {
  getDbPageSize,
  buildKeyPathIndex,
  REDIS_KEY_JUMP_WARN_PAGES,
  REDIS_TREE_MAX_KEYS,
  REDIS_TREE_SCAN_COUNT,
  REDIS_TREE_AUTO_EXPAND_KEYS
} from '../../common/db-session-const'
import { chunkRedisKeys, delPreview, delCommandText } from '../../common/db-redis-del'

const e = window.translate

export function useDbRedisKeys ({
  tabId,
  redisDb,
  keyList,
  setKeyList,
  matchInput,
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
  keyTree,
  setKeyTree,
  treeExpanded,
  setTreeExpanded,
  keyTreeTokenRef,
  redisInfo,
  setRedisInfo,
  redisInfoTokenRef,
  redisSlowlogTokenRef,
  setRedisSlowlog,
  redisKey,
  setRedisKey,
  setRedisDetail,
  onOpError,
  loadTree,
  confirmRedisWrite,
  selectRedisKey
}) {
  const loadRedisKeys = (dbIndex, cursor, match, stack = []) => {
    // 顺序翻页/过滤/刷新都会作废在途的跳页请求，避免旧跳页结果覆盖新页
    keyJumpTokenRef.current++
    setKeyList(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
      dbIndex,
      cursor: String(cursor || '0'),
      pageSize: getDbPageSize(),
      match: match || '*'
    }).then(res => {
      setKeyList({
        loading: false,
        rows: (res && res.rows) || [],
        cursor: String(cursor || '0'),
        nextCursor: (res && res.nextCursor) || '0',
        hasMore: !!(res && res.hasMore),
        match: match || '*',
        stack
      })
    }).catch(err => {
      setKeyList(s => ({ ...s, loading: false, rows: [] }))
      // 与 loadPage 一致：断线要置顶提示（带重连），而不是只弹个 toast
      onOpError(err)
    })
  }

  // H7b-3：换库/换过滤就清空勾选 —— 勾选是键名集合，跨库没有意义；
  // 同一过滤条件内跨页保留（否则一页最多 200 个键，"分批 500"永远只有一批）
  useEffect(() => {
    setRedisKeySel([])
  }, [redisDb, keyList.match])

  // R1：键列表跳到第 N 页（1 基）。SCAN 游标不透明，后端从 cursor=0 前向步进
  // target 次并回传沿途每页起始游标；用这条游标链重建 prev 栈，
  // 之后 prev/next 仍是顺序推进（不重复扫描）。目标页超出遍历范围时停在末页后。
  const jumpRedisKeysPage = (pageNo) => {
    const n = Math.floor(Number(pageNo))
    if (!Number.isInteger(n) || n < 1) {
      setKeyJumpInput('')
      return
    }
    const target = n - 1
    setKeyJumpInput('')
    const doJump = () => {
      const match = keyList.match || '*'
      keyJumpTokenRef.current++
      const token = keyJumpTokenRef.current
      setKeyList(s => ({ ...s, loading: true }))
      window.pre.runGlobalAsync('dbClientOp', tabId, 'scanKeysToPage', {
        dbIndex: redisDb,
        pageIndex: target,
        pageSize: getDbPageSize(),
        match
      }).then(res => {
        if (token !== keyJumpTokenRef.current) {
          return
        }
        const cursors = (res && res.cursors) || ['0']
        setKeyList({
          loading: false,
          rows: (res && res.rows) || [],
          cursor: cursors[cursors.length - 1] || '0',
          nextCursor: (res && res.nextCursor) || '0',
          hasMore: !!(res && res.hasMore),
          match,
          stack: cursors.slice(0, -1)
        })
      }).catch(err => {
        if (token !== keyJumpTokenRef.current) {
          return
        }
        setKeyList(s => ({ ...s, loading: false }))
        onOpError(err)
      })
    }
    if (target > REDIS_KEY_JUMP_WARN_PAGES) {
      Modal.confirm({
        title: e('dbKeyJumpWarnTitle'),
        content: e('dbKeyJumpWarn').replace('{n}', String(n)),
        okText: e('dbGo'),
        cancelText: e('cancel'),
        onOk: doJump
      })
      return
    }
    doJump()
  }

  // H7a：键树抓取。列表是"一页一次 IPC 的游标分页"，树必须看到全部键名才能分层，
  // 所以这里是渲染侧驱动的多轮 SCAN（keysOnly：只要名字，一键盘不发 TYPE/TTL）。
  // - 每轮 COUNT 1000，收完一段就更新 scanned —— 进度是真进度，不是转圈动画
  // - 撞 REDIS_TREE_MAX_KEYS 立即停手并标 truncated：不设上限时 500 万键的实例
  //   会把渲染进程整死，"截断但可用"好过"完整但卡住"
  // - 取消 = 令牌 +1：主进程没有 SCAN 中断通道（dbClientOp 只有单次超时），
  //   能做的是不再采纳这一轮之后的任何响应，最后一发请求自然跑完即弃
  const loadRedisKeyTree = (dbIndex, match = '*', sep = treeSep) => {
    keyTreeTokenRef.current++
    const token = keyTreeTokenRef.current
    const pattern = match || '*'
    setKeyTree(s => ({
      ...s, loading: true, scanned: 0, total: 0, truncated: false, match: pattern
    }))
    const names = []
    const seen = new Set()
    let cursor = '0'
    let truncated = false
    const finish = () => {
      setKeyTree({
        loading: false,
        scanned: names.length,
        total: names.length,
        truncated,
        names,
        match: pattern
      })
    }
    const step = () => {
      if (token !== keyTreeTokenRef.current) {
        return
      }
      window.pre.runGlobalAsync('dbClientOp', tabId, 'getPageData', {
        dbIndex,
        cursor,
        pageSize: REDIS_TREE_SCAN_COUNT,
        match: pattern,
        keysOnly: true
      }).then(res => {
        if (token !== keyTreeTokenRef.current) {
          return
        }
        for (const r of (res && res.rows) || []) {
          const name = r && r.name
          // SCAN 只保证"至少一次"，重复键在这里先去重再计数，scanned 才是真实进度
          if (!name || seen.has(name)) {
            continue
          }
          seen.add(name)
          names.push(name)
        }
        cursor = String((res && res.nextCursor) || '0')
        setKeyTree(s => ({ ...s, scanned: names.length }))
        if (cursor === '0') {
          return finish()
        }
        if (names.length >= REDIS_TREE_MAX_KEYS) {
          truncated = true
          return finish()
        }
        step()
      }).catch(err => {
        if (token !== keyTreeTokenRef.current) {
          return
        }
        setKeyTree(s => ({ ...s, loading: false }))
        onOpError(err)
      })
    }
    step()
  }

  const cancelKeyTree = () => {
    keyTreeTokenRef.current++
    setKeyTree(s => ({ ...s, loading: false }))
  }

  // 换 db / 关 tab 都要作废在途抓取：否则旧 db 的键会混进新 db 的树里
  const resetKeyTree = () => {
    keyTreeTokenRef.current++
    setKeyTree({
      loading: false,
      scanned: 0,
      total: 0,
      truncated: false,
      names: [],
      match: '*'
    })
  }

  // 树只在"抓取结束时"重算，改分隔符不该重扫一遍上万键
  const keyTreeBuilt = useMemo(
    () => buildRedisKeyTree(keyTree.names, { separator: treeSep }),
    [keyTree.names, treeSep]
  )
  const keyPathIndex = useMemo(() => buildKeyPathIndex(keyTreeBuilt.nodes), [keyTreeBuilt])

  // 进树视图 / 换分隔符 / 新一次抓取结束 → 重算展开集。
  // 小键库默认把第一层目录摊开（省事）；大键库一个都不自动摊（见 REDIS_TREE_AUTO_EXPAND_KEYS）。
  // 选中键那一支是例外：不展开就看不见被选中的那一行。
  // 不跟 redisKey 走：用户在树里自己折叠过的，不该因为选了个键又被程序撑开。
  useEffect(() => {
    if (redisView !== 'tree') {
      return
    }
    const auto = keyTreeBuilt.total <= REDIS_TREE_AUTO_EXPAND_KEYS
      ? collectFolderKeys(keyTreeBuilt.nodes, 1)
      : []
    const exp = new Set(auto)
    const path = redisKey ? keyPathIndex.get(redisKey) : null
    if (path) {
      for (const a of ancestorKeys(path, treeSep)) {
        exp.add(a)
      }
    }
    setTreeExpanded([...exp])
  }, [redisView, keyTreeBuilt])

  const switchRedisView = (v) => {
    setRedisView(v)
    if (v !== 'tree') {
      return
    }
    // 已有结果且过滤条件没变 → 直接复用：来回切视图不该每次都把上万键重扫一遍
    const pattern = keyList.match || matchInput || '*'
    if (!keyTree.loading && (keyTree.match !== pattern || !keyTree.names.length)) {
      loadRedisKeyTree(redisDb, pattern)
    }
  }

  // 过滤条件两种视图共用（match 输入框只有一个）：在列表里改了过滤再切到树，
  // 树必须按新条件重扫，否则输入框写着 user:*、树里装的还是全库键名。
  // 树视图下按「过滤」同样要刷列表 —— 让两个视图的 match 始终一致，
  // 视图来回切才谈得上"复用已抓的键名"。
  const applyRedisFilter = () => {
    loadRedisKeys(redisDb, '0', matchInput)
    if (redisView === 'tree') {
      loadRedisKeyTree(redisDb, matchInput)
    }
  }

  const refreshRedisView = () => {
    if (redisView === 'tree') {
      loadRedisKeyTree(redisDb, keyTree.match || matchInput)
    } else {
      loadRedisKeys(redisDb, keyList.cursor || '0', keyList.match, keyList.stack)
    }
  }

  // H7a-4：INFO 全量原文 → 弹层。op 不 select db（实例级信息），所以换库不需要重拉，
  // 但"打开时拉一次"仍然保留：概览里最关键的是内存/客户端/命中率，都随写入在变。
  const loadRedisInfo = () => {
    redisInfoTokenRef.current++
    const token = redisInfoTokenRef.current
    setRedisInfo(s => ({ ...s, loading: true }))
    window.pre.runGlobalAsync('dbClientOp', tabId, 'getRedisInfo', {}).then(res => {
      if (token !== redisInfoTokenRef.current) {
        return
      }
      // 只写数据、不动 open：弹层可能在请求回来之前就关了，响应不该把它重新打开
      setRedisInfo(s => ({
        ...s,
        loading: false,
        text: String(res || ''),
        error: ''
      }))
    }).catch(err => {
      if (token !== redisInfoTokenRef.current) {
        return
      }
      // 错误留在弹层内而不是走 onOpError：这里丢的只是"这一次查看"，
      // 键列表照常可用；置顶横幅会让人以为整条连接断了。
      // text 清空：留着上一份 INFO 会和"失败"并排显示，用户不知道看哪份。
      setRedisInfo(s => ({
        ...s,
        loading: false,
        text: '',
        error: cleanDbError(err && err.message ? err.message : err)
      }))
    })
  }

  const openRedisInfo = () => {
    setRedisInfo(s => ({ ...s, open: true }))
    loadRedisInfo()
  }

  const closeRedisInfo = () => {
    // 关闭即作废在途请求：否则关掉再打开会先看到上一次请求的结果闪一下
    redisInfoTokenRef.current++
    redisSlowlogTokenRef.current++
    setRedisInfo({ open: false, loading: false, text: '', error: '' })
    // 慢日志一起清回"从没拉过"：重开时切进该页签会重新拉，
    // 留着上一次的条目会让人以为看到的是当前这段慢日志
    setRedisSlowlog({ loading: false, error: '', entries: null })
  }

  const redisTreeNodes = useMemo(() => {
    const map = (list) => (list || []).map(n => ({
      key: n.key,
      title: n.title,
      keyName: n.keyName,
      count: n.count,
      // 纯目录不可选：点了没键可加载，只该展开/收起
      selectable: !!n.keyName,
      children: n.children ? map(n.children) : undefined
    }))
    return map(keyTreeBuilt.nodes)
  }, [keyTreeBuilt])

  const onRedisTreeSelect = (keys, info) => {
    const node = info && info.node
    // 目录节点 selectable=false 走不到这里，但 antd 的取消选中回调也会进这里
    if (!node || !node.keyName) {
      return
    }
    selectRedisKey(node.keyName)
  }

  const redisTreeStatus = keyTree.loading
    ? e('dbKeyTreeScanning').replace('{n}', keyTree.scanned)
    : e('dbKeysTotal').replace('{n}', keyTree.total)

  const redisTreeSelected = redisKey && keyPathIndex.has(redisKey)
    ? [keyPathIndex.get(redisKey)]
    : []

  // 弹层里的键名预览（前 20 个 + 还有多少）
  const redisDelPreview = useMemo(() => delPreview(redisDel.keys), [redisDel.keys])

  // ---- H7b-3 批量删键：预览 → 确认（生产再过 E1）→ 分批 UNLINK → 进度 ----

  // 弹层打开时冻结这批键名：随后后台刷新/翻页改了勾选，也不该让"确认时看到的"
  // 和"实际删掉的"对不上
  const openRedisDel = () => {
    const keys = redisKeySel.slice()
    if (!keys.length) {
      return
    }
    setRedisDel({ open: true, keys, running: false, done: 0, error: '' })
  }

  const closeRedisDel = () => {
    if (redisDel.running) {
      return
    }
    setRedisDel({ open: false, keys: [], running: false, done: 0, error: '' })
  }

  const runRedisDel = async () => {
    const targets = redisDel.keys
    // E1：生产连接多一道风险确认（非生产只有这个预览弹层本身）。
    // 命令文本只列前 10 个键 —— 500 个键名铺满一屏，谁都会直接点"仍要执行"
    const ok = await confirmRedisWrite({
      level: 'dangerous',
      text: delCommandText(targets),
      note: e('dbRedisDelKeysBody')
    })
    if (!ok) {
      return
    }
    setRedisDel(d => ({ ...d, running: true, done: 0, error: '' }))
    let done = 0
    for (const chunk of chunkRedisKeys(targets)) {
      try {
        const n = await window.pre.runGlobalAsync('dbClientOp', tabId, 'delKeys', {
          dbIndex: redisDb,
          keys: chunk
        })
        done += Number(n) || 0
        setRedisDel(d => ({ ...d, done }))
      } catch (err) {
        // 前面几批已经删了、回滚不了：停在弹层里让人看到"删到哪儿"
        setRedisDel(d => ({
          ...d,
          running: false,
          done,
          error: cleanDbError(err && err.message ? err.message : err)
        }))
        return
      }
    }
    setRedisDel({ open: false, keys: [], running: false, done: 0, error: '' })
    setRedisKeySel([])
    // 删掉的正好是详情里选中的那个键 → 详情一起清掉，不留一个已不存在的键
    if (targets.includes(redisKey)) {
      setRedisKey('')
      setRedisDetail(null)
    }
    message.success(e('dbRedisDelKeysDone').replace('{n}', String(done)))
    // 原页重拉（不是回第一页）：删的是本页的键，用户还该站在这一页
    loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
    // 键数变了 → 同步左侧各 db 的键个数
    loadTree()
  }

  return {
    loadRedisKeys,
    jumpRedisKeysPage,
    loadRedisKeyTree,
    cancelKeyTree,
    resetKeyTree,
    keyTreeBuilt,
    keyPathIndex,
    switchRedisView,
    applyRedisFilter,
    refreshRedisView,
    loadRedisInfo,
    openRedisInfo,
    closeRedisInfo,
    redisTreeNodes,
    onRedisTreeSelect,
    redisTreeStatus,
    redisTreeSelected,
    redisDelPreview,
    openRedisDel,
    closeRedisDel,
    runRedisDel
  }
}
