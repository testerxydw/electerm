// D 批 Redis 类型化写编排 handler（cluster #12 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：runRedisWrite 与 9 个类型化写入口逐字不改；页面级 state / 回调由 owner 注入。
import message from '../common/message'
import { showErrorModal } from '../common/error-modal'
import { redisWrite } from '../../common/db-redis-write'

const e = window.translate

export function useDbRedisWrite ({
  tabId,
  isProduction,
  redisDb,
  redisKey,
  redisDetail,
  redisAdd,
  setRedisAdd,
  redisEdit,
  setRedisEdit,
  keyList,
  renameInput,
  setRenameOpen,
  setRenameInput,
  setRedisKey,
  selectRedisKey,
  loadRedisKeys,
  confirmRedisWrite
}) {
  // ---- D 批：Redis 类型化写（T12） ----

  // 统一执行：成功/失败都刷新详情与键列表（redisWrite 纪律），这里只补
  // 成功提示与失败 toast。返回 { ok } 而不 rethrow，调用方按 ok 决定收尾。
  // gate 为 production 连接的生产闸门（{ level, text, note }）：非 production 时忽略，
  // 命中则先弹 confirmRedisWrite，取消 = 零执行（{ ok: false }）
  const runRedisWrite = (op, params, successMsg, gate) => {
    const doWrite = () => redisWrite(tabId, op, params, {
      refresh: () => {
        selectRedisKey(redisKey)
        loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
      }
    }).then(res => {
      if (successMsg) {
        message.success(successMsg)
      }
      return { ok: true, res }
    }).catch(err => {
      showErrorModal({ error: err })
      return { ok: false }
    })
    if (gate && isProduction) {
      return confirmRedisWrite(gate).then(ok => (ok ? doWrite() : { ok: false }))
    }
    return doWrite()
  }

  const addHashField = () => {
    const field = redisAdd.field.trim()
    if (!field) {
      return
    }
    runRedisWrite('hashSetField', {
      dbIndex: redisDb, key: redisKey, field, value: redisAdd.value
    }, e('saved'), {
      level: 'write',
      text: 'HSET ' + redisKey + ' ' + field,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisAdd(s => ({ ...s, field: '', value: '' }))
      }
    })
  }

  const addMember = () => {
    const member = redisAdd.member.trim()
    if (!member) {
      return
    }
    if (redisDetail && redisDetail.type === 'zset') {
      runRedisWrite('zsetAdd', {
        dbIndex: redisDb, key: redisKey, score: redisAdd.score, member
      }, e('saved'), {
        level: 'write',
        text: 'ZADD ' + redisKey + ' ' + redisAdd.score + ' ' + member,
        note: e('saved')
      }).then(r => {
        if (r.ok) {
          setRedisAdd(s => ({ ...s, member: '', score: '' }))
        }
      })
    } else {
      runRedisWrite('setAdd', {
        dbIndex: redisDb, key: redisKey, members: [member]
      }, e('saved'), {
        level: 'write',
        text: 'SADD ' + redisKey + ' ' + member,
        note: e('saved')
      }).then(r => {
        if (r.ok) {
          setRedisAdd(s => ({ ...s, member: '' }))
        }
      })
    }
  }

  const pushList = (position) => {
    if (redisAdd.listValue === '') {
      return
    }
    runRedisWrite('listPush', {
      dbIndex: redisDb, key: redisKey, value: redisAdd.listValue, position
    }, e('saved'), {
      level: 'write',
      text: (position === 'left' ? 'LPUSH ' : 'RPUSH ') + redisKey,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisAdd(s => ({ ...s, listValue: '' }))
      }
    })
  }

  // hash 行内编辑保存：HSET 覆盖同字段
  const saveHashValue = (record) => {
    const value = redisEdit ? redisEdit.value : ''
    runRedisWrite('hashSetField', {
      dbIndex: redisDb, key: redisKey, field: record.field, value
    }, e('saved'), {
      level: 'write',
      text: 'HSET ' + redisKey + ' ' + record.field,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisEdit(null)
      }
    })
  }

  // zset 分值行内编辑：ZADD 同 member 天然覆盖
  const saveZsetScore = (record) => {
    const score = redisEdit ? redisEdit.value : ''
    runRedisWrite('zsetAdd', {
      dbIndex: redisDb, key: redisKey, score, member: record.member
    }, e('saved'), {
      level: 'write',
      text: 'ZADD ' + redisKey + ' ' + score + ' ' + record.member,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisEdit(null)
      }
    })
  }

  // list 行内编辑：LSET 按下标覆盖
  const saveListValue = (record) => {
    const value = redisEdit ? redisEdit.value : ''
    runRedisWrite('listSetAt', {
      dbIndex: redisDb, key: redisKey, index: record.index, value
    }, e('saved'), {
      level: 'write',
      text: 'LSET ' + redisKey + ' ' + record.index,
      note: e('saved')
    }).then(r => {
      if (r.ok) {
        setRedisEdit(null)
      }
    })
  }

  // set 成员编辑 = 删旧加新（成员是身份标识）：任一步失败都刷新详情
  const editSetMember = async (oldMember, newMember) => {
    const nm = String(newMember || '').trim()
    if (!nm || nm === oldMember) {
      setRedisEdit(null)
      return
    }
    const ok = await confirmRedisWrite({
      level: 'dangerous',
      text: 'SREM ' + redisKey + ' ' + oldMember + ' / SADD ' + redisKey + ' ' + nm,
      note: e('saved')
    })
    if (!ok) {
      setRedisEdit(null)
      return
    }
    redisWrite(tabId, 'setRem', {
      dbIndex: redisDb, key: redisKey, members: [oldMember]
    }).then(() => redisWrite(tabId, 'setAdd', {
      dbIndex: redisDb, key: redisKey, members: [nm]
    })).then(() => {
      message.success(e('saved'))
      setRedisEdit(null)
      selectRedisKey(redisKey)
      loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
    }).catch(err => {
      // 中间态可能已删旧未加新：必须刷新详情拿真实状态
      selectRedisKey(redisKey)
      loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack)
      showErrorModal({ error: err })
    })
  }

  // 重命名键（RENAMENX，不覆盖）：成功后切到新键；冲突由后端抛含 newKey 的
  // 可读错误，经 toast 展示。键名变化，刷新走 keyList，详情在新键上重拉
  const doRenameKeyNx = async () => {
    const newKey = renameInput.trim()
    if (!newKey || newKey === redisKey) {
      return
    }
    const ok = await confirmRedisWrite({
      level: 'write',
      text: 'RENAMENX ' + redisKey + ' ' + newKey,
      note: e('dbRenamed')
    })
    if (!ok) {
      return
    }
    redisWrite(tabId, 'renameKeyNx', {
      dbIndex: redisDb, key: redisKey, newKey
    }, {
      refresh: () => loadRedisKeys(redisDb, keyList.cursor, keyList.match, keyList.stack),
      onSuccess: () => {
        setRedisKey(newKey)
        selectRedisKey(newKey)
      }
    }).then(() => {
      message.success(e('dbRenamed'))
      setRenameOpen(false)
      setRenameInput('')
    }).catch(err => {
      showErrorModal({ error: err })
    })
  }

  return {
    runRedisWrite,
    addHashField,
    addMember,
    pushList,
    saveHashValue,
    saveZsetScore,
    saveListValue,
    editSetMember,
    doRenameKeyNx
  }
}
