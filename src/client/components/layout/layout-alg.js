// 布局名就是 splitMap 的键（identity 映射），这里直接写字面量：
// 常量表会连带引入图片资源，这个纯几何模块要能在 node 单测里直接 import
import { normalizeRatios } from './split-ratios.js'

const gap = 2

const layoutSingle = (w, h) => ({
  wrapStyles: [
    {
      left: 0,
      top: 0,
      bottom: 0,
      right: 0
    }
  ],
  handleStyles: []
})

const layoutTwoColumns = (w, h, r) => {
  const x = w * r[0]
  return {
    wrapStyles: [
      {
        left: 0,
        top: 0,
        bottom: 0,
        right: (x - gap) + 'px'
      },
      {
        left: (x + gap) + 'px',
        top: 0,
        bottom: 0,
        right: 0
      }
    ],
    handleStyles: [
      {
        left: (x - gap) + 'px',
        top: 0,
        bottom: 0
      }
    ]
  }
}

const layoutThreeColumns = (w, h, r) => {
  const x1 = w * r[0]
  const x2 = w * r[1]
  return {
    wrapStyles: [
      {
        left: 0,
        top: 0,
        bottom: 0,
        right: (x1 - gap) + 'px'
      },
      {
        left: (x1 + gap) + 'px',
        top: 0,
        bottom: 0,
        right: (x2 - gap) + 'px'
      },
      {
        left: (x2 + gap) + 'px',
        top: 0,
        bottom: 0,
        right: 0
      }
    ],
    handleStyles: [
      {
        left: (x1 - gap) + 'px',
        top: 0,
        bottom: 0
      },
      {
        left: (x2 - gap) + 'px',
        top: 0,
        bottom: 0
      }
    ]
  }
}

const layoutTwoRows = (w, h, r) => {
  const y = h * r[0]
  return {
    wrapStyles: [
      {
        left: 0,
        top: 0,
        right: 0,
        bottom: (y - gap) + 'px'
      },
      {
        left: 0,
        top: (y + gap) + 'px',
        right: 0,
        bottom: 0
      }
    ],
    handleStyles: [
      {
        top: (y - gap) + 'px',
        left: 0,
        right: 0
      }
    ]
  }
}

const layoutThreeRows = (w, h, r) => {
  const y1 = h * r[0]
  const y2 = h * r[1]
  return {
    wrapStyles: [
      {
        left: 0,
        top: 0,
        right: 0,
        bottom: (y1 - gap) + 'px'
      },
      {
        left: 0,
        top: (y1 + gap) + 'px',
        right: 0,
        bottom: (y2 - gap) + 'px'
      },
      {
        left: 0,
        top: (y2 + gap) + 'px',
        right: 0,
        bottom: 0
      }
    ],
    handleStyles: [
      {
        top: (y1 - gap) + 'px',
        left: 0,
        right: 0
      },
      {
        top: (y2 - gap) + 'px',
        left: 0,
        right: 0
      }
    ]
  }
}

const layoutGrid2x2 = (w, h, r) => {
  const x = w * r[0]
  const y = h * r[1]
  return {
    wrapStyles: [
      {
        left: 0,
        top: 0,
        right: (x - gap) + 'px',
        bottom: (y - gap) + 'px'
      },
      {
        left: (x + gap) + 'px',
        top: 0,
        right: 0,
        bottom: (y - gap) + 'px'
      },
      {
        left: 0,
        top: (y + gap) + 'px',
        right: (x - gap) + 'px',
        bottom: 0
      },
      {
        left: (x + gap) + 'px',
        top: (y + gap) + 'px',
        right: 0,
        bottom: 0
      }
    ],
    handleStyles: [
      {
        left: (x - gap) + 'px',
        top: 0,
        bottom: 0
      },
      {
        top: (y - gap) + 'px',
        left: 0,
        right: 0
      }
    ]
  }
}

const layoutTwoRowsRight = (w, h, r) => {
  const x = w * r[0]
  const y = h * r[1]
  return {
    wrapStyles: [
      {
        left: 0,
        top: 0,
        bottom: 0,
        right: (x - gap) + 'px'
      },
      {
        left: (x + gap) + 'px',
        top: 0,
        right: 0,
        bottom: (y - gap) + 'px'
      },
      {
        left: (x + gap) + 'px',
        top: (y + gap) + 'px',
        right: 0,
        bottom: 0
      }
    ],
    handleStyles: [
      {
        left: (x - gap) + 'px',
        top: 0,
        bottom: 0
      },
      {
        top: (y - gap) + 'px',
        left: (x + gap) + 'px',
        right: 0
      }
    ]
  }
}

const layoutTwoColumnsBottom = (w, h, r) => {
  const y = h * r[0]
  const x = w * r[1]
  return {
    wrapStyles: [
      {
        left: 0,
        top: 0,
        right: 0,
        bottom: (y - gap) + 'px'
      },
      {
        left: 0,
        top: (y + gap) + 'px',
        right: (x - gap) + 'px',
        bottom: 0
      },
      {
        left: (x + gap) + 'px',
        top: (y + gap) + 'px',
        right: 0,
        bottom: 0
      }
    ],
    handleStyles: [
      {
        top: (y - gap) + 'px',
        left: 0,
        right: 0
      },
      {
        left: (x - gap) + 'px',
        top: (y + gap) + 'px',
        bottom: 0
      }
    ]
  }
}

const layoutFunctions = {
  c1: layoutSingle,
  c2: layoutTwoColumns,
  c3: layoutThreeColumns,
  r2: layoutTwoRows,
  r3: layoutThreeRows,
  c2x2: layoutGrid2x2,
  c1r2: layoutTwoRowsRight,
  r1c2: layoutTwoColumnsBottom
}

// ratios 缺省时按等分处理（normalizeRatios 会把空/畸形值补成默认等分）
export default function layoutAlg (layout, w, h, ratios) {
  const layoutFunction = layoutFunctions[layout] || layoutSingle
  return layoutFunction(w, h, normalizeRatios(layout, ratios))
}
