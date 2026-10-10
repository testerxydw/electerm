const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')

// store/tab.js pulls in message.jsx → message.styl, which node cannot load.
// Instead of importing the whole module, extract the real moveTabToPane source
// and evaluate it in a sandbox — the test runs the shipped implementation, not
// a copied one, and breaks if the implementation is renamed or moved.
// constants.js also imports png assets, which node cannot load either. Provide
// the minimal splitConfig the implementation reads, and guard against drift
// with a source check against constants.js.
const MIN_SPLIT_CONFIG = {
  c1: { children: 1 },
  c2: { children: 2 },
  c2x2: { children: 4 }
}

const loadMoveTabToPane = async () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/client/store/tab.js'),
    'utf8'
  )
  const match = src.match(
    /Store\.prototype\.moveTabToPane = function[\s\S]*?\n {2}\}/
  )
  assert.ok(match, 'moveTabToPane definition not found in src/client/store/tab.js')
  const sandbox = {
    Store: { prototype: {} },
    splitConfig: MIN_SPLIT_CONFIG
  }
  // the implementation reads window.store at call time; makeStore() swaps
  // global.window per test, so resolve it dynamically instead of snapshotting
  Object.defineProperty(sandbox, 'window', {
    get: () => global.window
  })
  vm.runInNewContext(match[0], sandbox)
  return sandbox.Store.prototype.moveTabToPane
}

// minimal fake of the manate store surface moveTabToPane touches
function makeStore (tabs, layout = 'c2') {
  const store = {
    tabs,
    layout,
    activeTabId: tabs.length ? tabs[0].id : '',
    currentLayoutBatch: 0,
    fixCalls: [],
    fixActiveTabIds (count) {
      this.fixCalls.push(count)
      for (let b = 0; b < count; b++) {
        const inBatch = this.tabs.filter(t => t.batch === b)
        const key = `activeTabId${b}`
        if (!inBatch.some(t => t.id === this[key])) {
          this[key] = inBatch.length ? inBatch[0].id : ''
        }
      }
    }
  }
  for (const tab of tabs) {
    store[`activeTabId${tab.batch}`] = store[`activeTabId${tab.batch}`] || tab.id
  }
  global.window = { store }
  return store
}

const makeTab = (id, batch) => ({ id, batch })

describe('moveTabToPane: move a tab across panes in the same layout', () => {
  test('MIN_SPLIT_CONFIG matches constants.js (drift guard)', async () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/client/common/constants.js'),
      'utf8'
    )
    for (const [layout, conf] of Object.entries(MIN_SPLIT_CONFIG)) {
      const block = src.match(
        new RegExp(`${layout}:\\s*\\{[^}]*children:\\s*(\\d+)`)
      )
      assert.ok(block, `splitConfig.${layout} not found in constants.js`)
      assert.equal(
        Number(block[1]),
        conf.children,
        `splitConfig.${layout}.children drifted from MIN_SPLIT_CONFIG`
      )
    }
  })

  test('moves the tab, keeps its identity, and focuses the target pane', async () => {
    const moveTabToPane = await loadMoveTabToPane()
    const tabA = makeTab('a', 0)
    const tabB = makeTab('b', 0)
    const store = makeStore([tabA, tabB], 'c2')

    moveTabToPane('a', 1)

    // same tab object migrated, not a copy — terminal history follows the tab
    assert.equal(tabA.batch, 1)
    assert.deepEqual(store.tabs, [tabA, tabB])
    assert.equal(store.activeTabId, 'a')
    assert.equal(store.activeTabId1, 'a')
    assert.equal(store.currentLayoutBatch, 1)
    // original pane lost its active tab, so fix runs with the real pane count
    assert.deepEqual(store.fixCalls, [MIN_SPLIT_CONFIG.c2.children])
  })

  test('moving within the same pane is a no-op', async () => {
    const moveTabToPane = await loadMoveTabToPane()
    const tabA = makeTab('a', 0)
    const store = makeStore([tabA], 'c2')

    moveTabToPane('a', 0)

    assert.equal(tabA.batch, 0)
    assert.deepEqual(store.fixCalls, [], 'fixActiveTabIds must not run')
  })

  test('unknown tab id is a no-op', async () => {
    const moveTabToPane = await loadMoveTabToPane()
    const tabA = makeTab('a', 0)
    const store = makeStore([tabA], 'c2')

    moveTabToPane('ghost', 1)

    assert.equal(tabA.batch, 0)
    assert.deepEqual(store.fixCalls, [])
  })

  test('works on a four-pane layout (c2x2)', async () => {
    const moveTabToPane = await loadMoveTabToPane()
    const tabA = makeTab('a', 0)
    const tabB = makeTab('b', 1)
    const tabC = makeTab('c', 2)
    const tabD = makeTab('d', 3)
    const store = makeStore([tabA, tabB, tabC, tabD], 'c2x2')
    store.activeTabId = 'c'

    moveTabToPane('c', 3)

    assert.equal(tabC.batch, 3)
    assert.equal(store.activeTabId, 'c')
    assert.equal(store.activeTabId3, 'c')
    assert.deepEqual(store.fixCalls, [MIN_SPLIT_CONFIG.c2x2.children])
  })
})
