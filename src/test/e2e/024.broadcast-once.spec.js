const { _electron: electron } = require('@playwright/test')
const {
  test: it,
  expect
} = require('@playwright/test')
const { describe } = it
it.setTimeout(100000)
const delay = require('./common/wait')
const appOptions = require('./common/app-options')
const extendClient = require('./common/client-extend')

describe('footer broadcast entry / send once', function () {
  it('opens the broadcast picker and sends one command without staying in broadcast mode', async function () {
    const electronApp = await electron.launch(appOptions)
    const client = await electronApp.firstWindow()
    extendClient(client, electronApp)

    await delay(3500)
    // Two local shell tabs: one source + one broadcast target
    await client.click('.tabs .tabs-add-btn')
    await delay(500)
    await client.click('.add-menu-wrap .context-item:has-text("New tab")')
    await delay(1500)
    expect(await client.countElem('.tabs .tab')).toEqual(2)

    // The footer "batch input" affordance now only opens the broadcast picker,
    // defaulting to the one-shot mode that replaces the old batch input.
    await client.click('.batch-input-holder')
    await delay(500)
    expect(await client.countElem('.broadcast-pick')).equal(1)
    expect(await client.countElem('.broadcast-once .ant-input')).equal(1)

    await client.setValue('.broadcast-once .ant-input', 'ls')
    await client.click('.ant-modal-footer .ant-btn-primary')
    await delay(1200)

    const state = await client.evaluate(() => ({
      on: window.store.broadcast.on,
      pickerOpen: window.store.broadcastPickerOpen,
      history: window.store.batchInputs
    }))
    expect(state.on).toEqual(false)
    expect(state.pickerOpen).toEqual(false)
    expect(state.history).toContain('ls')

    await electronApp.close().catch(console.log)
  })
})
