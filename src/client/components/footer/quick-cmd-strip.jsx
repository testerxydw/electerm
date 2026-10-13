/**
 * 底栏快速命令带：常显在底栏中部空白区（批量输入框之后）
 *
 * - 左右箭头循环切换分组：全部 → 组1 → 组2 → … → 全部（tag 空串=全部）
 * - 当前分组持久化到 localStorage（quickCmdBarTagKey），无设置项
 * - 点击胶囊执行该快速命令项（runQuickCommandItem，与浮动框点击行为一致）
 * - 命令多时带内横向滚动（滚轮横滚），右缘渐隐提示可滚
 */

import { Component, createRef } from 'react'
import { quickCmdBarTagKey } from '../../common/constants'
import * as ls from '../../common/safe-local-storage'

const e = window.translate

// 纯函数：按分组标签过滤快速命令（tag 空串返回全量），便于单测
export function filterQuickCommands (list, tag) {
  if (!tag) {
    return list
  }
  return list.filter(q => (q.labels || []).includes(tag))
}

export default class QuickCmdStrip extends Component {
  constructor (props) {
    super(props)
    this.stripRef = createRef()
    this.state = {
      tag: ls.getItem(quickCmdBarTagKey)
    }
  }

  componentDidMount () {
    // React 的 onWheel 是 passive 监听，无法 preventDefault，
    // 改用原生监听把纵向滚轮转为命令带横向滚动
    this.stripRef.current?.addEventListener('wheel', this.handleWheel, {
      passive: false
    })
  }

  componentWillUnmount () {
    this.stripRef.current?.removeEventListener('wheel', this.handleWheel)
  }

  handleWheel = (ev) => {
    ev.preventDefault()
    const node = this.stripRef.current
    if (node) {
      node.scrollLeft += ev.deltaY + ev.deltaX
    }
  }

  cycleTag = (dir) => {
    const tags = ['', ...window.store.quickCommandTags]
    const idx = tags.indexOf(this.state.tag)
    const next = tags[(idx < 0 ? 0 : idx + dir + tags.length) % tags.length]
    this.setState({ tag: next })
    ls.setItem(quickCmdBarTagKey, next)
  }

  renderArrow (dir) {
    const props = {
      className: 'qcs-arrow pointer',
      role: 'button',
      tabIndex: 0,
      onClick: () => this.cycleTag(dir),
      onKeyDown: ev => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          this.cycleTag(dir)
        }
      }
    }
    return (
      <span {...props}>
        {dir < 0 ? '‹' : '›'}
      </span>
    )
  }

  render () {
    const { quickCommands, quickCommandTags } = window.store
    const { tag } = this.state
    const list = filterQuickCommands(quickCommands, tag)
    return (
      <div className='quick-cmd-strip'>
        {
          quickCommandTags.length
            ? (
              <span className='qcs-group-switch'>
                {this.renderArrow(-1)}
                <span
                  className='qcs-tag'
                  title={tag || e('quickCommands')}
                >
                  {tag || e('quickCommands')}
                </span>
                {this.renderArrow(1)}
              </span>
              )
            : null
        }
        <div className='qcs-cmds' ref={this.stripRef}>
          {
            list.length
              ? list.map(q => {
                const cmd = q.command || ''
                return (
                  <span
                    key={q.id}
                    className='qcs-cmd'
                    role='button'
                    tabIndex={0}
                    title={cmd}
                    onClick={() => window.store.runQuickCommandItem(q.id)}
                    onKeyDown={ev => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault()
                        window.store.runQuickCommandItem(q.id)
                      }
                    }}
                  >
                    {q.name || cmd}
                  </span>
                )
              })
              : <span className='qcs-empty'>{e('notFoundContent')}</span>
          }
        </div>
      </div>
    )
  }
}
