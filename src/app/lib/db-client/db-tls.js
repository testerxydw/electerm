/**
 * N1：数据库 TLS 档位（校验模式）的唯一口径。
 *
 * 为什么单独立一个模块：B1 当年为"内部自签"把 rejectUnauthorized 写死成 false，
 * 三个适配器各抄一份（mysql/pg/redis）。写死=无法关，等于对中间人不设防；
 * 而"改成可配置"这件事如果被抄成三份，三份的默认值、CA 读取失败的行为迟早漂移，
 * 漂移的结果是"某个引擎悄悄还在跳过校验"——这类问题只在真库+真证书时才暴露。
 * 所以：档位解析、CA 读取、连接签名标记全部只在这里实现一次，适配器只做封装形状差异
 * （mysql/pg 用 ssl 键、redis 用 tls 键）。
 *
 * 纯 node 依赖（fs/crypto），不 require log/electron，单测可直接 require。
 */

const fs = require('fs')
const crypto = require('crypto')

// 校验模式。'none' 是**兼容值**而不是推荐值：旧书签只有 dbSsl 布尔、没有模式字段，
// 一律按 none 解释，否则升级当天所有自签内网盘全部连不上。
const VERIFY_NONE = 'none'
const VERIFY_SYSTEM = 'system'
const VERIFY_CA = 'ca'

const VERIFY_MODES = [VERIFY_NONE, VERIFY_SYSTEM, VERIFY_CA]

/**
 * 归一校验模式：缺省/非法值 → 'none'（兼容旧书签，见文件头）。
 * @param {Object} conn 连接参数（书签摊平后的字段）
 * @returns {string} 'none' | 'system' | 'ca'
 */
function resolveVerifyMode (conn) {
  const v = String((conn && conn.dbSslVerify) || '').trim().toLowerCase()
  return VERIFY_MODES.includes(v) ? v : VERIFY_NONE
}

// CA 指纹：取内容的 sha1 前 8 位。用内容而不是路径，是为了让"路径没变但换了证书文件"
// 也能拿到新连接池——与 B1 当初"同 host:port 切开关必须换新池"是同一条理由。
function fingerprint (buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8)
}

/**
 * 解析 TLS 档位。**本函数不抛异常**：连接签名（sig）也要用它算标记，
 * 而 sig 在同步路径上、且被日志/调试引用，抛进去会让整个取池流程炸掉。
 * 读取失败只记录在返回值的 error 上，由选项构造函数在建连点抛出——
 * 那里是 async 调用链，错误会以连接失败的形式回到 UI。
 *
 * verifyIdentity：严格档位还要校验"证书是不是这个主机的"。不写这个键的话
 * 三个引擎会漂移：node（pg / ioredis 底层）在 rejectUnauthorized 为真时默认做
 * 身份校验，而 mysql2 **只有** 在 ssl.verifyIdentity 为真时才校验
 * （否则它把 checkServerIdentity 换成恒等于 undefined 的空函数）。
 * 结果就是"同样是系统根校验，MySQL 接受一张由合法 CA 签发但主机名不符的证书"
 * ——正是中间人攻击的形状。'none' 档不带该键（保持旧书签的行为与 mysql2 默认一致）。
 * IP 主机名不受影响：mysql2 对 IP 不传 servername，node 也对 IP 跳过身份校验，
 * 所以内网用 IP + 企业 CA 的连接不会因为这一位而连不上。
 *
 * @param {Object} conn 连接参数
 * @returns {Object|null} null=未启用 TLS；否则 { verify, rejectUnauthorized, verifyIdentity, ca, tag, error }
 */
function resolveTlsProfile (conn) {
  if (!conn || !conn.dbSsl) {
    return null
  }
  const verify = resolveVerifyMode(conn)
  if (verify === VERIFY_NONE) {
    // 显式选择"不校验"：仍然建立加密通道，但不验证证书链（自签内网场景）
    return {
      verify,
      rejectUnauthorized: false,
      verifyIdentity: false,
      ca: null,
      tag: '|ssl=1|v=none',
      error: null
    }
  }
  if (verify === VERIFY_SYSTEM) {
    // 不传 ca → 走系统根证书库；校验开启即 rejectUnauthorized: true
    return {
      verify,
      rejectUnauthorized: true,
      verifyIdentity: true,
      ca: null,
      tag: '|ssl=1|v=system',
      error: null
    }
  }
  const p = String((conn && conn.dbSslCa) || '').trim()
  if (!p) {
    return {
      verify,
      rejectUnauthorized: true,
      verifyIdentity: true,
      ca: null,
      tag: '|ssl=1|v=ca:empty',
      error: 'CA certificate file is not selected'
    }
  }
  let buf = null
  try {
    buf = fs.readFileSync(p)
  } catch (e) {
    // 路径带不进 tag（含 / 与 | 会破坏签名可读性），只标状态；细节在 error 里
    return {
      verify,
      rejectUnauthorized: true,
      verifyIdentity: true,
      ca: null,
      tag: '|ssl=1|v=ca:unreadable',
      error: `Cannot read CA certificate file: ${p} (${e.code || e.message})`
    }
  }
  return {
    verify,
    rejectUnauthorized: true,
    verifyIdentity: true,
    ca: buf,
    tag: `|ssl=1|v=ca:${fingerprint(buf)}`,
    error: null
  }
}

/**
 * 连接签名里的 TLS 标记。关闭时保持 B1 原样（'|ssl=0'），
 * 开启时把校验模式（CA 模式再带内容指纹）一起带上，保证
 * "改校验=换新池"。
 * @param {Object} conn 连接参数
 * @returns {string} 以 '|' 开头的标记串
 */
function tlsSigTag (conn) {
  const profile = resolveTlsProfile(conn)
  if (!profile) {
    return '|ssl=0'
  }
  return profile.tag
}

module.exports = {
  VERIFY_NONE,
  VERIFY_SYSTEM,
  VERIFY_CA,
  VERIFY_MODES,
  resolveVerifyMode,
  resolveTlsProfile,
  tlsSigTag
}
