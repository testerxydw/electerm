// 元数据树面板（cluster #2 of 设计-db-session拆分方案-N11a）。
// 独立渲染左侧元数据树；props/state 由 owner（DbSession）注入，组件不自建句柄。
// 已接线：db-session.jsx 的树面板内联渲染整段改为调用本组件，
// 11 个 props 全部由 owner 注入；JSX 与原内联块逐字等价（见设计文档 §1）。
import React from 'react'
import { Tree, Input, Spin, Empty, Button } from 'antd'
import { SearchOutlined } from '@ant-design/icons'

const e = window.translate

export function DbTreePanel ({
  treeWidth,
  treeFilter,
  setTreeFilter,
  treeFilterKw,
  treeFilterNodeCount,
  treeLoading,
  treeData,
  expandedKeys,
  setExpandedKeys,
  selectedKeys,
  onSelectTree
}) {
  return (
    <div
      className='db-tree-panel'
      style={{ width: treeWidth }}
    >
      <div className='db-tree-filter'>
        <Input
          size='small'
          prefix={<SearchOutlined />}
          placeholder={e('dbFilterTree')}
          value={treeFilter}
          onChange={ev => setTreeFilter(ev.target.value)}
          allowClear
          aria-label={e('dbFilterTree')}
        />
      </div>
      {
        treeFilterKw
          ? (
            <div className='db-tree-filter-count'>
              {treeFilterNodeCount} {e('dbFilterNodes')}
            </div>
            )
          : null
      }
      <Spin spinning={treeLoading}>
        {
          treeData.length
            ? (
              <Tree
                blockNode
                treeData={treeData}
                expandedKeys={expandedKeys}
                onExpand={keys => setExpandedKeys(keys.map(String))}
                selectedKeys={selectedKeys}
                onSelect={onSelectTree}
                className='db-tree'
              />
              )
            : treeFilterKw
              ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={e('dbFilterNoTreeMatch')}
                >
                  <Button size='small' onClick={() => setTreeFilter('')}>
                    {e('dbFilterClear')}
                  </Button>
                </Empty>
                )
              : <Empty description={e('dbNoMetadata')} />
        }
      </Spin>
    </div>
  )
}
