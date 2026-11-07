// #32 表结构区（cluster #32 of 设计-db-session拆分方案-N11b）。
//
// 一块纯展示区：工具行（DDL / 自适应全部列宽 / ER 图 / 结构对比 / 字典导出）+ 结构表格。
// 组件本身没有 state、没有 effect、不发请求、不碰持久化 —— 13 个入参全是 owner 的派生值
// 或既有 handler。之所以能这么干净地搬出来，是因为工具行里的动作（fetchDdl / openErGraph /
// openStructureDiff / exportDictionary）本来就都定义在 owner 里、互相之间无依赖。
//
// 行为零变更：JSX 整段逐字搬迁（原 4442–4509 共 68 行），缩进层级不变。
import { Button, Dropdown } from 'antd'
import {
  SearchOutlined,
  NodeIndexOutlined,
  DiffOutlined,
  DownloadOutlined
} from '@ant-design/icons'
import DbGridTable from './db-grid-table'

const e = window.translate

export default function DbStructureArea ({
  structure,
  isPg,
  ddl,
  fetchDdl,
  colFitAllBtn,
  structWidths,
  er,
  openErGraph,
  openStructureDiff,
  structureV2,
  exportDictionary,
  structColumns,
  structureRows
}) {
  return (
    <div className='db-struct-area'>
      {
        // 工具行：只要结构表有行就留着。原来只在 mysql 系（有 DDL 按钮）时渲染，
        // 那样 PG 就没有任何地方点"自适应全部列"（H1a-2）—— 行集有列就该有列宽工具
        structure.rows.length
          ? (
            <div className='db-struct-tools'>
              {
                // A2 DDL 入口：仅 mysql 系显示
                !isPg
                  ? (
                    <Button
                      size='small'
                      icon={<SearchOutlined />}
                      loading={ddl.loading}
                      onClick={fetchDdl}
                    >
                      {e('dbViewDdl')}
                    </Button>
                    )
                  : null
              }
              {colFitAllBtn(structWidths)}
              {/* H3b-3：整库 ER 图。只读，不进 SQL 编辑器；图的范围是当前库/schema */}
              <Button
                size='small'
                icon={<NodeIndexOutlined />}
                loading={er.loading && er.open}
                onClick={openErGraph}
              >
                {e('dbErGraph')}
              </Button>
              {/* H4：两张表结构对比（同连接同库）。只读，不生成任何 DDL */}
              <Button
                size='small'
                icon={<DiffOutlined />}
                onClick={openStructureDiff}
              >
                {e('dbStructDiff')}
              </Button>
              <Dropdown
                trigger='click'
                disabled={!structureV2.columns.length}
                menu={{
                  items: [
                    { key: 'md', label: 'Markdown' },
                    { key: 'csv', label: 'CSV' }
                  ],
                  onClick: ({ key }) => exportDictionary(key)
                }}
              >
                <Button size='small' icon={<DownloadOutlined />}>
                  {e('dbDictExport')}
                </Button>
              </Dropdown>
            </div>
            )
          : null
      }
      <DbGridTable
        size='small'
        loading={structure.loading}
        columns={structColumns}
        dataSource={structureRows}
        rowKey='__rowKey'
        pagination={false}
      />
    </div>
  )
}
