/**
 * SQL 结果单元格右键菜单（设计 §2.2 第 7 条 / §2.3 右键菜单）
 *
 * 受控单例浮层，与 DbColMenu 同一套机制：整个 db 会话只挂一份浮层，
 * 网格的 onCell 只负责"右键时把落点与菜单项写进 state"。不每格挂一个
 * antd Dropdown —— 1 万行结果的每一格都挂 Trigger 会拖垮渲染。
 * 菜单项由调用点按上下文生成（items 每项自带 onClick），本组件只管
 * 浮层的定位、关闭通道与渲染，不掺业务动作。
 */
import React, { useEffect, useRef } from 'react'
import { Popover } from 'antd'

export function DbCellMenu (props) {
  const { target, onHide } = props
  const popRef = useRef(null)

  useEffect(() => {
    if (!target) {
      return
    }
    const onDown = (ev) => {
      const el = popRef.current
      // 菜单开着时在别处按下（含再次右键另一格）先收起。
      // 再次右键的顺序是 pointerdown → contextmenu，所以收起后会在新的那一格重开
      if (el && !el.contains(ev.target)) {
        onHide()
      }
    }
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        onHide()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onHide, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onHide, true)
    }
  }, [target, onHide])

  const headText = target ? String(target.head || '') : ''

  return (
    <Popover
      open={!!target}
      trigger={[]}
      placement='bottomLeft'
      // 关闭即卸载：DOM 里不留"藏起来的上一次菜单"，
      // "菜单在不在 DOM"才是可信的实测判据
      destroyOnHidden
      content={
        target
          ? (
            <div className='db-cell-menu' ref={popRef}>
              {
                headText
                  ? <div className='db-cell-menu-head' title={headText}>{headText}</div>
                  : null
              }
              {
                target.items.map(item => (
                  <button
                    type='button'
                    key={item.key}
                    className='db-cell-menu-item'
                    onClick={() => {
                      item.onClick()
                      onHide()
                    }}
                  >
                    {item.text}
                  </button>
                ))
              }
            </div>
            )
          : null
      }
    >
      {/* 锚点尺寸规则同列宽菜单：fixed 元素 offsetParent 恒为 null，0×0 会被
          rc-trigger 判成"不可见"，浮层就永远停在 -1000vw/-1000vh 待定位坐标。
          类名独立于 .db-col-menu-anchor —— 可读性回归按后者数"列宽菜单单例"，
          两个组件共用会让计数恒为 2 */}
      <span
        className='db-cell-menu-anchor'
        style={{ left: target ? target.x : -1, top: target ? target.y : -1 }}
      />
    </Popover>
  )
}
