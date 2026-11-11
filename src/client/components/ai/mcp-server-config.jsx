import { useState } from 'react'
import { Badge, Button, Input, InputNumber, Select, Switch } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import copy from 'json-deep-copy'
import Modal from '../common/modal'
import {
  validateMcpServerDraft,
  newServerDraft,
  newServerId,
  trustBadgeMeta,
  TRUST_LEVELS,
  DEFAULT_MCP_TRUST
} from '../../common/mcp-server-form-validate'
import { mcpStatusText } from '../../common/mcp-status-text'

const e = window.translate

const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }
const fieldStyle = { marginBottom: 6 }
const errStyle = { color: '#cf1322', fontSize: 12, lineHeight: '16px' }

// SEC-12：trust 三态 → 徽章文案（映射本体在 mcp-server-form-validate.js，
// 纯函数可测；这里只消费）
function TrustBadge ({ trust }) {
  const meta = trustBadgeMeta(trust)
  return (
    <Badge
      color={meta.color}
      text={
        <span className='mcp-trust-badge'>
          {meta.warn ? <ExclamationCircleOutlined style={{ color: '#fa8c16', marginRight: 2 }} /> : null}
          {meta.text}
        </span>
      }
    />
  )
}

// 状态徽章：数据来自 mcpClientState（同步缓存，Refresh 后随本地 re-render 更新）。
// 文案走纯函数 mcpStatusText（设计 §2.9：failed → 失败 + lastError，
// degraded → 不稳定 + lastError），图标/颜色留在这里（依赖 antd）。
function statusMeta (st) {
  if (!st) return null
  const { text } = mcpStatusText(st, e)
  if (st.state === 'ready') {
    return { icon: <CheckCircleOutlined style={{ color: '#52c41a' }} />, text }
  }
  if (st.state === 'failed') {
    return { icon: <CloseCircleOutlined style={{ color: '#ff4d4f' }} />, text }
  }
  if (st.state === 'degraded') {
    // 不稳定不是死：给橙色感叹号，不误导成「失败」
    return { icon: <ExclamationCircleOutlined style={{ color: '#fa8c16' }} />, text }
  }
  return { icon: null, text }
}

// 需要「重试」按钮的状态：机器已经起不来（failed）或半死不活（degraded）
function canRetryState (state) {
  return !!state && (state.state === 'failed' || state.state === 'degraded')
}

/**
 * MCP servers 分节（设计 §2.9，T05）· 自管状态，不参与 AI 配置表单提交：
 * 保存走 `store.setConfig({ mcpServersAI })` + `store.mcpClientSyncConfig`
 * （保存后对齐连接，主进程按 signature 决定是否重连）。
 *
 * 覆盖判据：
 *   - T05-01：增删改 server + 非法字段**就地报错**（校验借
 *     mcp-server-form-validate，文案与主进程 errorOf 对齐，一致性由对照 spec 钉）；
 *   - T05-02：Refresh tools 按钮 → `mcpClientRefresh()`（force:true，后端
 *     恰好重拉 tools/list，M26）→ 状态徽章与工具计数随 mcpClientState 更新；
 *   - T04-09（SEC-12）：三态信任徽章；新增默认 trust 来自常量 `ask`；
 *     切到 auto 需二次确认（「写操作将不再询问」）；
 *   - T04-04（M6c/SEC-12-②）：`auto` 风险文案与徽章并存——常驻**固定提示区**
 *     三句（stdio 等价本地执行 SEC-9 / auto 后果 SEC-12-② / 凭据口径 SEC-6），
 *     不可折叠。
 */
