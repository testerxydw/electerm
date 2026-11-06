/**
 * 底栏广播入口（原批量输入触发器）
 *
 * 批量输入已并入 G1 广播：控件保留在底栏原位（桌面是输入形状的触发器、
 * 移动端是 B 按钮），点击只打开广播目标选择弹层，与顶栏图标 / 右键 /
 * 快捷键共用 store.openBroadcastPicker。底栏默认落在「发送一次」档，承接
 * 原来「输入一条命令发到多台」的用法；弹层里可切回「持续广播」。
 */
import { Button, Input } from 'antd'

const e = window.translate

export default function BroadcastInputTrigger (props) {
  const open = () => window.store.openBroadcastPicker('once')
  if (props.isMobile) {
    return (
      <Button
        size='small'
        type='text'
        onClick={open}
      >
        B
      </Button>
    )
  }
  return (
    <Input
      size='small'
      readOnly
      variant='borderless'
      placeholder={e('batchInput')}
      className='batch-input-holder'
      style={{ cursor: 'pointer' }}
      onClick={open}
    />
  )
}
