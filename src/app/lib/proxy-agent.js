// common proxy agent creator
const SUPPORTED_SCHEMES = /^(https?|socks4|socks4a|socks5|socks5h|socks)$/i

// Bare `127.0.0.1:7890` is what users actually type; without a scheme it used to be
// dropped silently, so requests went out direct with no warning (#4464).
exports.normalizeProxyUrl = (raw) => {
  const url = typeof raw === 'string' ? raw.trim() : ''
  if (!url) return
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  if (scheme) {
    if (!SUPPORTED_SCHEMES.test(scheme[1])) {
      throw new Error(
        `Unsupported proxy protocol "${scheme[1]}", expected http://, https:// or socks5://`
      )
    }
    return url
  }
  if (/^[^\s/]+$/.test(url)) {
    return `http://${url}`
  }
  throw new Error(`Invalid proxy "${url}", expected host:port or http://host:port`)
}

exports.createProxyAgent = (url = '', extraOptions = {}) => {
  const target = exports.normalizeProxyUrl(url)
  if (!target) return
  const Cls = target.startsWith('socks')
    ? require('socks-proxy-agent').SocksProxyAgent
    : require('https-proxy-agent').HttpsProxyAgent
  return new Cls(target, {
    keepAlive: true,
    ...extraOptions
  })
}
