import { useState } from 'react'
import { Popover } from 'antd'
import { ColorCard } from '../../common/color-card.jsx'
import './color-picker.styl'

export function ColorPicker ({ value, onChange, ref, disabled, isRgba }) {
  const [visible, setVisible] = useState(false)

  // 拖动取色器属于"选色进行中"，收起交给用户：只有点色点 / random / 提交 hex 才算选定
  function handleLive (color) {
    onChange(color)
  }

  function handleCommit (color) {
    onChange(color)
    setVisible(false)
  }

  const inner = (
    <div ref={ref} className='color-picker-choose' style={{ backgroundColor: value }} />
  )

  if (disabled) return inner

  return (
    <Popover
      content={<ColorCard value={value} onChange={handleLive} onCommit={handleCommit} isRgba={isRgba} />}
      trigger='click'
      open={visible}
      placement='bottomLeft'
      onOpenChange={setVisible}
    >
      {inner}
    </Popover>
  )
}
