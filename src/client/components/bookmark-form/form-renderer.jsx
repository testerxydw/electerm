/**
 * Generic form renderer driven by config (flattened path)
 */
import React, { useEffect, useState, useRef } from 'react'
import { Alert, Button, Form, Tabs } from 'antd'
import message from '../common/message'
import { showErrorModal } from '../common/error-modal'
import { renderFormItem } from './common/fields'
import SubmitButtons from './common/submit-buttons'
import { uniq } from 'lodash-es'
import {
  authTypeMap,
  settingMap,
  newBookmarkIdPrefix,
  defaultBookmarkGroupId,
  terminalDatabaseType
} from '../../common/constants'
import copy from 'json-deep-copy'
import generate from '../../common/uid'
import runIdle from '../../common/run-idle'
import getInitItem from '../../common/init-setting-item'
import testCon from '../../common/test-connection'
import newTerm from '../../common/new-terminal'
import { isValidIP } from '../../common/is-ip'
import { describeBookmarkTarget } from '../../common/bookmark-dedup'
import { action as manateAction } from 'manate'

const e = window.translate

// 撞车清单一次别印几十条，能看清"哪几条"就够，剩下的报个数
const maxHitsShown = 4

export default function FormRenderer ({ config, props, onForm }) {
  const initialValues = config.initValues(props)
  const [form] = Form.useForm()
  const [ips, setIps] = useState([])
  const [authType, setAuthType] = useState(initialValues.authType || authTypeMap.password)
  const [testing, setTesting] = useState(false)
  const [duplicate, setDuplicate] = useState(null)
  const action = useRef('submit')

  // hand the form instance up so the header can read the current values
  useEffect(() => {
    if (onForm) {
      onForm(form)
    }
    return () => {
      if (onForm) {
        onForm(null)
      }
    }
  }, [onForm, form])

  useEffect(() => {
    const init = config.initValues(props)
    form.resetFields()
    form.setFieldsValue(init)
    setDuplicate(null)
  }, [
    props.currentBookmarkGroupId,
    props.formData?.id,
    config.key
  ])

  const updateBookmarkGroups = manateAction((bookmark, categoryId) => {
    const {
      bookmarkGroups
    } = window.store
    let index = bookmarkGroups.findIndex(
      bg => bg.id === categoryId
    )
    if (index < 0) {
      index = bookmarkGroups.findIndex(
        bg => bg.id === defaultBookmarkGroupId
      )
    }
    const bid = bookmark.id
    const bg = bookmarkGroups[index]
    if (!bg.bookmarkIds.includes(bid)) {
      bg.bookmarkIds.unshift(bid)
    }
    bg.bookmarkIds = uniq(bg.bookmarkIds)
    bookmarkGroups.forEach((bg, i) => {
      if (i === index) {
        return bg
      }
      bg.bookmarkIds = bg.bookmarkIds.filter(
        g => g !== bid
      )
      return bg
    })
    message.success('OK', 3)
  })

  const setNewItem = (settingItem = getInitItem([], settingMap.bookmarks)) => {
    const { store } = props
    store.setSettingItem(settingItem)
  }

  const submit = (evt, item, type = props.type, { force = false } = {}) => {
    // 留一份原样的提交给「仍然创建」重试：下面会 trim、删 category、换新 id，
    // 把这些副作用带进重试等于把用户填的东西改第二遍
    const pristine = copy(item)
    if (item.host) {
      item.host = item.host.trim()
    }
    const obj = item
    if (obj.connectionHoppings?.length) {
      obj.hasHopping = true
    }
    const { addBookmark, editBookmark, checkBookmark } = props.store
    const categoryId = obj.category
    delete obj.category
    const isEdit = !obj.id.startsWith(newBookmarkIdPrefix)
    const tar = copy(obj)
    delete tar.id
    // 判重同步做（写库挪到空闲帧是性能考虑，不能把"撞了要当场说"一起挪走）
    if (!force) {
      const res = checkBookmark(tar, { selfId: isEdit ? obj.id : undefined })
      if (!res.ok) {
        setDuplicate({
          hits: res.duplicates,
          handleRetry: () => {
            setDuplicate(null)
            submit(evt, pristine, type, { force: true })
          }
        })
        return
      }
    }
    setDuplicate(null)
    // 用户点了「仍然保存」只说明"界面这一关过了"：store 卡点还会再判一次，
    // 不把 force 一路带到写库调用，重试就会点一下没反应（横幅收了、库没动）
    if (isEdit) {
      runIdle(() => {
        editBookmark(obj.id, tar, { force })
      })
      updateBookmarkGroups(
        obj,
        categoryId
      )
      if (evt === 'saveAndCreateNew') {
        setNewItem()
      }
    } else {
      obj.id = generate()
      runIdle(() => {
        addBookmark(obj, { force })
      })
      updateBookmarkGroups(
        obj,
        categoryId
      )
      setNewItem(evt === 'saveAndCreateNew'
        ? getInitItem([], settingMap.bookmarks)
        : obj
      )
    }
  }

  // 撞车就说给人听：撞在哪几条（名字 + 目标）、要不要照旧保存，都在按钮上方一屏里
  const renderDuplicate = () => {
    if (!duplicate) {
      return null
    }
    const hits = duplicate.hits
    const shown = hits.slice(0, maxHitsShown).map(d => (
      <div key={d.id} className='bookmark-dup-item'>
        {d.title} · {describeBookmarkTarget(d)}
      </div>
    ))
    const rest = hits.length - shown.length
    if (rest > 0) {
      shown.push(
        <div key='more' className='bookmark-dup-item'>
          +{rest} {e('bookmarkMoreDuplicates')}
        </div>
      )
    }
    return (
      <Alert
        className='bookmark-dup-warn'
        type='warning'
        showIcon
        message={e('bookmarkDuplicateWarn')}
        description={<div className='bookmark-dup-list'>{shown}</div>}
        action={
          <Button
            size='small'
            type='primary'
            danger
            onClick={duplicate.handleRetry}
          >
            {e('bookmarkSaveAnyway')}
          </Button>
        }
      />
    )
  }

  const test = async (update) => {
    let options = copy({
      ...props.formData,
      ...update
    })
    let msg = ''
    setTesting(true)
    if (options.type === terminalDatabaseType) {
      await window.store.testDbConnection(options)
      setTesting(false)
      return
    }
    options = window.store.applyProfileToTabs(options)
    const res = await testCon(options)
      .then(r => r)
      .catch((e) => {
        msg = e.message
        return false
      })
    setTesting(false)
    if (res) {
      message.success('connection ok')
    } else {
      const err = 'connection fails' +
        (msg ? `: ${msg}` : '')
      showErrorModal({ error: err })
    }
  }

  const onSelectProxy = (proxy, form) => {
    const obj = Object.keys(proxy)
      .reduce((prev, c) => {
        return {
          ...prev,
          [`proxy.${c}`]: proxy[c]
        }
      }, {})
    form.setFieldsValue(obj)
  }

  const handleSubmit = async (evt, res, isTest = false) => {
    if (res.enableSsh === false && res.enableSftp === false) {
      return message.warning('SSH and SFTP all disabled')
    }
    const obj = {
      ...props.formData,
      ...res
    }
    if (!obj.terminalBackground?.terminalBackgroundImagePath) {
      delete obj.terminalBackground
    }
    if (isTest) {
      return test(obj)
    }
    if (evt && evt !== 'connect') {
      submit(evt, obj)
    }
    if (evt !== 'save' && evt !== 'saveAndCreateNew') {
      window.store.currentLayoutBatch = window.openTabBatch || 0
      props.store.addTab({
        ...copy(obj),
        ...newTerm(true, true),
        batch: window.openTabBatch ?? window.store.currentLayoutBatch
      })
      delete window.openTabBatch
      props.hide()
    }
  }

  // Button handlers - exactly like original use-form-funcs
  const save = () => {
    action.current = 'save'
    form.submit()
  }

  const saveAndCreateNew = () => {
    action.current = 'saveAndCreateNew'
    form.submit()
  }

  const testConnection = () => {
    action.current = 'testConnection'
    form.submit()
  }

  const connect = () => {
    action.current = 'connect'
    form.submit()
  }

  const handleFinish = (res) => {
    if (action.current === 'save') {
      handleSubmit('save', res, false)
    } else if (action.current === 'saveAndCreateNew') {
      handleSubmit('saveAndCreateNew', res, false)
    } else if (action.current === 'connect') {
      handleSubmit('connect', res, false)
    } else if (action.current === 'testConnection') {
      handleSubmit('test', res, true)
    } else {
      handleSubmit('submit', res, false)
    }
    action.current = 'submit'
  }

  const trim = (v) => {
    return (v || '').replace(/^\s+|\s+$/g, '')
  }
  const useIp = (form, ip) => {
    form.setFieldsValue({
      host: ip
    })
  }
  const onPaste = (e, form) => {
    const txt = e.clipboardData.getData('Text')
    // support name:passsword@host:23
    const arr = txt.match(/([^:@]+)(:[^:@]+)?@([^:@]+)(:\d+)?/)
    if (!arr) {
      return
    }
    const username = arr[1]
    const password = arr[2] ? arr[2].slice(1) : ''
    const host = arr[3]
    const port = arr[4] ? arr[4].slice(1) : ''
    const obj = {
      username,
      host
    }
    if (password) {
      obj.password = password
    }
    if (port) {
      obj.port = port
    }
    setTimeout(() => {
      form.setFieldsValue(obj)
    }, 20)
  }

  const onBlur = async (e) => {
    const value = e.target.value.trim()
    const { type } = props
    if (
      type !== settingMap.bookmarks ||
      !value ||
      isValidIP(value)
    ) {
      return
    }
    const ips = await window.pre.runGlobalAsync('lookup', value)
      .catch(err => {
        console.debug(err)
      })
    setIps(ips || [])
  }

  function onChangeAuthType (e) {
    const newAuthType = e.target.value
    setAuthType(newAuthType)
  }

  // 字段一动，上一次碰撞就说明不了了：判重以点保存的那一刻为准
  const dismissDuplicate = () => {
    if (duplicate) {
      setDuplicate(null)
    }
  }

  const ctxProps = {
    ...props,
    form,
    authType,
    ips,
    testing,
    loaddingSerials: props.loaddingSerials || false,
    trim,
    onSelectProxy,
    onChangeAuthType,
    handleBlur: onBlur,
    handlePaste: onPaste,
    useIp
  }

  const tabs = typeof config.tabs === 'function' ? (config.tabs() || []) : (config.tabs || [])
  let content = null

  if (tabs.length <= 1) {
    const fields = tabs.length === 1
      ? (tabs[0].fields || [])
      : (config.fields || [])
    content = (
      <div className='pd1x'>
        {fields.map((f, index) => renderFormItem(f, config.layout, form, ctxProps, index))}
      </div>
    )
  } else {
    const items = (tabs || []).map(tab => ({
      key: tab.key,
      label: tab.label,
      forceRender: true,
      children: (
        <div className='pd1x'>
          {(tab.fields || []).map((f, index) => renderFormItem(f, config.layout, form, ctxProps, index))}
        </div>
      )
    }))
    content = <Tabs items={items} />
  }
  const formName = `${config.key}-form`
  return (
    <Form
      form={form}
      onFinish={handleFinish}
      initialValues={initialValues}
      onValuesChange={dismissDuplicate}
      name={formName}
    >
      {content}
      {renderDuplicate()}
      <SubmitButtons
        onSave={save}
        onSaveAndCreateNew={saveAndCreateNew}
        onConnect={connect}
        onTestConnection={testConnection}
      />
    </Form>
  )
}
