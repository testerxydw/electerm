// #24 元数据树数据（cluster #24 of 设计-db-session拆分方案-N11b）。
//
// 这一簇是「把 metadata 变成 antd Tree 能吃的 dataSource」这一个职责域：
//   过滤      visibleMetadata（只作用于已加载的 metadata，不重新请求后端；
//             PG 的「库 → schema → 表」逐层递归，节点自身命中保留全部子节点）
//   计数      countTreeNodes / treeFilterNodeCount（过滤后的节点总数）
//   标题      treeTitle（两层高亮叠加：树过滤命中 db-tree-hit + 顶栏查找 db-kw-hit）
//   装配      treeData（叶子 / 对象分组 / PG schema / Redis 库 / 普通库四条分支）
//
// 两张形状图标表（DB_OBJECT_ICONS / DB_GROUP_ICONS）随簇搬入：它们只被 treeData 消费，
// 留在 owner 就是两块只为别人服务的死常量。
//
// 行为零变更：整段逐字搬迁（原 2365–2530，166 行）。
//
// 为什么是 .jsx：treeData 的每条分支都在构造 <span> / <Button> / <Tooltip>。
//
// 不回流（仅本簇内部使用）：countTreeNodes / treeTitle。
//
// TDZ 说明：owner 里 useDbTree（第 760 行左右）用 getVisibleMetadata: () => visibleMetadata
// 惰性取本 hook 的返回值，只在事件/effect 执行期读，所以本 hook 排在它之后调用是安全的。
import { useMemo } from 'react'
import { Button, Tooltip } from 'antd'
import {
  EyeOutlined, CodeOutlined, FunctionOutlined, ThunderboltOutlined, ClockCircleOutlined
} from '@ant-design/icons'
import { hlText, hlNode } from './db-search'
import {
  isLeafNode,
  isDbObjectType,
  countTreeLeaves,
  DB_GROUP_LABEL,
  nodeKey
} from '../../common/db-session-const'

const e = window.translate

// U4：非表对象改用形状图标（眼睛/代码/fx/闪电/时钟），颜色由 `.is-<type>` 走 token。
// 单字母标记只留给命令面板的窄 hint 位置（树里已不再显示字母）。
const DB_OBJECT_ICONS = {
  view: <EyeOutlined />,
  procedure: <CodeOutlined />,
  function: <FunctionOutlined />,
  trigger: <ThunderboltOutlined />,
  event: <ClockCircleOutlined />
}
// 分组节点（过程与函数 / 触发器 / 事件）用同类图标，和组内叶子对得上
const DB_GROUP_ICONS = {
  routine: <CodeOutlined />,
  trigger: <ThunderboltOutlined />,
  event: <ClockCircleOutlined />
}

