const { describe, test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

// N1（TLS 证书校验档位）唯一口径的行为守护。
// 为什么单独立一份而不并进 db-ssl-contract.spec.js：那份钉的是"三个适配器有没有
// 正确用上这个口径"（源码契约 + vm 里跑函数体），这份钉的是口径本身。档位解析错了，
// 三个适配器会一起错，那时"跨引擎一致"照样成立，但连接已经不安全/连不上。
//
// 这里最贵的两条是：
//   - 缺省必须是 none（旧书签只有 dbSsl 布尔；默认成 system 会让升级当天内网盘全连不上）
//   - CA 读不到时**不降级**成不校验（静默降级 = 用户以为有校验）
const tls = require(path.join(__dirname, '../../../src/app/lib/db-client/db-tls'))

const {
  VERIFY_MODES,
  resolveVerifyMode,
  resolveTlsProfile,
  tlsSigTag
} = tls

let tmpDir = ''

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-tls-'))
})

after(() => {
  // 直删，不转回收站（AGENTS.md：可再生产物）
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const writeCa = (name, content) => {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, content)
  return p
}

describe('N1 resolveVerifyMode：档位归一', () => {
  test('三档值域就是文档与表单用的那三个字符串', () => {
    assert.deepEqual([...VERIFY_MODES].sort(), ['ca', 'none', 'system'])
  })

  test('缺省/空/非法值一律按 none（旧书签兼容线，动了就会打断存量连接）', () => {
    for (const v of [undefined, '', '   ', 'strict', 'full', 'system-ca', null]) {
      assert.equal(resolveVerifyMode({ dbSslVerify: v }), 'none', `${String(v)} 应回落 none`)
    }
    assert.equal(resolveVerifyMode({}), 'none', '整个字段缺失应回落 none')
    assert.equal(resolveVerifyMode(), 'none', 'conn 本身缺失也不能抛')
  })

  test('大小写与首尾空格不影响识别（手填/迁移脚本写的值也要能用）', () => {
    assert.equal(resolveVerifyMode({ dbSslVerify: ' SYSTEM ' }), 'system')
    assert.equal(resolveVerifyMode({ dbSslVerify: 'Ca' }), 'ca')
  })
})

describe('N1 resolveTlsProfile：档位 → 连接选项', () => {
  test('未开启 TLS 返回 null（关断时不给任何 ssl/tls 键）', () => {
    assert.equal(resolveTlsProfile({}), null)
    assert.equal(resolveTlsProfile({ dbSsl: false, dbSslVerify: 'system' }), null)
    assert.equal(resolveTlsProfile(null), null)
  })

  test('none：建加密通道但不校验证书链', () => {
    const p = resolveTlsProfile({ dbSsl: true, dbSslVerify: 'none' })
    assert.equal(p.rejectUnauthorized, false)
    // 不验链的档位当然也不验名，且不能带这个键（旧书签的 mysql2 选项形状保持不变）
    assert.equal(p.verifyIdentity, false)
    assert.equal(p.ca, null)
    assert.equal(p.error, null)
    assert.equal(p.tag, '|ssl=1|v=none')
  })

  test('system：校验开启且不传 ca（走系统根证书库）', () => {
    const p = resolveTlsProfile({ dbSsl: true, dbSslVerify: 'system' })
    assert.equal(p.rejectUnauthorized, true)
    assert.equal(p.ca, null, '传了 ca 就变成"只用这个 CA"，会把公共证书链一起否掉')
    assert.equal(p.error, null)
    assert.equal(p.tag, '|ssl=1|v=system')
  })

  // mysql2 的独有口径：node 系（pg / ioredis 底层）在 rejectUnauthorized 为真时
  // 默认校验证书身份，mysql2 却把 checkServerIdentity 换成恒返回 undefined 的空函数，
  // 除非显式给 ssl.verifyIdentity。不在这里统一，"同样的严格档位"在 MySQL 上
  // 会接受一张由合法 CA 签发、但属于别的主机的证书——中间人形状。
  test('严格档位（system / ca）一律要求校验证书身份', () => {
    const ca = writeCa('verify-identity.pem', 'CERT-BODY')
    for (const conn of [
      { dbSsl: true, dbSslVerify: 'system' },
      { dbSsl: true, dbSslVerify: 'ca', dbSslCa: ca },
      { dbSsl: true, dbSslVerify: 'ca', dbSslCa: path.join(tmpDir, 'nope.pem') }
    ]) {
      assert.equal(resolveTlsProfile(conn).verifyIdentity, true, JSON.stringify(conn))
    }
    assert.equal(resolveTlsProfile({ dbSsl: true }).verifyIdentity, false, '缺省档位不验名（兼容旧书签）')
  })

  test('ca 缺文件路径：报错而不是退回不校验', () => {
    for (const v of ['', '   ', undefined]) {
      const p = resolveTlsProfile({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: v })
      assert.equal(p.rejectUnauthorized, true, '没有 CA 也不能把连接降级成明文信任')
      assert.equal(p.ca, null)
      assert.match(p.error, /not selected/)
    }
  })

  test('ca 文件读不到：错误里带路径与原因，且不降级', () => {
    const missing = path.join(tmpDir, 'nope.pem')
    const p = resolveTlsProfile({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: missing })
    assert.equal(p.rejectUnauthorized, true)
    assert.equal(p.ca, null)
    assert.ok(p.error.includes(missing), `错误要能定位到是哪个文件：${p.error}`)
    assert.match(p.error, /ENOENT/)
    // 目录当 CA 传（用户选错对象）也只是可读性问题，同样不降级
    const dirProfile = resolveTlsProfile({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: tmpDir })
    assert.equal(dirProfile.ca, null)
    assert.ok(dirProfile.error)
  })

  test('ca 文件可读：原样交给驱动的 ca（Buffer，PEM 内容由 node 解析）', () => {
    const content = '-----BEGIN CERTIFICATE-----\nMIIBmock\n-----END CERTIFICATE-----\n'
    const p = writeCa('ca.pem', content)
    const r = resolveTlsProfile({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: p })
    assert.equal(r.error, null)
    assert.equal(r.rejectUnauthorized, true)
    assert.ok(Buffer.isBuffer(r.ca), '必须是 Buffer：字符串会被当成 PEM 文本而不是文件')
    assert.equal(r.ca.toString('utf8'), content)
  })

  test('路径两端空白不影响读取；带引号只报错、不降级', () => {
    const p = writeCa('ca2.pem', 'PEM2')
    for (const v of [`  ${p}  `, `\t${p}\n`]) {
      const r = resolveTlsProfile({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: v })
      assert.equal(r.error, null, `${JSON.stringify(v)} 应能读到`)
      assert.equal(r.ca.toString('utf8'), 'PEM2')
    }
    // 成对引号由表单失焦时归一（见 client/common/db-file.js 的 normalizeDbFilePath），
    // 主进程不再重复剥一层；这里钉的是"漏网时绝不静默当成不校验档"
    const quoted = resolveTlsProfile({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: `"${p}"` })
    assert.equal(quoted.ca, null)
    assert.equal(quoted.rejectUnauthorized, true)
    assert.ok(quoted.error)
  })

  test('本函数不抛异常：sig 走同步路径，抛出会炸掉取池', () => {
    // 不存在的路径 + 一个会 require 失败的对象形状，全都只能变成 error 字段
    assert.doesNotThrow(() => resolveTlsProfile({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: '/no/such/ca.pem' }))
    assert.doesNotThrow(() => resolveTlsProfile({ dbSsl: true, dbSslVerify: 123 }))
    assert.doesNotThrow(() => resolveTlsProfile({ dbSsl: 'yes', dbSslVerify: 'ca' }))
  })
})

describe('N1 tlsSigTag：档位与证书内容进连接签名（改了必须换新池）', () => {
  test('关闭 TLS 时标记与 B1 完全一致，且忽略档位字段', () => {
    assert.equal(tlsSigTag({}), '|ssl=0')
    assert.equal(tlsSigTag({ dbSsl: false, dbSslVerify: 'system', dbSslCa: '/x/ca.pem' }), '|ssl=0')
  })

  test('三个档位三个不同标记（同 host:port 切档位复用旧池=改了不生效）', () => {
    const ca = writeCa('ca3.pem', 'PEM3')
    const tags = [
      tlsSigTag({ dbSsl: true, dbSslVerify: 'none' }),
      tlsSigTag({ dbSsl: true, dbSslVerify: 'system' }),
      tlsSigTag({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: ca })
    ]
    assert.equal(new Set(tags).size, 3, `档位标记需互不相同：${tags.join(' ')}`)
  })

  test('同一份 conn 重复取标记必须稳定（否则池永不复用）', () => {
    const ca = writeCa('ca4.pem', 'PEM4')
    const conn = { dbSsl: true, dbSslVerify: 'ca', dbSslCa: ca }
    assert.equal(tlsSigTag(conn), tlsSigTag(conn))
  })

  test('CA 内容变了标记就变（换证书文件、路径没变也要换新池）', () => {
    const p = path.join(tmpDir, 'rotate.pem')
    fs.writeFileSync(p, 'OLD-CERT')
    const tagOld = tlsSigTag({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: p })
    fs.writeFileSync(p, 'NEW-CERT')
    const tagNew = tlsSigTag({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: p })
    assert.notEqual(tagOld, tagNew, '标记按内容算，不是按路径算')
    // 标记里是内容指纹，不含路径本身（路径含 | 或 / 会破坏签名可读性）
    assert.ok(!tagOld.includes(tmpDir), tagOld)
    const fp = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)
    assert.equal(tagOld, '|ssl=1|v=ca:' + fp('OLD-CERT'))
    assert.equal(tagNew, '|ssl=1|v=ca:' + fp('NEW-CERT'))
  })

  test('CA 不可读时标记仍给出可区分状态（sig 不能因此抛异常）', () => {
    assert.equal(tlsSigTag({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: '' }), '|ssl=1|v=ca:empty')
    assert.equal(
      tlsSigTag({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: path.join(tmpDir, 'missing.pem') }),
      '|ssl=1|v=ca:unreadable'
    )
  })

  test('标记不含密码等敏感信息（签名会进日志/调试输出）', () => {
    const tag = tlsSigTag({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: writeCa('ca5.pem', 'PEM5') })
    assert.ok(!/PEM5|p@ssw0rd/.test(tag))
  })
})
