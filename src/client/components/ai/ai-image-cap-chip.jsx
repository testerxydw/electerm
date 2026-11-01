import { FileImageOutlined, WarningOutlined } from '@ant-design/icons'

/**
 * 图片能力芯片。
 *
 * 只在"这条信息值得动手"时才出现，否则工具条上一个常驻小标签就是噪声：
 * - 判定为纯文本（用户覆盖或模型名判出）——发图前必须让人看到；
 * - 通道不是 OpenAI Chat——本轮只有 Chat 做了图片分片映射，其余会静默丢图；
 * - 已经有图片草稿但能力"未识别"——此时提醒一句"我们没把握"，比发出去靠 provider 报错好。
 *
 * 判定是猜的（没有标准接口能读模态），所以文案说"判定为"而不说"不支持"，
 * 并把依据（覆盖/预置/模型名）放进 title，点开设置就能改。
 */
const SOURCE_KEY = {
  override: 'aiImageCapSourceOverride',
  preset: 'aiImageCapSourcePreset',
  'model-name': 'aiImageCapSourceName',
  none: 'aiImageCapSourceNone'
}

const SUPPORT_KEY = {
  yes: 'aiImageCapYes',
  no: 'aiImageCapNo',
  unknown: 'aiImageCapUnknown'
}

export default function AiImageCapChip (props) {
  const e = window.translate
  const { support = 'unknown', source = 'none', transport = 'openai-chat', hasImages } = props
  const isChat = transport === 'openai-chat'
  const showTransport = !isChat
  const showCapability = support === 'no' || (hasImages && support === 'unknown')
  if (!showTransport && !showCapability) {
    return null
  }

  // 通道问题优先：能力再强也发不出去，先把"为什么一定不行"讲清楚
  const stateClass = showTransport ? 'is-transport' : (support === 'no' ? 'is-no' : 'is-unknown')
  const label = showTransport ? e('aiImageTransportBlocked') : e(SUPPORT_KEY[support] || SUPPORT_KEY.unknown)
  const reason = e(SOURCE_KEY[source] || SOURCE_KEY.none)
  const title = showTransport
    ? `${e('aiImageTransportTip')} ${reason}`
    : `${e('aiImageCapTip')} ${reason}`

  return (
    <span
      className={`ai-image-cap-chip ${stateClass}`}
      title={title}
      onClick={props.onOpenConfig}
      role='button'
      tabIndex={0}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault()
          props.onOpenConfig && props.onOpenConfig()
        }
      }}
    >
      {showTransport ? <WarningOutlined /> : <FileImageOutlined />}
      <span className='ai-image-cap-chip-text'>{label}</span>
    </span>
  )
}
