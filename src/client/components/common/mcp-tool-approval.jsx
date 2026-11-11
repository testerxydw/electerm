import Modal from './modal'

// window.translate() falls back to the key name (capitalised), which would put
// "McpToolConfirmTitle" in a security dialog. Read the dictionary instead and
// use the English string until the locale package ships the key — same
// fail-open-to-English approach as mcp-transfer-approval.jsx.
const t = (key, fallback) => {
  const lang = typeof window.getLang === 'function' ? window.getLang() : null
  const val = lang && lang[key]
  return val || fallback
}

function trustText (trust) {
  if (trust === 'readonly') {
    return t('mcpToolTrustReadonly', 'trust level: read-only')
  }
  if (trust === 'auto') {
    return t('mcpToolTrustAuto', 'trust level: auto-approve')
  }
  return t('mcpToolTrustAsk', 'trust level: ask every time')
}

function reasonText (reason) {
  if (reason === 'trust-readonly-blocks-write') {
    return t(
      'mcpToolReasonReadonly',
      'This server is set to read-only, and the tool does not declare itself read-only. The call is blocked; you can only cancel.'
    )
  }
  if (reason === 'no-readonly-hint') {
    return t(
      'mcpToolReasonNoHint',
      'The tool does not declare itself read-only, so running it needs your approval.'
    )
  }
  if (reason === 'external-taint') {
    return t(
      'mcpToolReasonTaint',
      'This run has already read results from an external MCP server, so built-in write tools are confirmed one by one.'
    )
  }
  return ''
}

/**
 * Approval dialog for running a tool in the agent loop.
 *
 * Two gates share this dialog (design §3.4 / SEC-4 / SEC-5):
 *   - external MCP tools: `trust` policy + `annotations.readOnlyHint`
 *     (`decideToolApproval` in `common/external-tool-guard.js`);
 *   - built-in write tools after the run has been tainted by an external
 *     result (`requiresTaintApproval`, reason `external-taint`).
 *
 * When `reason` is `trust-readonly-blocks-write` the dialog intentionally has
 * **no approve button at all** (policy is read-only — offering "should I
 * allow it anyway?" would contradict the policy), only cancel.
 *
 * @param {object} spec
 * @param {string} spec.serverName validated server config name (meta.serverName)
 * @param {string} spec.toolName tool name shown to the user
 * @param {string} spec.trust 'readonly' | 'ask' | 'auto'
 * @param {boolean} spec.readOnlyHint the tool's annotations.readOnlyHint
 * @param {string} spec.reason reason code from the decision table
 * @returns {Promise<boolean>} true when the user approved
 */
export default function confirmExternalToolApproval ({
  serverName = '',
  toolName = '',
  trust = 'ask',
  readOnlyHint = false,
  reason = ''
}) {
  return new Promise((resolve) => {
    const blocked = reason === 'trust-readonly-blocks-write'
    const title = t('mcpToolConfirmTitle', 'Tool call needs your approval')
    const body = (
      <div className='mcp-transfer-confirm'>
        {!!serverName && (
          <div className='mcp-transfer-row'>
            <span className='mcp-transfer-label'>{t('mcpToolServer', 'Server')}</span>
            <span className='mcp-transfer-path'>{serverName}</span>
          </div>
        )}
        <div className='mcp-transfer-row'>
          <span className='mcp-transfer-label'>{t('mcpToolTool', 'Tool')}</span>
          <span className='mcp-transfer-path'>{toolName}</span>
        </div>
        <div className='mcp-transfer-row'>
          <span className='mcp-transfer-label'>{t('mcpToolTrust', 'Trust')}</span>
          <span className='mcp-transfer-path'>
            {trustText(trust)}
            {readOnlyHint ? ' · ' + t('mcpToolReadOnlyHint', 'declared read-only') : ''}
          </span>
        </div>
        {reasonText(reason)
          ? <div className='mcp-transfer-warn'>{reasonText(reason)}</div>
          : null}
      </div>
    )
    Modal.confirm({
      title,
      content: body,
      width: 520,
      // 不可放行态：不渲染 OK（策略是只读，不出现"要不要放行"的选择题）。
      // antd 不提供"隐藏默认 OK"的一等开关，用 display:none 收掉按钮，
      // 同时不给 onOk —— 双保险，任何路径都 resolve(false)。
      okButtonProps: blocked ? { style: { display: 'none' } } : undefined,
      okText: blocked ? undefined : t('ok', 'OK'),
      cancelText: t('cancel', 'Cancel'),
      onOk: blocked ? undefined : () => resolve(true),
      onCancel: () => resolve(false)
    })
  })
}
