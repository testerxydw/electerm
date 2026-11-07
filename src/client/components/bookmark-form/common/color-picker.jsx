import { useState } from 'react'
import { Popover } from 'antd'
import { ColorCard } from '../../common/color-card.jsx'
import './color-picker.styl'

export function ColorPicker ({ value, onChange, ref, disabled, isRgba, inline }) {
  const [visible, setVisible] = useState(false)

  // 拖动取色器属于"选色进行中"，收起交给用户：只有点色点 / random / 提交 hex 才算选定
  function handleLive (color) {
    onChange(color)
  }

  function handleCommit (color) {
    onChange(color)
    setVisible(false)
  }

  // 合并上游 appearance-picker 时新增：它要的是"色卡直接铺在 Tab 里"，
  // 而不是"一个色点 + 弹层"。上游原本在自己的 renderContent 里重复写了一遍色卡，
  // 我们这边色卡已经抽成共用的 ColorCard（页签右键也用同一张），
  // 所以 inline 直接返回它 —— DOM 结构（.color-picker-box）与上游一致。
  if (inline) {
    return <ColorCard value={value} onChange={onChange} isRgba={isRgba} />
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
