/**
 * DBeaver data-sources.json 连接导入解析（N12b）
 *
 * DBeaver 的连接清单是 JSON（默认 ~/.local/share/DBeaverData/workspace6/General/.dbeaver/
 * data-sources.json），形状为：
 *   {
 *     "folders": { ... },
 *     "connections": {
 *       "<uuid>": {
 *         "provider": "mysql" | "postgresql" | "redis" | "sqlite" | ...,
 *         "driver": "mysql8",
 *         "name": "Local MySQL",
 *         "description": "...",
 *         "configuration": { "host": "..", "port": "3306", "database": "..",
 *                            "user": "..", "path": "/x.db (sqlite)", ... }
 *       }
 *     }
 *   }
 *
 * 与 Navicat .ncx 导入（navicat-ncx.js）同一产出契约：database bookmark 数组，
 * 由 bookmark-upload.js 复用既有 JSON 数组导入流程（自动建 imported_ 分组 + 判重）。
 *
 * 形状判定而不是扩展名判定：DBeaver 的文件就是 .json，与 electerm 自身导出
 * （{ bookmarks, bookmarkGroups }）同扩展名。electerm 导出**永远优先**走原路径，
 * 只有「connections 是对象映射且没有 bookmarks 键」才当 DBeaver 解。
 *
 * 密码**刻意不导入**：DBeaver 把凭据单独存在 credentials-config.json 里且加密
 * （PBE 派生密钥），data-sources.json 里根本没有明文密码——导入后密码留空由用户补填，
 * 不做凭据解密这步高风险动作。
 */

const providerMap = {
  mysql: 'mysql',
  postgresql: 'postgres',
  redis: 'redis',
  sqlite: 'sqlite'
}

// 与 src/client/common/constants.js 的 dbDefaultPortMap 保持一致
const dbPortFallbackMap = {
  mysql: 3306,
  postgres: 5432,
  redis: 6379
}

const isPlainObj = v => Object.prototype.toString.call(v) === '[object Object]'

/**
 * 形状判定：是 DBeaver data-sources.json 返回 true。
 * electerm 自身导出含 bookmarks 键 —— 永不判成 DBeaver。
 */
export function isDbeaverDataSources (data) {
  return Boolean(
    isPlainObj(data) &&
    isPlainObj(data.connections) &&
    !('bookmarks' in data)
  )
}

/**
 * 解析 DBeaver data-sources.json（已 JSON.parse 的对象）。
 * 不是 DBeaver 形状返回 null（调用方回落到原 JSON 导入路径）；
 * 是形状但一条可用连接都没有返回空数组。忽略不支持的 provider。
 */
export function parseDbeaverDataSources (data) {
  if (!isDbeaverDataSources(data)) {
    return null
  }
  const out = []
  for (const [id, conn] of Object.entries(data.connections)) {
    if (!isPlainObj(conn)) {
      continue
    }
    const dbType = providerMap[String(conn.provider || '').toLowerCase()]
    if (!dbType) {
      continue
    }
    const conf = isPlainObj(conn.configuration) ? conn.configuration : {}
    const base = {
      type: 'database',
      dbType,
      title: String(conn.name || conf.host || conf.path || id),
      description: String(conn.description || '')
    }
    if (dbType === 'sqlite') {
      // sqlite 是本地文件引擎（H8a）：没有 host/port，路径必填，
      // 没有路径的连接导进去也连不上，直接跳过
      const file = String(conf.path || conf.database || '').trim()
      if (!file) {
        continue
      }
      out.push({
        ...base,
        dbFile: file,
        // 与网络引擎一致：凭据位永远留空（sqlite 本地文件本无密码，
        // 但字段统一存在才不会在书签表单/导出比较里缺位）
        dbPassword: ''
      })
      continue
    }
    out.push({
      ...base,
      dbHost: String(conf.host || ''),
      dbPort: Number(conf.port) || dbPortFallbackMap[dbType],
      dbUser: String(conf.user || ''),
      // DBeaver 的密码不在本文件里（见文件头注释），永远留空
      dbPassword: '',
      // redis 的库号是运行时在键空间页切的，不是书签属性
      ...(dbType === 'redis' ? {} : { dbName: String(conf.database || '') })
    })
  }
  return out
}