export function useDbTreeData ({
  metadata,
  treeFilterKw,
  kw,
  isRedis,
  isPg,
  currentDbName,
  setConnectDb
}) {
  // T2/T3：树过滤只作用于已加载的 metadata，不重新请求后端。
  // 递归支持 PG 的「库 → schema → 表」：节点自身命中时保留全部子节点，
  // 仅子节点命中时只保留命中的分支。
  const visibleMetadata = useMemo(() => {
    if (!treeFilterKw) {
      return metadata
    }
    const hit = name => String(name || '').toLowerCase().includes(treeFilterKw)
    const filterNode = node => {
      const nodeHit = hit(node.name)
      if (isLeafNode(node)) {
        return nodeHit ? node : null
      }
      const children = (node.children || []).map(filterNode).filter(Boolean)
      if (!nodeHit && !children.length) {
        return null
      }
      return { ...node, children: nodeHit ? (node.children || []) : children }
    }
    return metadata.map(db => (
      isRedis
        ? (hit(db.name) ? db : null)
        : filterNode(db)
    )).filter(Boolean)
  }, [metadata, isRedis, treeFilterKw])
  const countTreeNodes = nodes => (nodes || []).reduce(
    (n, node) => n + 1 + countTreeNodes(node.children),
    0
  )
  const treeFilterNodeCount = countTreeNodes(visibleMetadata)
  // 树过滤命中用 db-tree-hit（不复用 db-kw-hit，避免顶栏查找计数误收）；
  // 再套一层顶栏查找高亮，保留两套高亮叠加
  const treeTitle = (text) => hlNode(
    hlText(text, treeFilterKw, 'db-tree-hit'),
    kw
  )

  // 树数据只在元数据/过滤/查找关键字变化时重建：
  // 输入页筛选、编辑单元格等状态变化不再递归重建整棵树。
  const treeData = useMemo(() => {
    // 非 redis 树节点递归：MySQL 为「库 → 表」，PG 为「库 → schema → 表」
    const toTreeChildren = (dbName, schema, nodes) => (nodes || []).map(node => {
      if (isLeafNode(node)) {
        // F0/U4：视图与表在树里同名同形；非表对象用形状图标标记（眼睛/代码/fx/闪电/时钟），
        // 颜色由 .is-<type> 走 token。表本身不加图标，与对象区分开。
        // 名字一律包进 .db-tree-name：那层是"这串是标识符 → 吃数据面字体"的标记，
        // 分组标签/计数/图标这些 chrome 不包（P-1/P-2）
        const icon = DB_OBJECT_ICONS[node.type]
        return {
          title: icon
            ? (
              <span className='db-tree-view'>
                <span
                  className={'db-tree-obj-icon is-' + node.type}
                  aria-hidden='true'
                >
                  {icon}
                </span>
                <span className='db-tree-name'>{treeTitle(node.name)}</span>
              </span>
              )
            : <span className='db-tree-name'>{treeTitle(node.name)}</span>,
          key: nodeKey(dbName, schema, node.name),
          isLeaf: true,
          // 类型随节点走：后续按钮门控（视图不可插入行）要它
          nodeType: node.type,
          // B2：对象定位信息（PG 函数需签名区分重载、触发器需表名）——
          // 只挂在树节点上，不进 metadata 契约之外的持久化
          objMeta: isDbObjectType(node.type)
            ? { signature: node.signature || '', table: node.table || '' }
            : undefined
        }
      }
      // B2：库内对象分组（过程与函数 / 触发器 / 事件）。分组本身不可选中，
      // 只负责收起，避免几百个过程把表名挤出屏幕
      if (node.type === 'group') {
        return {
          title: (
            <span className='db-tree-schema'>
              <span
                className={'db-tree-obj-icon is-group-' + node.group}
                aria-hidden='true'
              >
                {DB_GROUP_ICONS[node.group] || <CodeOutlined />}
              </span>
              {/* 分组标签是本地化界面词，不是标识符 → 故意不包 .db-tree-name */}
              {treeTitle(e(DB_GROUP_LABEL[node.group] || 'dbRoutines'))}
              <span className='db-tree-count'>{(node.children || []).length}</span>
            </span>
          ),
          key: nodeKey(dbName, schema, node.name),
          children: toTreeChildren(dbName, schema, node.children)
        }
      }
      // PG schema 节点：S 标记便于与库 / 表区分；空 schema 也保留
      return {
        title: (
          <span className='db-tree-schema'>
            <span className='db-tree-schema-mark'>S</span>
            <span className='db-tree-name'>{treeTitle(node.name)}</span>
            <span className='db-tree-count'>{countTreeLeaves(node.children)}</span>
          </span>
        ),
        key: nodeKey(dbName, node.name),
        children: toTreeChildren(dbName, node.name, node.children)
      }
    })

    if (isRedis) {
      return visibleMetadata.map(db => {
        const i = metadata.indexOf(db)
        return {
          // 键个数（来自 INFO keyspace）；空 db 显示 0，
          // 受管实例禁用 INFO 时后端不回 count → 此处不显示数字
          title: (
            <span className='db-tree-db'>
              <span className='db-tree-db-name db-tree-name'>{treeTitle(db.name)}</span>
              {
                typeof db.count === 'number'
                  ? <span className='db-tree-db-count'>{db.count}</span>
                  : null
              }
            </span>
          ),
          key: String(i),
          isLeaf: false
        }
      })
    }
    return visibleMetadata.map(db => ({
      // 不复用 .db-tree-db（space-between 供 redis 计数用），错误标记须紧邻库名
      title: (
        <span className='db-tree-db-title'>
          <span className='db-tree-name'>{treeTitle(db.name)}</span>
          {
            // per-db 元数据降级标记：单库 SHOW TABLES 失败（权限等），
            // 库名保留可重试（点顶栏刷新重拉）
            db.error
              ? <Tooltip title={db.error}><span className='db-tree-db-err'>!</span></Tooltip>
              : null
          }
          {
            // T4：PG 非当前库给「连接」入口，新开临时 tab（不写书签、不回显密码）
            isPg && db.name !== currentDbName
              ? (
                <Button
                  type='link'
                  size='small'
                  className='db-tree-connect'
                  onClick={ev => {
                    ev.preventDefault()
                    ev.stopPropagation()
                    setConnectDb(db.name)
                  }}
                >
                  {e('dbConnect')}
                </Button>
                )
              : null
          }
        </span>
      ),
      key: nodeKey(db.name),
      children: toTreeChildren(db.name, '', db.children)
    }))
  }, [visibleMetadata, isRedis, metadata, treeFilterKw, kw, isPg, currentDbName])
  return {
    visibleMetadata,
    treeFilterNodeCount,
    treeData
  }
}
