// #9 SQL 查询收藏（B 批 B-1~B-6，cluster #9 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：收藏数据层（states/derived/refresh）+ CRUD + 分组(B-5) + 一键收藏(B-6) +
// 导出/导入(B-4) 逐字迁入本 hook。AI 登记 / AI 生成弹层 / AI 联动(B-7) / SQL 模板(B-3，含 JSX)
// 属 AI/模板职责、非收藏数据管理，按 SRP 留 owner（AGENTS §5.1）。
// 页面级注入：sqlText / tab / insertToEditor / openSqlHistory。
import { useMemo, useState } from 'react'
import message from '../common/message'
import {
  listFavorites,
  saveFavorite,
  removeFavorite,
  exportFavorites,
  importFavorites,
  listGroups,
  createFavoriteGroup,
  renameFavoriteGroup,
  deleteFavoriteGroup,
  normSql
} from '../../common/db-sql-favorite'
import { filterFavorites } from '../../common/db-sql-history-panel'

const e = window.translate

export function useDbSqlFavorite ({ sqlText, tab, insertToEditor, openSqlHistory }) {
  // 弹层当前 tab：'history' | 'favorite'
  const [favTab, setFavTab] = useState('history')
  const [favList, setFavList] = useState([])
  const [favFilter, setFavFilter] = useState('')
  // 编辑弹窗：null 关闭；{ id?, title, sql, group }——id 缺省即新建（主进程生成 id）
  const [favEdit, setFavEdit] = useState(null)
  const [favSaving, setFavSaving] = useState(false)
  // 分组管理：groups = { 分组名: 条数 }（默认分组 key 为 ''）；folded = 已折叠的分组名集合；
  // groupDialog = null 关闭 | { mode:'new' } | { mode:'rename', name } | { mode:'del', name }
  const [favGroups, setFavGroups] = useState({})
  const [favFolded, setFavFolded] = useState(new Set())
  const [groupDialog, setGroupDialog] = useState(null)
  const [groupInput, setGroupInput] = useState('')
  // 一键收藏弹层：null 关闭 | { group }（group 为已选分组名，'' 默认分组）
  const [quickFav, setQuickFav] = useState(null)
  // 当前收藏视图分组：null = 全部 | '' = 仅默认分组 | 其他 = 该分组
  const [favGroupView, setFavGroupView] = useState(null)
  // 多选分组导出弹层：null 关闭 | 已勾选分组 key 数组（'' = 默认分组，默认全选）
  const [exportMulti, setExportMulti] = useState(null)
  // 已收藏语句集合（归一化 SQL）：历史页/SQL 框星标的"已收藏"态由此判定，
  // 与主进程去重同规则（normSql），收藏列表变化即重算
  const favSqlSet = useMemo(
    () => new Set(favList.filter(Boolean).map(x => normSql(x.sql))),
    [favList]
  )
  // 该语句是否已收藏（归一化匹配）——星标变色/文案切换共用
  const isFaved = (sql) => favSqlSet.has(normSql(sql))

  const favListShown = useMemo(
    () => filterFavorites(favList, favFilter),
    [favList, favFilter]
  )

  // 分组视图过滤：favGroupView 为 null 显示全部；否则只显示该分组（'' 即默认分组）。
  // 叠加在关键字过滤之上，分组 chips 与搜索结果互不干扰
  const favVisible = useMemo(() => {
    if (favGroupView === null) {
      return favListShown
    }
    const g = favGroupView || ''
    return favListShown.filter(x => (x.group || '') === g)
  }, [favListShown, favGroupView])

  // 按分组分桶（用于折叠/展开的分组标题渲染）：
  // 组名有序（默认分组'' 排最前），组内条目保持原顺序（最新在前）
  const favBuckets = useMemo(() => {
    const map = new Map()
    for (const x of favVisible) {
      const g = x.group || ''
      if (!map.has(g)) {
        map.set(g, [])
      }
      map.get(g).push(x)
    }
    return Array.from(map.entries())
  }, [favVisible])

  const refreshFavorites = () => {
    listFavorites()
      .then(setFavList)
      .catch(err => console.warn('load sql favorites failed:', err))
  }

  // 分组统计（供分组侧栏/导出粒度/一键收藏下拉）。失败静默（无分组信息也能用）
  const refreshFavGroups = () => {
    listGroups()
      .then(g => {
        if (g && typeof g === 'object') {
          setFavGroups(g)
        }
      })
      .catch(() => {})
  }

  // tab 切换：第一次进收藏 tab 时拉列表与分组（历史 tab 维持原行为不动）
  const switchPanelTab = (key) => {
    setFavTab(key)
    if (key === 'favorite') {
      refreshFavorites()
      refreshFavGroups()
    }
  }

  const pickFavorite = (item) => {
    insertToEditor(item.sql)
    openSqlHistory(false)
  }

  // B-2 新建：默认取当前编辑器内容
  const newFavorite = () => {
    setFavEdit({ id: '', title: '', sql: sqlText || '', group: '' })
  }

  const editFavorite = (item) => {
    setFavEdit({ id: item.id, title: item.title || '', sql: item.sql || '', group: item.group || '' })
  }

  // 标题缺省取语句首个非注释行前 60 字符（与快速面板 firstLine 同思路）
  const favTitleFallback = (sql) => {
    const line = String(sql || '')
      .split('\n')
      .map(l => l.trim())
      .find(l => l && !l.startsWith('--') && !l.startsWith('#')) || ''
    return line.slice(0, 60)
  }

  const saveFavEdit = () => {
    if (!favEdit || !favEdit.sql.trim() || favSaving) {
      return
    }
    setFavSaving(true)
    saveFavorite({
      id: favEdit.id || '',
      title: favEdit.title.trim() || favTitleFallback(favEdit.sql),
      sql: favEdit.sql,
      dbType: tab.dbType,
      group: favEdit.group || ''
    })
      .then(res => {
        setFavSaving(false)
        const list = res && Array.isArray(res.list) ? res.list : null
        if (list) {
          setFavList(list)
        }
        // 内容去重提示：新建场景命中已存在的同语句收藏
        if (res && res.duplicate && !favEdit.id) {
          const dupGroup = res.duplicate.group || ''
          message.warning(
            dupGroup
              ? e('dbFavDupMoved').replace('{g}', dupGroup)
              : e('dbFavDupDefault')
          )
          return
        }
        setFavEdit(null)
      })
      .catch(err => {
        setFavSaving(false)
        message.error((err && err.message) || e('dbFavSaveFailed'))
      })
  }

  // 先本地移除（点击即刻消失），主进程落盘后以回包为准；失败不回滚——
  // 下次打开会重新出现，与历史删除同一策略
  const removeOneFavorite = (item) => {
    if (!item || !item.id) {
      return
    }
    setFavList(list => list.filter(x => x.id !== item.id))
    removeFavorite(item.id).then(list => {
      if (Array.isArray(list)) {
        setFavList(list)
      }
    })
  }

  // B-4 导出：三粒度由 exportFavScoped 处理（单组/多组/全选），见下方分组管理段。

  // B-4 导入：主进程读文件 + 按 id upsert（重复覆盖、新条追加），
  // 返回 { list, imported, overwritten } 供提示
  const importFav = () => {
    window.api.openDialog({
      title: e('dbFavImport'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
      .then(res => {
        const p = Array.isArray(res) ? res[0] : (res && res.filePaths && res.filePaths[0])
        if (!p) {
          return null
        }
        return importFavorites(p).then(r => {
          if (r && Array.isArray(r.list)) {
            setFavList(r.list)
          }
          if (r) {
            message.success(
              e('dbFavImported')
                .replace('{n}', String(r.imported))
                .replace('{m}', String(r.overwritten))
            )
          }
        })
      })
      .catch(err => {
        message.error((err && err.message) || e('dbFavImportFailed'))
      })
  }

  // ---- 分组管理（B-5）：创建/重命名/删除分组 + 分组折叠 ----
  // 分组名取自收藏条目的 group 字段；新建分组 = 给收藏指定一个当前不存在的组名。
  // 这些函数只操作内存 favList + 调主进程落盘，随后统一 refreshFavGroups

  // 分组对话框确认：mode = 'new' 新建 | 'rename' 重命名 | 'del' 删除
  const submitGroupDialog = () => {
    const d = groupDialog
    if (!d) {
      return
    }
    const name = groupInput.trim()
    if (d.mode === 'del') {
      deleteFavoriteGroup(d.name).then(list => {
        if (Array.isArray(list)) {
          setFavList(list)
          refreshFavGroups()
          message.success(e('dbFavGroupDeleted').replace('{g}', d.name))
        }
      })
      setGroupDialog(null)
      setGroupInput('')
      return
    }
    if (!name) {
      message.error(e('dbFavGroupNameEmpty'))
      return
    }
    if (d.mode === 'rename') {
      renameFavoriteGroup(d.name, name).then(list => {
        if (Array.isArray(list)) {
          setFavList(list)
          refreshFavGroups()
          message.success(e('dbFavGroupRenamed').replace('{o}', d.name).replace('{n}', name))
        }
      })
    } else {
      // 新建：走主进程"空分组登记"持久化——否则空分组无条目归属，
      // 在列表/下拉里永远不可见（登记后 listGroups 会合并空分组，计 0）
      createFavoriteGroup(name)
        .then(() => {
          refreshFavGroups()
          message.success(e('dbFavGroupCreated').replace('{g}', name))
        })
        .catch(() => {})
    }
    setGroupDialog(null)
    setGroupInput('')
  }

  const toggleFavFold = (group) => {
    setFavFolded(prev => {
      const next = new Set(prev)
      if (next.has(group)) {
        next.delete(group)
      } else {
        next.add(group)
      }
      return next
    })
  }

  // 把某收藏移入指定分组（编辑弹窗内的分组下拉走 saveFavEdit）
  const moveFavoriteGroup = (item, group) => {
    saveFavorite({ ...item, group })
      .then(res => {
        if (res && Array.isArray(res.list)) {
          setFavList(res.list)
          refreshFavGroups()
        }
      })
      .catch(err => message.error((err && err.message) || e('dbFavSaveFailed')))
  }

  // ---- 一键收藏（B-6）：执行页当前 SQL / 历史页每条 SQL ----
  // 复用编辑弹窗的保存路径（saveFavorite，含内容去重），但交互更轻。
  // 两条路径共用 saveFavorite：
  // - favoriteNow：立刻收藏到指定分组（星标按钮的直接动作，无弹窗）
  // - openQuickFav：打开确认弹窗选分组（"新建分组"等需要指定分组的场景）
  const favoriteNow = (sql, group) => {
    if (!sql || !sql.trim()) {
      message.warning(e('dbQuickFavEmpty'))
      return
    }
    saveFavorite({
      id: '',
      title: favTitleFallback(sql),
      sql,
      dbType: tab.dbType,
      group: group || ''
    })
      .then(res => {
        if (res && Array.isArray(res.list)) {
          setFavList(res.list)
          refreshFavGroups()
        }
        if (res && res.duplicate) {
          const g = res.duplicate.group || ''
          message.warning(g ? e('dbFavDupMoved').replace('{g}', g) : e('dbFavDupDefault'))
        } else {
          message.success(e('dbFavSaved'))
        }
      })
      .catch(err => {
        message.error((err && err.message) || e('dbFavSaveFailed'))
      })
  }

  const openQuickFav = (sql, existing) => {
    if (!sql || !sql.trim()) {
      message.warning(e('dbQuickFavEmpty'))
      return
    }
    setQuickFav({
      sql,
      title: existing ? existing.title : '',
      id: existing ? existing.id : '',
      group: existing ? (existing.group || '') : ''
    })
  }

  const doQuickFav = (group) => {
    if (!quickFav) {
      return
    }
    saveFavorite({
      id: quickFav.id || '',
      title: quickFav.title || favTitleFallback(quickFav.sql),
      sql: quickFav.sql,
      dbType: tab.dbType,
      group: group || ''
    })
      .then(res => {
        if (res && Array.isArray(res.list)) {
          setFavList(res.list)
          refreshFavGroups()
        }
        if (res && res.duplicate && !quickFav.id) {
          const g = res.duplicate.group || ''
          message.warning(g ? e('dbFavDupMoved').replace('{g}', g) : e('dbFavDupDefault'))
        } else {
          message.success(e('dbFavSaved'))
        }
        setQuickFav(null)
      })
      .catch(err => {
        message.error((err && err.message) || e('dbFavSaveFailed'))
      })
  }

  // ---- 收藏导出（B-4 三粒度）：单组 / 多选 / 全选 ----
  // 渲染层先按所选分组过滤 favList，再把子集交给主进程白名单写文件
  const doExportFavorites = (items) => {
    if (!items.length) {
      message.warning(e('dbFavExportEmpty'))
      return
    }
    window.api.saveDialog({
      title: e('dbFavExport'),
      defaultPath: 'db-sql-favorites.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
      .then(res => {
        if (!res || res.canceled || !res.filePath) {
          return null
        }
        return exportFavorites(res.filePath, items).then(n => {
          message.success(e('dbFavExported').replace('{n}', String(n)))
        })
      })
      .catch(err => {
        message.error((err && err.message) || e('dbFavExportFailed'))
      })
  }

  const exportFavScoped = (group) => {
    // group 为 null 表示"全选"，字符串表示"仅该分组"
    const items = group === null
      ? favList
      : favList.filter(x => (x.group || '') === (group || ''))
    doExportFavorites(items)
  }

  // 多选分组导出：exportMulti = null 关闭 | 已勾选的分组 key 数组（'' = 默认分组）
  const submitExportMulti = () => {
    const checked = exportMulti || []
    if (!checked.length) {
      message.warning(e('dbFavExportMultiEmpty'))
      return
    }
    const set = new Set(checked)
    doExportFavorites(favList.filter(x => set.has(x.group || '')))
    setExportMulti(null)
  }

  return {
    favTab,
    favList,
    favFilter,
    setFavFilter,
    favEdit,
    setFavEdit,
    favSaving,
    favGroups,
    favFolded,
    groupDialog,
    setGroupDialog,
    groupInput,
    setGroupInput,
    quickFav,
    setQuickFav,
    favGroupView,
    setFavGroupView,
    exportMulti,
    setExportMulti,
    favBuckets,
    favVisible,
    isFaved,
    refreshFavorites,
    refreshFavGroups,
    switchPanelTab,
    pickFavorite,
    newFavorite,
    editFavorite,
    saveFavEdit,
    removeOneFavorite,
    importFav,
    submitGroupDialog,
    toggleFavFold,
    moveFavoriteGroup,
    favoriteNow,
    openQuickFav,
    doQuickFav,
    exportFavScoped,
    submitExportMulti
  }
}
