/**
 * U1c：无表选中时的数据页空态 —— 工作台首页。
 *
 * 之前没选中表时数据页是一张空网格（表名为空、控件全隐藏），看起来像坏了。
 * 这里给一个明确的落点：连接摘要 + 四个快捷入口 + 已加载 metadata 里的前几张表。
 *
 * 边界：
 * - 只做快捷入口，不新增数据请求/持久化；"最近表"直接取当前 metadata 的前 8 张表
 * - 动作全部复用 db-session 里已有的闭包，组件本身不碰 IPC
 * - 导入必须落到具体表：菜单直接列出可导入的表，选中后先打开该表再弹向导
 */
import React from 'react'
import { Button, Dropdown, Tooltip } from 'antd'
import {
  ConsoleSqlOutlined,
  DownOutlined,
  ReloadOutlined,
  SearchOutlined,
  TableOutlined,
  UploadOutlined
} from '@ant-design/icons'

const e = window.translate

/**
 * @param {Object}   props
 * @param {string}   [props.engine]        引擎名（MySQL/PostgreSQL/Redis…）
 * @param {string}   [props.target]        目标（host:port · db · user）
 * @param {boolean}  [props.readonly]      只读连接（导入禁用）
 * @param {boolean}  [props.production]    生产连接标记
 * @param {boolean}  [props.loading]       元数据加载中
 * @param {Array}    [props.tables]        最近表 [{ key, label, title, database, schema, table, nodeType }]
 * @param {Function} [props.onRefresh]     刷新元数据
 * @param {Function} [props.onOpenSql]     切到 SQL 页签
 * @param {Function} [props.onQuickOpen]   打开命令面板
 * @param {Function} [props.onOpenTable]   打开某张表
 * @param {Function} [props.onImportTable] 打开某张表并进入导入向导
 * @returns {JSX.Element}
 */
export default function DbWorkspaceHome (props) {
  const {
    engine = '',
    target = '',
    readonly = false,
    production = false,
    loading = false,
    tables = [],
    onRefresh = () => {},
    onOpenSql = () => {},
    onQuickOpen = () => {},
    onOpenTable = () => {},
    onImportTable = () => {}
  } = props
  const canImport = !readonly && tables.length > 0
  const importMenu = {
    items: tables.map(t => ({ key: t.key, label: t.title })),
    onClick: ({ key }) => {
      const hit = tables.find(t => t.key === key)
      if (hit) {
        onImportTable(hit)
      }
    }
  }
  return (
    <div className='db-home'>
      <div className='db-home-card'>
        <div className='db-home-summary'>
          {
            engine
              ? <span className='db-home-engine'>{engine}</span>
              : null
          }
          {
            target
              ? <span className='db-home-target' title={target}>{target}</span>
              : null
          }
          {
            production
              ? <span className='db-home-flag is-prod'>{e('dbRiskProduction')}</span>
              : null
          }
          {
            readonly
              ? <span className='db-home-flag'>{e('readOnly')}</span>
              : null
          }
        </div>
        <div className='db-home-title'>{e('dbHomeTitle')}</div>
        <div className='db-home-hint'>{e('dbHomeHint')}</div>
        <div className='db-home-actions'>
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={onRefresh}
          >
            {e('dbHomeRefresh')}
          </Button>
          <Button
            type='primary'
            icon={<ConsoleSqlOutlined />}
            onClick={onOpenSql}
          >
            {e('dbHomeSql')}
          </Button>
          <Tooltip title='Ctrl / Cmd + K'>
            <Button
              icon={<SearchOutlined />}
              onClick={onQuickOpen}
            >
              {e('dbHomeQuick')}
            </Button>
          </Tooltip>
          <Tooltip title={readonly ? e('dbImportReadonly') : ''}>
            <Dropdown
              menu={importMenu}
              trigger={['click']}
              disabled={!canImport}
            >
              <Button
                icon={<UploadOutlined />}
                disabled={!canImport}
              >
                {e('dbHomeImport')}
                <DownOutlined className='db-home-caret' />
              </Button>
            </Dropdown>
          </Tooltip>
        </div>
        <div className='db-home-recent'>
          <div className='db-home-recent-head'>
            <span className='db-home-recent-title'>{e('dbHomeRecent')}</span>
            {
              tables.length
                ? (
                  <span className='db-home-recent-hint'>
                    {e('dbHomeRecentHint').replace('{n}', String(tables.length))}
                  </span>
                  )
                : null
            }
          </div>
          {
            tables.length
              ? (
                <div className='db-home-tables'>
                  {
                    tables.map(t => (
                      <button
                        key={t.key}
                        type='button'
                        className='db-home-table'
                        title={t.title}
                        onClick={() => onOpenTable(t)}
                      >
                        <TableOutlined />
                        <span className='db-home-table-name'>{t.label}</span>
                      </button>
                    ))
                  }
                </div>
                )
              : <div className='db-home-empty'>{e('dbHomeNoTables')}</div>
          }
        </div>
      </div>
    </div>
  )
}
