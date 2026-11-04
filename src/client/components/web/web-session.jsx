import AddressBar from './address-bar'
import WebAuthModal from './web-auth-modal'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { parseHeaderLines, buildCookieHeader, hasWebCustomHeaders } from './web-headers'

export default function WebSession (props) {
  const {
    tab,
    reloadTab
  } = props
  const [zoom, setZoom] = useState(1.0)
  const [authRequest, setAuthRequest] = useState(null)
  const webviewRef = useRef(null)
  const urlRegex = /^[a-z\d.+-]+:\/\/[^\s/$.?#].[^\s]*$/i

  const { url = '' } = tab
  const addrProps = {
    url,
    title: tab.title,
    description: tab.description,
    zoom,
    onZoom: handleZoom,
    // S1：web 页此前整类缺失全屏入口，地址栏右端补齐（与终端/DB 同组件同口径）
    onFullscreen: () => {
      window.store.activeTabId = tab.id
      window.store.toggleSessFullscreen(true, tab.id)
    },
    onOpen: () => {
      window.openLink(tab.url)
    },
    onReload: () => {
      reloadTab(
        tab
      )
    }
  }

  function handleZoom (v) {
    setZoom(v)
    const el = webviewRef.current
    if (!el) {
      return
    }
    if (el.setZoomFactor) {
      el.setZoomFactor(v)
    } else {
      el.style.zoom = v
    }
  }

  // Handle HTTP Basic Auth requests from webview
  useEffect(() => {
    if (!window.api || !window.api.onWebviewAuthRequest) {
      return
    }
    const removeListener = window.api.onWebviewAuthRequest((data) => {
      setAuthRequest(data)
    })
    return removeListener
  }, [])

  const handleAuthSubmit = useCallback((username, password) => {
    if (!authRequest) return
    window.api.sendWebviewAuthResponse({
      id: authRequest.id,
      username,
      password
    })
    setAuthRequest(null)
  }, [authRequest])

  const handleAuthCancel = useCallback(() => {
    if (!authRequest) return
    window.api.sendWebviewAuthResponse({
      id: authRequest.id,
      username: '',
      password: ''
    })
    setAuthRequest(null)
  }, [authRequest])

  // S2-5：自定义请求头 / Cookie 由主进程按 webContentsId 注入（同一个 session
  // 被所有 webview 共用，只能按 id 区分）。页面首跳发生在 webview 挂载之后，
  // 所以注入完成要 reload 一次，让这一跳也带上头；之后的导航自然带着。
  useEffect(() => {
    const el = webviewRef.current
    if (!el ||
      window.et.isWebApp ||
      !window.api ||
      !window.api.setWebviewHeaders ||
      !hasWebCustomHeaders(tab)) {
      return
    }
    const headers = parseHeaderLines(tab.webHeaders)
    const cookie = buildCookieHeader(tab.webCookies)
    let applied = false
    const apply = () => {
      if (applied) {
        return
      }
      let id = 0
      try {
        id = typeof el.getWebContentsId === 'function' ? el.getWebContentsId() : 0
      } catch (error) {
        // 还没 attach 到 DOM 时这个方法会抛，等下一次 dom-ready
        return
      }
      if (!id) {
        return
      }
      applied = true
      window.api.setWebviewHeaders({ id, headers, cookie })
      el.reload()
    }
    el.addEventListener('dom-ready', apply)
    return () => el.removeEventListener('dom-ready', apply)
  }, [tab.id, tab.webHeaders, tab.webCookies])

  // 打开webview的开发者工具
  // useEffect(() => {
  //   const webview = document.querySelector('webview')
  //   if (webview) {
  //     webview.addEventListener('dom-ready', () => {
  //       webview.openDevTools()
  //     })
  //   }
  // }, [])

  function renderView () {
    if (!urlRegex.test(tab.url)) {
      return (
        <div>
          URL: <b>{url}</b> not valid
        </div>
      )
    }
    if (window.et.isWebApp) {
      const iframeProps = {
        src: url,
        style: {
          width: '100%',
          height: '100%',
          border: 'none'
        }
      }
      return (
        <iframe {...iframeProps} ref={webviewRef} />
      )
    }
    const viewProps = {
      src: url,
      style: {
        width: '100%',
        height: '100%',
        background: '#fff'
      },
      disableblinkfeatures: 'true',
      disablewebsecurity: 'true',
      allowpopups: 'true',
      useragent: tab.useragent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    }
    return (
      <webview {...viewProps} ref={webviewRef} />
    )
  }

  return (
    <div className='web-session-wrap'>
      {!tab.hideAddressBar && (
        <AddressBar {...addrProps} />
      )}
      <div className='web-session-content'>
        {renderView()}
      </div>
      <WebAuthModal
        authRequest={authRequest}
        onAuthSubmit={handleAuthSubmit}
        onAuthCancel={handleAuthCancel}
      />
    </div>
  )
}
