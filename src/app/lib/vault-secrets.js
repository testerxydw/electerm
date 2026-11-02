/**
 * G6 阶段②：书签/配置里敏感字段的收集、封存与解开（设计 阶段4 §14.7）
 *
 * 这一层只做"形状"：哪些字段算敏感、怎么把一行的敏感字段收成一个 JSON、
 * 怎么把 JSON 装进 `_vault` 封套、怎么合并回来。加解密本身在 vault-crypto，
 * 库的开关状态与钥匙在 vault-instance —— 这里不读盘、不碰 electron。
 *
 * 三条口径：
 * - 一行只放一个封套（`_vault = { v, data }`），而不是每个字段一份，
 *   否则一行会多出六份 iv/tag，读回时还要逐份对齐；
 * - 空串不算"有凭据"：用户清空密码就该是清空，不封一个空串进库；
 * - 所有函数都不改入参。渲染层的 observable 对象会被就地改坏。
 */
const vc = require('../common/vault-crypto')

const SECRET_KEYS = [
  'password',
  'privateKey',
  'passphrase',
  'certificate',
  'dbPassword',
  'proxyPassword'
]

// 连接跳板里只可能有这四项（没有 dbPassword/proxyPassword）
const HOPPING_SECRET_KEYS = [
  'password',
  'privateKey',
  'passphrase',
  'certificate'
]

// 只处理这两张表：addressBookmarks 不在阶段②范围，quickCommands 无凭据字段
const SECRET_TABLES = new Set(['bookmarks', 'profiles'])

const VAULT_FIELD = '_vault'
const VAULT_VERSION = 1

function isFilled (value) {
  return typeof value === 'string' && value !== ''
}

function isObject (value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 收集明文敏感字段。
 * @returns {{top: object, hoppings: Array<object>}|null} 没有任何凭据时回 null
 */
function collectSecrets (row) {
  if (!isObject(row)) {
    return null
  }
  const top = {}
  let found = false
  for (const key of SECRET_KEYS) {
    if (isFilled(row[key])) {
      top[key] = row[key]
      found = true
    }
  }
  // 跳板数组按原长度保留空位，否则"第 2 个跳板有密码"会被压成"第 1 个"
  const hoppings = []
  if (Array.isArray(row.connectionHoppings)) {
    for (const hop of row.connectionHoppings) {
      const item = {}
      for (const key of HOPPING_SECRET_KEYS) {
        if (isObject(hop) && isFilled(hop[key])) {
          item[key] = hop[key]
          found = true
        }
      }
      hoppings.push(item)
    }
    if (hoppings.some(item => Object.keys(item).length)) {
      found = true
    }
  }
  return found ? { top, hoppings } : null
}

/**
 * 去掉明文敏感字段的副本；`_vault` 原样保留。
 */
function stripSecrets (row) {
  if (!isObject(row)) {
    return row
  }
  const next = { ...row }
  for (const key of SECRET_KEYS) {
    delete next[key]
  }
  if (Array.isArray(row.connectionHoppings)) {
    next.connectionHoppings = row.connectionHoppings.map(hop => {
      if (!isObject(hop)) {
        return hop
      }
      const copy = { ...hop }
      for (const key of HOPPING_SECRET_KEYS) {
        delete copy[key]
      }
      return copy
    })
  }
  return next
}

function hasSealed (row) {
  return isObject(row) && isObject(row[VAULT_FIELD]) &&
    typeof row[VAULT_FIELD].data === 'string' && row[VAULT_FIELD].data !== ''
}

/**
 * 把一行的明文敏感字段封进 `_vault`，并删掉明文。
 * 没有敏感字段时原样返回（不制造空封套）。
 * @throws 加解密出错时抛出，调用方决定是拒绝写入还是降级
 */
function sealRow (row, dek) {
  const secrets = collectSecrets(row)
  if (!secrets) {
    return row
  }
  const data = vc.sealSecret(JSON.stringify(secrets), dek)
  return {
    ...stripSecrets(row),
    [VAULT_FIELD]: { v: VAULT_VERSION, data }
  }
}

/**
 * 解开 `_vault` 并合并回明文。
 * 解密失败不抛：返回去掉明文的行 + error，绝不让上层误以为"没有凭据"。
 * @returns {{row: object, error: Error|null}}
 */
function openRow (row, dek) {
  if (!hasSealed(row)) {
    return { row, error: null }
  }
  let secrets = null
  try {
    // openSecret 回的是 { ok, value } | { ok:false, reason }，不是裸明文
    const opened = vc.openSecret(row[VAULT_FIELD].data, dek)
    if (!opened || !opened.ok) {
      return {
        row: stripSecrets(row),
        error: new Error('cannot open vault payload: ' + ((opened && opened.reason) || 'unknown'))
      }
    }
    secrets = JSON.parse(opened.value)
  } catch (e) {
    return { row: stripSecrets(row), error: e }
  }
  if (!isObject(secrets)) {
    return { row: stripSecrets(row), error: new Error('vault payload is not an object') }
  }
  const next = stripSecrets(row)
  delete next[VAULT_FIELD]
  if (isObject(secrets.top)) {
    for (const key of SECRET_KEYS) {
      if (isFilled(secrets.top[key])) {
        next[key] = secrets.top[key]
      }
    }
  }
  const hopSecrets = Array.isArray(secrets.hoppings) ? secrets.hoppings : []
  if (Array.isArray(next.connectionHoppings) && hopSecrets.length) {
    next.connectionHoppings = next.connectionHoppings.map((hop, index) => {
      const extra = hopSecrets[index]
      if (!isObject(hop) || !isObject(extra)) {
        return hop
      }
      const merged = { ...hop }
      for (const key of HOPPING_SECRET_KEYS) {
        if (isFilled(extra[key])) {
          merged[key] = extra[key]
        }
      }
      return merged
    })
  }
  return { row: next, error: null }
}

/**
 * 'sealed' 有封套 / 'plain' 有明文凭据 / 'empty' 两者都没有
 */
function rowState (row) {
  if (hasSealed(row)) {
    return 'sealed'
  }
  return collectSecrets(row) ? 'plain' : 'empty'
}

function secretCount (row) {
  const secrets = collectSecrets(row)
  if (!secrets) {
    return 0
  }
  let count = Object.keys(secrets.top).length
  for (const item of secrets.hoppings) {
    count += Object.keys(item).length
  }
  return count
}

module.exports = {
  SECRET_KEYS,
  HOPPING_SECRET_KEYS,
  SECRET_TABLES,
  VAULT_FIELD,
  collectSecrets,
  stripSecrets,
  hasSealed,
  sealRow,
  openRow,
  rowState,
  secretCount
}
