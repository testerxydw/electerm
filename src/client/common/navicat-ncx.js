/**
 * Navicat .ncx 连接文件解析 + 密码解密
 *
 * .ncx 为 Navicat 导出的 XML, 每个连接是一个全属性的单层 <Connection> 标签:
 *   <Connection ConnectionName=".." ConnType="MYSQL|REDIS" Host=".." Port=".."
 *     UserName=".." Password="hex密文" Remarks=".." />
 *
 * 密码加密 (Navicat 12~17, 含 16/17): 密文字段为 hex 字符串,
 * AES-128-CBC, 固定 key/iv, PKCS7 padding。
 * Navicat 11 及以下的 Blowfish 方案暂不支持 (如需再扩展)。
 *
 * 使用 WebCrypto (crypto.subtle): renderer (Chromium) 与 node 22 单测均可运行,
 * 项目 renderer 无 nodeIntegration, 不能用 node:crypto。
 */

const NCX_KEY = new TextEncoder().encode('libcckeylibcckey')
const NCX_IV = new TextEncoder().encode('libcciv libcciv ')

// 与 src/client/common/constants.js 的 dbDefaultPortMap 保持一致
// (constants.js 顶层依赖 window, 此处无法导入)
const dbPortFallbackMap = {
  mysql: 3306,
  redis: 6379
}

const connTypeMap = {
  MYSQL: 'mysql',
  REDIS: 'redis'
}

const xmlEntityMap = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&amp;': '&'
}

function decodeXmlEntities (str = '') {
  return str.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, s => xmlEntityMap[s])
}

/**
 * 解密 Navicat 密码 (hex 密文)。非法 hex 原样返回 (视作未加密明文),
 * 解密失败 (padding 校验不过) 返回空串, 由上层决定是否提示。
 */
export async function decryptNavicatPassword (hex = '') {
  if (!/^[0-9a-fA-F]{2,}$/.test(hex) || hex.length % 2 !== 0) {
    return hex
  }
  const data = new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)))
  const key = await crypto.subtle.importKey(
    'raw', NCX_KEY, { name: 'AES-CBC' }, false, ['decrypt']
  )
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: NCX_IV }, key, data
    )
    return new TextDecoder().decode(plain)
  } catch (e) {
    return ''
  }
}

/**
 * 解析 .ncx 文本, 返回 electerm database bookmark 数组
 * (type: 'database'), 忽略非 MySQL/Redis 连接。
 */
export async function parseNcx (txt = '') {
  const out = []
  const connRe = /<Connection\s+([^>]+?)\/?>/g
  const attrRe = /([A-Za-z][\w]*)="([^"]*)"/g
  let m
  while ((m = connRe.exec(txt))) {
    const attrs = {}
    let a
    while ((a = attrRe.exec(m[1]))) {
      attrs[a[1]] = decodeXmlEntities(a[2])
    }
    const dbType = connTypeMap[(attrs.ConnType || '').toUpperCase()]
    if (!dbType) {
      continue
    }
    const dbPassword = await decryptNavicatPassword(attrs.Password || '')
    out.push({
      type: 'database',
      dbType,
      dbHost: attrs.Host || '',
      dbPort: Number(attrs.Port) || dbPortFallbackMap[dbType],
      dbUser: attrs.UserName || '',
      dbPassword,
      title: attrs.ConnectionName || attrs.Host || dbType,
      description: attrs.Remarks || ''
    })
  }
  return out
}