export default function McpServersSection () {
  const [servers, setServers] = useState(() => readServers())
  const [draft, setDraft] = useState(null)
  const [draftIndex, setDraftIndex] = useState(-1)
  const [draftErrors, setDraftErrors] = useState([])
  const [refreshing, setRefreshing] = useState(false)
  // 正在重连的 server id（按钮 loading 用）；null = 空闲
  const [retrying, setRetrying] = useState(null)

  function readServers () {
    const list = window.store && window.store.config && window.store.config.mcpServersAI
    return Array.isArray(list) ? copy(list) : []
  }

  async function persist (list) {
    setServers(list)
    if (window.store && typeof window.store.setConfig === 'function') {
      window.store.setConfig({ mcpServersAI: list })
    }
    // setConfig 只改渲染层内存；主进程 config（mcpClientGetTools 的
    // readServers 数据源）平时靠 autoRun(debounce 100ms) 的 saveUserConfig
    // 异步落盘。这里显式同步一次，否则紧随的 GetTools 读到旧 config →
    // syncConfig([]) 按空列表把刚建立的连接拆掉，徽章永远空
    // （实机探针抓到的第二个竞态：syncConfig 直接回传 ready，但 GetTools 空）。
    if (window.pre && typeof window.pre.runGlobalAsync === 'function') {
      await window.pre.runGlobalAsync('saveUserConfig', window.store.config)
    }
    if (window.store && typeof window.store.mcpClientSyncConfig === 'function') {
      await window.store.mcpClientSyncConfig(list)
    }
    // syncConfig 只触发主进程按 signature 重连，**不回传状态**；
    // mcpServerStates（徽章数据源）只在 mcpClientGetTools 的结果里更新，
    // 所以保存/启停后必须拉一次，否则 ready/toolCount 徽章永远空
    // （实机探针抓到：单元 spec 只钉了调用链，没测状态最终到达 UI）。
    if (window.store && typeof window.store.mcpClientGetTools === 'function') {
      await window.store.mcpClientGetTools()
    }
  }

  function startAdd () {
    setDraftIndex(-1)
    setDraftErrors([])
    // 默认 trust 来自代码常量（T04-09），不沿用列表里上一条的设置
    setDraft(newServerDraft(servers))
  }

  function startEdit (index) {
    setDraftIndex(index)
    setDraftErrors([])
    const copyDraft = copy(servers[index])
    // 兼容旧配置：修复前保存的条目 id 是空串（或根本没有）。这里在编辑时
    // 补一个，下一次保存即写回 config——否则这条 server 永远走主进程的
    // 现场生成 id 路径（每次校验换 id → 每次重连 + 徽章不渲染）。
    if (!copyDraft.id) {
      copyDraft.id = newServerId()
    }
    setDraft(copyDraft)
  }

  function setField (field, value) {
    setDraft(d => ({ ...d, [field]: value }))
  }

  function closeDraft () {
    setDraft(null)
    setDraftIndex(-1)
    setDraftErrors([])
  }

  async function saveDraft () {
    const { errors } = validateMcpServerDraft(draft)
    if (errors.length) {
      // T05-01 就地报错：不弹全局提示，错误落在对应字段下
      setDraftErrors(errors)
      return
    }
    const finalDraft = {
      ...copy(draft),
      args: Array.isArray(draft.args) ? draft.args : String(draft.args || '').split('\n').filter(x => x !== '')
    }
    const list = copy(servers)
    if (draftIndex >= 0) {
      list[draftIndex] = finalDraft
    } else {
      list.push(finalDraft)
    }
    await persist(list)
    closeDraft()
  }

  function changeTrust (value) {
    if (value === 'auto' && draft.trust !== 'auto') {
      // SEC-12：切 auto 需二次确认——「该 server 的写操作将不再询问」
      Modal.confirm({
        title: e('mcpTrustAutoConfirm'),
        content: e('mcpTrustAutoConfirmText'),
        okText: e('ok'),
        cancelText: e('cancel'),
        onOk: () => setField('trust', 'auto')
      })
      return
    }
    setField('trust', value)
  }

  async function handleRefresh () {
    setRefreshing(true)
    try {
      if (window.store && typeof window.store.mcpClientRefresh === 'function') {
        // T05-02：force=true，后端恰好重拉 tools/list（M26）
        await window.store.mcpClientRefresh()
      }
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * 单台 server 重连（设计 §2.9：failed 状态给「重试」按钮）。
   * 走 mcpClientRestart → 主进程按 id 杀旧 session 重新 spawn，store 侧
   * 随后自动 force 重拉 tools；这里再显式拉一次并回读配置，确保徽章在
   * 本次交互内刷新（mcpServerStates 只在 GetTools 结果里更新）。
   */
  async function handleRetry (index) {
    const server = servers[index]
    const id = server && server.id
    // 没有 id 就无法定位 session（主进程按 id 找），直接放弃
    if (!id) {
      return
    }
    setRetrying(id)
    try {
      if (window.store && typeof window.store.mcpClientRestart === 'function') {
        await window.store.mcpClientRestart(id)
      }
      if (window.store && typeof window.store.mcpClientGetTools === 'function') {
        await window.store.mcpClientGetTools({ force: true })
      }
      // 重新从 store 读配置，触发一次渲染让新状态落到徽章上
      setServers(copy(readServers()))
    } finally {
      setRetrying(null)
    }
  }

  function renderDraftForm () {
    if (!draft) return null
    const errOf = field => draftErrors.find(x => x.field === field)
    const errNode = field => {
      const err = errOf(field)
      return err ? <div style={errStyle}>{err.message}</div> : null
    }
    return (
      <div style={{ padding: '6px 0 6px 12px', borderTop: '1px dashed #d9d9d9' }}>
        <div style={fieldStyle}>
          <div>{e('name')}</div>
          <Input
            value={draft.name}
            onChange={ev => setField('name', ev.target.value)}
            placeholder='fs'
          />
          {errNode('name')}
        </div>
        <div style={fieldStyle}>
          <div>{e('transport')}</div>
          <Select
            value={draft.transport}
            onChange={v => setField('transport', v)}
            style={{ width: 160 }}
            options={[
              { value: 'stdio', label: 'stdio' },
              { value: 'http', label: 'http' }
            ]}
          />
          {errNode('transport')}
        </div>
        {draft.transport === 'stdio'
          ? (
            <div style={fieldStyle}>
              <div>command</div>
              <Input
                value={draft.command}
                onChange={ev => setField('command', ev.target.value)}
                placeholder='npx'
              />
              {errNode('command')}
              <div style={{ marginTop: 4 }}>args ({e('oneArgPerLine') || 'one arg per line'})</div>
              <Input.TextArea
                rows={2}
                value={Array.isArray(draft.args) ? draft.args.join('\n') : String(draft.args || '')}
                onChange={ev => setField('args', ev.target.value.split('\n'))}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/tmp'}
              />
            </div>
            )
          : (
            <div style={fieldStyle}>
              <div>url</div>
              <Input
                value={draft.url}
                onChange={ev => setField('url', ev.target.value)}
                placeholder='http://127.0.0.1:3000/mcp'
              />
              {errNode('url')}
            </div>
            )}
        <div style={fieldStyle}>
          <div>timeout (ms)</div>
          <InputNumber
            value={draft.timeoutMs}
            onChange={v => setField('timeoutMs', v)}
            min={1000}
            step={1000}
          />
          {errNode('timeoutMs')}
        </div>
        <div style={fieldStyle}>
          <div>{e('trust') || 'trust'}</div>
          <Select
            value={draft.trust}
            onChange={changeTrust}
            style={{ width: 160 }}
            options={TRUST_LEVELS.map(t => ({ value: t, label: t }))}
          />
          {errNode('trust')}
          {draft.trust === 'auto'
            ? (
              <div style={{ ...errStyle, color: '#ad6800' }}>
                {e('mcpTrustAutoInlineWarn') || 'Tool calls of this server (including writes) will no longer ask.'}
              </div>
              )
            : null}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size='small' type='primary' onClick={saveDraft}>{e('save')}</Button>
          <Button size='small' onClick={closeDraft}>{e('cancel')}</Button>
        </div>
      </div>
    )
  }

  const serverStates = (window.store && typeof window.store.mcpClientState === 'function')
    ? window.store.mcpClientState()
    : []

  return (
    <div className='mcp-server-config-section'>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>MCP servers</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* 接线检查（非行为断言）：按钮必须调 mcpClientRefresh（force 重拉），
              行为语义由 M26 与 mcp-server-config.spec.js 的 store 面 spec 钉 */}
          <Button size='small' onClick={handleRefresh} loading={refreshing}>
            Refresh tools
          </Button>
          <Button size='small' type='primary' onClick={startAdd}>{e('new')}</Button>
        </div>
      </div>

      {/* 固定提示区（常驻，不可折叠）——SEC-9 / SEC-12-② / SEC-6 三句缺一不可 */}
      <div
        className='mcp-fixed-hints'
        style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 4, padding: '4px 8px', margin: '4px 0', fontSize: 12, lineHeight: '18px' }}
      >
        <div>1. {e('mcpHintStdio') || 'stdio servers run commands on this machine as your user; only add servers you trust.'}</div>
        <div>2. {e('mcpHintAuto') || 'When trust is auto-approve, tool calls of that server (including writes) will no longer ask.'}</div>
        <div>3. {e('mcpHintCredential') || 'Server credentials are stored with the same scheme as other local secrets; without a system keyring they are saved as marked plaintext.'}</div>
      </div>

      {servers.map((server, index) => {
        // 徽章按 id 匹配：渲染层必须已给 server 分配 id（newServerDraft 里
        // 的 newServerId），否则主进程现场生成的 id 永远对不上，徽章不渲染。
        const serverState = serverStates.find(s => s && s.id === server.id)
        const st = statusMeta(serverState)
        return (
          <div key={server.id || `idx-${index}`}>
            <div style={rowStyle}>
              <Switch
                size='small'
                checked={server.enabled !== false}
                onChange={checked => {
                  const list = copy(servers)
                  list[index] = { ...list[index], enabled: checked }
                  persist(list)
                }}
              />
              <span style={{ fontWeight: 500 }}>{server.name || server.id}</span>
              <span>{server.transport}</span>
              <TrustBadge trust={server.trust} />
              {st ? <span className='mcp-status'>{st.icon}{st.text}</span> : null}
              <span style={{ flex: 1 }} />
              {canRetryState(serverState)
                ? (
                  <Button
                    size='small'
                    className='mcp-retry-btn'
                    loading={retrying === server.id}
                    onClick={() => handleRetry(index)}
                  >
                    {e('retry')}
                  </Button>
                  )
                : null}
              <Button size='small' onClick={() => startEdit(index)}>{e('edit')}</Button>
              <Button
                size='small'
                danger
                onClick={() => persist(servers.filter((_, i) => i !== index))}
              >
                {e('del')}
              </Button>
            </div>
            {draftIndex === index ? renderDraftForm() : null}
          </div>
        )
      })}

      {draftIndex === -1 && draft ? renderDraftForm() : null}
      <div style={{ color: '#888', fontSize: 12 }}>
        {`default trust: ${DEFAULT_MCP_TRUST}`}
      </div>
    </div>
  )
}
