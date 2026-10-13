/**
 * Database browser session (phase2)
 * Opens a persistent per-tab connection, renders metadata tree + data grid + sql.
 */

import React, { useEffect, useState } from 'react'
import { Empty, Alert } from 'antd'
import './db-session.styl'

export default function DbSession (props) {
  const { tab } = props
  const tabId = tab.id
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  // Open the per-tab db connection on mount; close it when tab unmounts.
  useEffect(() => {
    let cancelled = false
    setReady(false)
    setError('')
    window.pre.runGlobalAsync('openDbTab', tab, null)
      .then(() => {
        if (cancelled) {
          return
        }
        return window.pre.runGlobalAsync('dbClientOp', tabId, 'getMetadata', {})
          .then(data => {
            if (!cancelled) {
              setReady(true)
            }
          })
      })
      .catch(err => {
        if (!cancelled) {
          setError(err && err.message ? err.message : String(err))
          setReady(false)
        }
      })
    return () => {
      cancelled = true
      window.pre.runGlobalAsync('closeDbTab', tabId).catch(() => {})
    }
  }, [tabId, tab])

  if (!ready) {
    return (
      <div className='db-session-wrap'>
        {error
          ? <Alert type='error' showIcon message={error} />
          : <div className='db-session-loading'>loading database...</div>}
      </div>
    )
  }

  return (
    <div className='db-session-wrap'>
      <Empty description='database browser' />
    </div>
  )
}
