import { useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { copy } from '../../common/clipboard'
import Link from '../common/external-link'
import { Tag, Popconfirm, Button, Alert } from 'antd'
import {
  CopyOutlined,
  PlayCircleOutlined,
  ImportOutlined,
  FlagOutlined,
  FlagFilled
} from '@ant-design/icons'
// 提示统一走应用自己的 message 通道（与数据库页、会话页同一套样式与容器），
// 而不是 antd 的静态实例——静态实例不读主题，同一屏里会出现两种浮层
import message from '../common/message'
import getBrand from './get-brand'
import CopyIcon from './copy-icon'
// AI 第一批：SQL 代码块能落回数据库会话页的编辑器。
// 目标按活动 tab 从登记表取（点击时解析，不在渲染期解析——历史条目是 memo 的，
// 切 tab 不会重渲染，渲染期解析出来的可用性会过期）
import { getActiveSqlTarget } from '../../common/db-sql-ai-target'
import { planSqlInsertion, looksLikeSql } from '../../common/db-sql-ai'

const e = window.translate

const enableAIFlag = !!(window.et && window.et.enableAIFlag)

// 代码块语言标注 → 是不是 SQL（围栏标的是 ```mysql / ```postgresql 之类）
const SQL_LANG_RE = /language-(sql|mysql|mariadb|tidb|postgres|postgresql|pgsql|tsql|sqlserver|oracle|plsql)\b/i

export default function AIOutput ({ item }) {
  const outputRef = useRef(null)
  const {
    response,
    baseURLAI,
    nameAI,
    modelAI
  } = item

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [response])

  if (!response && !(item.flagged && enableAIFlag)) {
    return null
  }

  const { brand, brandUrl } = getBrand(baseURLAI)

  const renderCode = (props) => {
    const { node, className = '', children, ...rest } = props
    const code = String(children).replace(/\n$/, '')
    const inline = !className.includes('language-')
    if (inline) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }

    const copyToClipboard = () => {
      copy(code)
    }

    // SQL 块：落回当前数据库会话页的编辑器。只写不执行——执行仍由用户按运行、
    // 并照旧过危险 SQL 确认闸门。策略固定用 cursor：对话里插入不该悄悄吃掉
    // 用户在编辑器里已有的选区
    const isSqlBlock = SQL_LANG_RE.test(className) || looksLikeSql(code)

    const insertToSqlEditor = () => {
      const target = getActiveSqlTarget()
      if (!target || !target.isAvailable || !target.isAvailable()) {
        message.warning(e('dbAiInsertNoTarget'))
        return
      }
      const selection = target.getSelection ? target.getSelection() : null
      const plan = planSqlInsertion({
        text: code,
        currentText: target.getDocText ? target.getDocText() : '',
        selectionRange: selection && selection.range,
        strategy: 'cursor'
      })
      // 写 plan.text：策略层可能给它补了分隔换行（光标紧贴非空白字符时），
      // 传原始 code 会让"两句话粘成一句"（实机截图量到过）
      target.insertSql(plan.text, plan)
      message.success(e('dbAiInserted'))
    }

    const runInTerminal = () => {
      // Filter out comments from the code before running
      const filteredCode = code
        .split('\n')
        .map(line => line.trim())
        .filter(line => {
          // Remove empty lines and comments
          if (!line) {
            return false
          }
          if (line.startsWith('#')) {
            return false
          }
          return true
        })
        .join('\n') // Join multiple commands with &&

      if (filteredCode) {
        window.store.runCommandInTerminal(filteredCode)
      }
    }

    return (
      <div className='code-block'>
        <div className='code-block-actions alignright'>
          {
            // SQL 块给"插入编辑器"，并且不给"在终端运行"——把一段 SQL 丢进
            // shell 只会得到 command not found，而它看起来像是执行过了
            isSqlBlock
              ? (
                <ImportOutlined
                  className='code-action-icon pointer iblock'
                  onClick={insertToSqlEditor}
                  title={e('dbAiInsert')}
                />
                )
              : (
                <PlayCircleOutlined
                  className='code-action-icon pointer mg1l iblock'
                  onClick={runInTerminal}
                />
                )
          }
          <CopyOutlined
            className='code-action-icon pointer iblock'
            onClick={copyToClipboard}
            title={e('copy')}
          />
        </div>
        <pre>
          <code className={className} {...rest}>
            {children}
          </code>
        </pre>
      </div>
    )
  }

  function handleToggleFlag () {
    window.store.updateAiHistoryEntry(item.id, { flagged: !item.flagged })
  }

  function renderFlag () {
    if (!enableAIFlag) {
      return null
    }
    return (
      <div className={'ai-stream-output-flag' + (item.flagged ? ' is-flagged' : '')}>
        <Popconfirm
          title={item.flagged ? 'Remove the harmful-info flag?' : 'Flag this as harmful info?'}
          okText='Confirm'
          cancelText='Cancel'
          onConfirm={handleToggleFlag}
        >
          <Button
            size='small'
            type='text'
            icon={item.flagged ? <FlagFilled /> : <FlagOutlined />}
            onClick={(evt) => evt.stopPropagation()}
          />
        </Popconfirm>
      </div>
    )
  }

  function renderBrand () {
    if (!brand) {
      return null
    }
    const nameLabel = nameAI || modelAI
    const label = nameLabel ? `${brand}:${nameLabel}` : brand
    return (
      <div className='pd1y'>
        <Link to={brandUrl}>
          <Tag>{label}</Tag>
        </Link>
      </div>
    )
  }

  // remark-gfm: react-markdown only does CommonMark by default, so GFM tables
  // (and strikethrough / task lists / autolinks) arrive as literal text.
  // Styling for the resulting table lives in ai.styl.
  const mdProps = {
    children: response,
    remarkPlugins: [remarkGfm],
    components: {
      code: renderCode
    }
  }

  return (
    <div className='ai-stream-output' ref={outputRef}>
      {renderFlag()}
      <div className='pd1'>
        {item.flagged && enableAIFlag
          ? <Alert type='warning' message='user flagged as harmful info' />
          : (
            <>
              {renderBrand()}
              <ReactMarkdown {...mdProps} />
              <div className='ai-output-actions'>
                <CopyIcon text={response} />
              </div>
            </>
            )}
      </div>
    </div>
  )
}
