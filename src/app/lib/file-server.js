module.exports = (app) => {
  const express = require('express')
  const path = require('path')

  return new Promise((resolve) => {
    const assetsPath = path.resolve(__dirname, '../assets')
    const conf = {
      // 产物文件名固定 (版本号命名, 无内容 hash), 强缓存会让升级后仍加载旧
      // bundle (HTTP 缓存 365 天) —— 曾致多次"必须清缓存才生效"。
      // 本地回环服务, 禁强缓存改协商缓存 (ETag 304), 更新即时生效
      maxAge: 0,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache')
      }
    }

    // Handle _temp_*.css files - return empty CSS to prevent MIME type errors
    app.use((req, res, next) => {
      if (req.url.startsWith('/css/_temp_') && req.url.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css')
        res.send('')
        return
      }
      next()
    })

    app.use(
      express.static(assetsPath, conf)
    )
  })
}
