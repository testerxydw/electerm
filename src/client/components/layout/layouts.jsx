import {
  splitConfig
} from '../../common/constants'
import LayoutItem from './layout-item'
import pixed from './pixed'
import { handleAxis } from './split-ratios'

export default function LayoutWrap (props) {
  const {
    children,
    layout,
    wrapStyles,
    handleStyles,
    layoutStyle,
    handleMousedown
  } = props
  const {
    children: childrenCount,
    handle: handleCount
  } = splitConfig[layout]
  const wrapStyle = {
    className: 'layout-wrap layout-wrap-' + layout,
    style: layoutStyle
  }
  return (
    <div {...wrapStyle}>
      {
        new Array(childrenCount).fill(0).map((v, i) => {
          const itemProps = {
            i,
            style: pixed(wrapStyles[i]),
            className: 'layout-item v' + (i + 1),
            batch: i
          }
          return (
            <LayoutItem
              key={i + 'layout-item'}
              {...itemProps}
            >
              {children[i] || null}
            </LayoutItem>
          )
        })
      }
      {
        new Array(handleCount).fill(0).map((v, i) => {
          const style = handleStyles[i] || {}
          const axis = handleAxis(layout, i)
          const itemProps = {
            // 轴向进类名：CSS 靠它决定 cursor 与 4px 命中带的宽窄（S2-4）
            className: 'layout-handle h' + (i + 1) + (axis ? ' ' + axis : ''),
            'data-layout': layout,
            'data-index': i,
            style,
            onMouseDown: handleMousedown
              ? (e) => handleMousedown(e, i)
              : undefined
          }
          return (
            <div
              key={i + 'layout-handle'}
              {...itemProps}
            />
          )
        })
      }
    </div>
  )
}
