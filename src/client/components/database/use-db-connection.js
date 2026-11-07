// #29 连接生命周期（cluster #29 of 设计-db-session拆分方案-N11b）。
//
// 这一簇是「一次建连动作」这一个职责域：重连、重试、跨库另开 tab。
// 三个出口都由同一个 doConnect 驱动 —— 先释放旧连接（openDbTab 内部也会兜底关闭
// 残留），再重新 openDbTab，最后拉元数据。
//
// 不搬「挂载建连 effect」：它除了建连，还把视角 / 草稿 / 列清单一起复位，需要
// viewRef / viewKeyRef / countKeyRef / viewSaveTimer / setView / setStructureV2 /
// structureV2Ref / setViewMode / setWhereDraft / setViewRejected / setViewTruncated /
// setViewBarSeq 共 12 个参数，与 useDbView 的入参几乎逐项重叠。那是「换 tab 时复位
// 派生状态」，属另一个职责域，硬搬只会造出第二份 useDbView 的形参表。它留在 owner。
//
// 行为零变更：整段逐字搬迁（原 786–824 共 39 行）。
//
// 不回流：doConnect（owner 侧无外部调用点，只在本簇内部被 reconnect / retryConnect 用）。
import clone from '../../common/to-simple-obj'

export function useDbConnection ({
  tabId,
  tab,
  connectDb,
  setConnectDb,
  getSshBookmark,
  hideSystemSchemas,
  setMetadata,
  setConnError,
  setReady,
  setError
}) {
  // 重新建连：先释放旧连接（openDbTab 内部也会兜底关闭残留），再拉元数据
  const doConnect = () => window.pre.runGlobalAsync('closeDbTab', tabId)
    .catch(() => {})
    .then(() => window.pre.runGlobalAsync('openDbTab', clone(tab), clone(getSshBookmark())))
    .then(() => window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', { hideSystemSchemas }))
    .then(data => {
      setMetadata(data || [])
      setConnError('')
      // 初次建连失败后点「重试」成功时，必须把失败卡片放下来：这个 error 是整页的
      // 提前 return 判据（`if (error) return <DbConnError/>`），只有挂载 effect 会清它。
      // 少这一句的表现是「连接已恢复、卡片永远不动」，用户只能关页签重开
      setError('')
      setReady(true)
      return null
    })

  // T4 跨库连接：复用当前连接的主机/端口/账号，目标库另开临时 tab（不写书签）
  const connectOtherDb = () => {
    if (!connectDb) {
      return
    }
    const next = clone(tab)
    delete next.id
    delete next.tabCount
    delete next.status
    delete next.title
    next.dbName = connectDb
    window.store.addTab(next)
    setConnectDb(null)
  }

  // 掉线后重连：失败仍留在界面上（顶部横幅提示），便于继续排查
  const reconnect = () => doConnect()
    .catch(err => {
      setReady(true)
      setConnError(err && err.message ? err.message : String(err))
    })

  // 初次建连失败后的重试：失败则继续停留在失败卡片上（而非进入空界面）
  const retryConnect = () => doConnect()
    .catch(err => {
      setError(err && err.message ? err.message : String(err))
    })

  return { connectOtherDb, reconnect, retryConnect }
}
