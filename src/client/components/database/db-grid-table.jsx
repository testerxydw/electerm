// 数据库网格统一包装（doc/已完成/数据库功能设计归档-2026-10-21.md）：
// 表体定高滚动（scroll.y）→ 横向滚动条常驻可视区底边、不再沉到全部行之下，表头随之吸顶。
// 容器/表头高度用 ResizeObserver 实测（覆盖窗口变化/分屏/树宽拖拽/数据渲染）；
// ResizeObserver 挂载时创建一次；数据/加载态变化时补测一次。
// 测量未就绪时不传 y，保持原有的外层容器滚动行为（优雅降级）
//
// N11a 提取：原函数位于 db-session.jsx（顶层、零 DbSession 闭包依赖），按单一职责迁出为独立组件。
import React, { useRef, useState, useEffect } from 'react'
import { Table } from 'antd'

export default function DbGridTable (props) {
  const { className = '', style, ...rest } = props
  const wrapRef = useRef(null)
  const measureRef = useRef(() => {})
  const [wrapH, setWrapH] = useState(0)
  const [headH, setHeadH] = useState(0)
  const [pagerH, setPagerH] = useState(0)
  // ResizeObserver 只在挂载时建一次：原实现每次 render 都新建/断开，
  // 输入查找、过滤等高频状态变化会带来无谓的观察器与同步测量开销。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) {
      return
    }
    const measure = () => {
      // scroll.y 生效后表头是独立渲染的 .ant-table-header 容器（含边框），
      // 必须用它的高度：用 thead 会少算边框/子像素 → 表头+表体总高超出 wrap
      // 一点 → 外层 .db-grid-table 出现竖向滚动条（双滚动条）。
      // 用 getBoundingClientRect（小数）+ ceil：不放大可用高度
      const head = el.querySelector('.ant-table-header') ||
        el.querySelector('.ant-table-thead')
      // 非激活页签里 clientHeight / rect 高度都是 0。写回 0 会把 y 置 0 →
      // virtual=false → antd Table 退回全量渲染：3 万行页签切走后会挂出上万
      // DOM 节点、堆上多占几十 MB（CDP 实测），所以量到 0 时保留上次实测值
      const h = el.clientHeight
      if (h > 0) {
        setWrapH(h)
      }
      const hh = head ? Math.ceil(head.getBoundingClientRect().height) : 0
      if (hh > 0) {
        setHeadH(hh)
      }
      // 分页器占掉的纵向空间必须从 y 里扣掉，否则表体把分页器顶出可视区；
      // 结果不足一页时是真没有分页器，要如实写回 0
      const pager = el.querySelector('.ant-pagination')
      if (!pager) {
        setPagerH(0)
      } else {
        const ph = Math.ceil(pager.getBoundingClientRect().height)
        if (ph > 0) {
          setPagerH(ph)
        }
      }
    }
    measureRef.current = measure
    measure()
    const ob = new window.ResizeObserver(() => measureRef.current())
    ob.observe(el)
    // 表头单独观察：首次测量可能落在瞬时渲染态（拿到偏小的高度），数据渲染后表头才稳定
    const head = el.querySelector('.ant-table-header') ||
      el.querySelector('.ant-table-thead')
    if (head) {
      ob.observe(head)
    }
    return () => {
      measureRef.current = () => {}
      ob.disconnect()
    }
  }, [])
  // 数据/加载态变化后补测一次（列宽与行数变化可能改变表头高度）
  useEffect(() => {
    measureRef.current()
  }, [rest.dataSource, rest.loading])
  const y = wrapH > 0 && headH > 0 && wrapH > headH + pagerH ? wrapH - headH - pagerH : 0
  return (
    <div className={'db-grid-table-wrap' + (className ? ' ' + className : '')} ref={wrapRef} style={style}>
      <Table
        {...rest}
        className='db-grid-table'
        // 行虚拟渲染：DOM 行数与 pageSize 解耦（只渲染可视区），行少自动退化为全渲染
        virtual={y > 0}
        // y 生效后表体自己滚动，外层禁掉纵向滚动（子像素取整仍可能溢出 1px → 双滚动条）
        style={y > 0 ? { overflowY: 'hidden' } : undefined}
        scroll={{ x: 'max-content', ...(y > 0 ? { y } : {}) }}
      />
    </div>
  )
}
