/**
 * SFTP/FTP 远程文件只读预览（G3）
 *
 * 与 text-editor 的分工：编辑器要整份下载、可回写；预览只取文件头（图片 10MB、
 * 其余 2MB 上限，判定在主进程 remote-preview.js），不许写库也不许回传。
 *
 * 渲染分三种：文本（行号 + 查找高亮）、图片（base64 data URL）、二进制
 * （前 4KB 十六进制）。截断的文本只提示 + 给下载出口，不做"加载更多" ——
 * 分页读会让行号与查找口径都变得可疑，超出预览就该走下载。
 */

import React from 'react'
import { Input, Spin, Button } from 'antd'
import Modal from '../common/modal'
import { refsStatic } from '../common/ref'
import { filesize } from 'filesize'
import time from '../../common/time'
import resolve from '../../common/resolve'
import './file-preview-modal.styl'

const e = window.translate
const formatTime = time

const EMPTY_STATE = {
  visible: false,
  loading: false,
  error: '',
  file: {},
  path: '',
  data: null,
  keyword: ''
}

export default class FilePreviewModal extends React.PureComponent {
  state = { ...EMPTY_STATE }

  // 连续点两三个文件时只认最后一次请求的回包
  seq = 0

  componentDidMount () {
    refsStatic.add('file-preview-modal', this)
  }

  showFilePreviewModal ({ file, sftp, onDownload }) {
    const path = resolve(file.path, file.name)
    const seq = ++this.seq
    this.setState({
      ...EMPTY_STATE,
      visible: true,
      loading: true,
      file,
      path,
      onDownload
    })
    sftp.previewRemoteFile(path).then(data => {
      if (seq !== this.seq) {
        return
      }
      this.setState({ loading: false, data })
    }).catch(err => {
      if (seq !== this.seq) {
        return
      }
      this.setState({
        loading: false,
        error: String((err && err.message) || err)
      })
    })
  }

  handleClose = () => {
    this.seq++
    this.setState({ ...EMPTY_STATE })
  }

  handleDownloadTruncated = () => {
    const { onDownload } = this.state
    this.handleClose()
    if (typeof onDownload === 'function') {
      onDownload()
    }
  }

  // 查找高亮：返回节点数组与命中数。按文本切片拼 <mark>，不走原始 HTML 注入
  highlight (text, keyword) {
    const q = String(keyword || '')
    if (!q) {
      return { nodes: text, count: 0 }
    }
    const lower = text.toLowerCase()
    const ql = q.toLowerCase()
    const nodes = []
    let i = 0
    let count = 0
    while (true) {
      const p = lower.indexOf(ql, i)
      if (p < 0) {
        break
      }
      if (p > i) {
        nodes.push(text.slice(i, p))
      }
      nodes.push(<mark key={'m' + count}>{text.slice(p, p + q.length)}</mark>)
      count++
      i = p + q.length
    }
    if (!count) {
      return { nodes: text, count: 0 }
    }
    nodes.push(text.slice(i))
    return { nodes, count }
  }

  renderText (data) {
    const { keyword } = this.state
    const { nodes, count } = this.highlight(data.text, keyword)
    const lineCount = String(data.text).split('\n').length
    const gutter = Array.from({ length: lineCount }, (v, i) => i + 1).join('\n')
    return (
      <>
        <div className='file-preview-find'>
          <Input
            size='small'
            allowClear
            value={keyword}
            placeholder={e('filePreviewFind')}
            onChange={ev => this.setState({ keyword: ev.target.value })}
          />
          {
            keyword
              ? <span className='file-preview-find-count'>{e('filePreviewFindCount').replace('{n}', count)}</span>
              : null
          }
        </div>
        {
          data.truncated
            ? (
              <div className='file-preview-banner'>
                <span>
                  {e('filePreviewTruncated')
                    .replace('{size}', filesize(data.size))
                    .replace('{shown}', filesize(data.bytes))}
                </span>
                <Button size='small' onClick={this.handleDownloadTruncated}>{e('download')}</Button>
              </div>
              )
            : null
        }
        <div className='file-preview-body file-preview-body-text'>
          <pre className='file-preview-gutter' aria-hidden='true'>{gutter}</pre>
          <pre className='file-preview-pre'>{nodes}</pre>
        </div>
      </>
    )
  }

  renderImage (data) {
    return (
      <div className='file-preview-body file-preview-body-image'>
        <img
          alt={this.state.file.name}
          src={'data:' + data.mime + ';base64,' + data.base64}
        />
      </div>
    )
  }

  renderBinary (data) {
    return (
      <>
        {
          data.truncated
            ? (
              <div className='file-preview-banner'>
                <span>
                  {e('filePreviewTruncated')
                    .replace('{size}', filesize(data.size))
                    .replace('{shown}', filesize(data.bytes))}
                </span>
                <Button size='small' onClick={this.handleDownloadTruncated}>{e('download')}</Button>
              </div>
              )
            : null
        }
        <div className='file-preview-body'>
          <div className='file-preview-hint'>{e('filePreviewBinary')}</div>
          <pre className='file-preview-pre file-preview-hex'>{data.hex}</pre>
        </div>
      </>
    )
  }

  renderBody () {
    const { loading, error, data, path } = this.state
    if (loading) {
      return (
        <div className='aligncenter pd3'>
          <Spin />
        </div>
      )
    }
    if (error) {
      return (
        <div className='file-preview-error'>
          {e('filePreviewError')}
          <div className='file-preview-error-msg'>{error}</div>
          <div className='file-preview-error-path'>{path}</div>
        </div>
      )
    }
    if (!data) {
      return null
    }
    if (data.kind === 'image') {
      return this.renderImage(data)
    }
    if (data.kind === 'binary') {
      return this.renderBinary(data)
    }
    if (!data.text) {
      return <div className='file-preview-empty'>{e('filePreviewEmpty')}</div>
    }
    return this.renderText(data)
  }

  render () {
    const { visible, file, data } = this.state
    return (
      <Modal
        open={visible}
        width={900}
        className='file-preview-modal'
        title={(
          <>
            <span className='file-preview-title'>{file.name}</span>
            {
              data
                ? (
                  <span className='file-preview-meta'>
                    {filesize(data.size)}
                    {data.mtime ? ' · ' + formatTime(data.mtime) : ''}
                  </span>
                  )
                : null
            }
          </>
        )}
        onCancel={this.handleClose}
        footer={<Button onClick={this.handleClose}>{e('close')}</Button>}
      >
        {this.renderBody()}
      </Modal>
    )
  }
}
