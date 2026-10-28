/**
 * H1a-1：截断单元格的悬停预览卡（5 处网格共用：SQL 结果 / 数据页 / 结构页 /
 * Redis 键列表 / Redis 详情）
 *
 * 为什么不是"每格一个 Popover"：rc-table 的原生 title 只在单元格渲染出来的 children
 * 是字符串（或只包一层元素、里层是字符串）时才生成 —— 也就是说它顶多重复一遍"格子
 * 里已经显示出来的那段"，而且对象列在网格里就被 slice 成 200 字符了，title 也只有
 * 那 200 字符。真正的"看不全"（超长文本的全文、JSON 的完整结构）原生 title 给不了；
 * 加上 title 的样式/延时由桌面环境决定，深浅主题下都不受控。
 * 给每个 td 挂浮层在 1 万行下会造出上万个观察者，所以这里做成**受控单例**：整个网格
 * 共享一个 Popover，锚点是一个跟随单元格落点的 fixed 元素，DOM 数不随行数增长。
 * 锚点尺寸见 styl 里的注释：不能是 0×0，否则 rc-trigger 判它"不可见"，浮层会一直
 * 停在 -1000vw/-1000vh 的待定位坐标（内容全对但一个像素都看不见）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Popover, Button } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import { highlightValue } from './db-highlight'
import { cellText } from '../../common/db-column-width'

const e = window.translate

// 预览卡最多渲染的字符数：再长只给前缀 + "查看完整"（全文交给值面板/Modal）
export const PREVIEW_MAX = 4000

/**
 * 5 处网格共用的列 ellipsis 配置。
 *
 * ellipsis: true 时 rc-table 会把"格子里显示出来的那段文本"塞进原生 title，
 * 于是悬停同时出现原生 tooltip 和预览卡两层。预览卡是更强的信息源（全文 + 字符数
 * + 复制 + 高亮），所以这里显式关掉原生 title，让"截断内容怎么看"只有一种答案。
 * 表头不受影响：rc-table 对 header 行无条件生成 title（列名被截断时仍能看到全名）。
 */
export const CELL_ELLIPSIS = { showTitle: false }

// 指针离开单元格到真正关闭之间的缓冲：没有它，指针永远无法移进卡片里选中复制
const HIDE_DELAY = 200

/**
 * 悬停预览的受控状态。返回给调用方挂到 column.onCell 上：
 * show(ev, colName, value) / scheduleHide() / cancelHide() / hide()
 */
export function useCellPreview () {
  const [state, setState] = useState(null)
  const timerRef = useRef(null)
  // 只观察"当前这一格"：观察者数量恒为 1，不随行数/格数增长
  const roRef = useRef(null)
  const cellRef = useRef(null)

  const cancelHide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const hide = useCallback(() => {
    cancelHide()
    setState(null)
  }, [cancelHide])

  const scheduleHide = useCallback(() => {
    cancelHide()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setState(null)
    }, HIDE_DELAY)
  }, [cancelHide])

  /**
   * 挂上"源单元格消失就关卡"的兜底。
   *
   * 为什么 mouseleave + scroll 不够：切页签/折叠分屏时面板是 display:none，
   * 指针根本没动，浏览器不会派发 mouseout；卡片又是 portal 挂在 body 上、
   * 不在被隐藏的 pane 里，于是它会带着上一个页签的内容浮在新页签上面。
   * display:none 会让观察中的元素报出 0 尺寸、虚拟滚动回收行会让它脱离 DOM，
   * 这两种都能被 ResizeObserver 抓到，代价是一个观察者。
   */
  const watchCell = useCallback((td) => {
    if (cellRef.current === td) {
      return
    }
    cellRef.current = td
    if (!window.ResizeObserver) {
      return
    }
    if (!roRef.current) {
      roRef.current = new window.ResizeObserver(entries => {
        const last = entries[entries.length - 1]
        const gone = !last || !last.target.isConnected ||
          (last.contentRect.width === 0 && last.contentRect.height === 0)
        if (gone) {
          cancelHide()
          setState(null)
        }
      })
    }
    roRef.current.disconnect()
    roRef.current.observe(td)
  }, [cancelHide])

  const show = useCallback((ev, col, value) => {
    const td = ev.currentTarget
    if (!td) {
      return
    }
    // 只在"真被截断"时弹：可视宽度装不下内容才说明用户确实看不全
    if (td.scrollWidth <= td.clientWidth) {
      return
    }
    const text = cellText(value)
    if (!text) {
      return
    }
    const rect = td.getBoundingClientRect()
    watchCell(td)
    cancelHide()
    setState({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      col,
      text
    })
  }, [cancelHide, watchCell])

  useEffect(() => () => {
    cancelHide()
    if (roRef.current) {
      roRef.current.disconnect()
      roRef.current = null
    }
  }, [cancelHide])

  return { state, show, hide, scheduleHide, cancelHide }
}

export default function DbCellPreview (props) {
  const {
    state,
    patterns,
    themeConfig,
    onHide,
    onEnter,
    onLeave,
    onFullText
  } = props

  // 表格在滚动 / 按 Esc 时立即关闭：浮层停在原地指向别的单元格会误导人
  useEffect(() => {
    if (!state) {
      return
    }
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        onHide()
      }
    }
    const onScroll = () => onHide()
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [state, onHide])

  const shown = useMemo(() => {
    if (!state) {
      return null
    }
    const truncated = state.text.length > PREVIEW_MAX
    return {
      clipped: truncated ? state.text.slice(0, PREVIEW_MAX) : state.text,
      truncated
    }
  }, [state])

  const highlighted = useMemo(
    () => shown
      ? highlightValue(shown.clipped, patterns, themeConfig, { maxLength: PREVIEW_MAX })
      : null,
    [shown, patterns, themeConfig]
  )

  return (
    <Popover
      open={!!state}
      trigger={[]}
      placement='bottomLeft'
      // 关闭即卸载浮层内容：默认实现只是把气泡 display:none， DOM 里会一直留着
      // 上一次悬停的长文本（最坏 4000 字符）。用"DOM 里有没有卡"当"卡开没开"
      // 的实测判据也因此才成立。
      destroyOnHidden
      content={
        state && shown
          ? (
            <div
              className='db-cell-preview'
              onMouseEnter={onEnter}
              onMouseLeave={onLeave}
            >
              <div className='db-cell-preview-head'>
                <span
                  className='db-cell-preview-col'
                  title={state.col}
                >
                  {state.col}
                </span>
                <span className='db-cell-preview-meta'>
                  {e('dbCellChars').replace('{n}', state.text.length)}
                </span>
                <Button
                  size='small'
                  type='text'
                  icon={<CopyOutlined />}
                  title={e('copy')}
                  onClick={() => copy(state.text)}
                />
                {
                  shown.truncated && onFullText
                    ? (
                      <Button
                        size='small'
                        onClick={() => onFullText(state)}
                      >
                        {e('dbViewFullText')}
                      </Button>
                      )
                    : null
                }
              </div>
              <pre className='db-cell-preview-pre'>
                {highlighted}
                {
                  shown.truncated
                    ? <span className='db-cell-preview-more'>{e('dbCellTruncated')}</span>
                    : null
                }
              </pre>
            </div>
            )
          : null
      }
    >
      <div
        className='db-cell-preview-anchor'
        style={{ left: state ? state.x : -1, top: state ? state.y : -1 }}
      />
    </Popover>
  )
}
