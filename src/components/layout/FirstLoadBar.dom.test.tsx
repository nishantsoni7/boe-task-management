/**
 * The thin bar that shows while a FIRST read is slow — run in a simulated browser with a real QueryClient.
 *
 * It must appear only for a read that has nothing to show yet and is taking a while: never for a quick answer,
 * never for the refresh of data already on screen (the 60 s polls), and it must go the moment the data lands.
 *
 * Run:
 *   npx tsx --test src/components/layout/FirstLoadBar.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness' // first: it installs the DOM react-dom needs
import '@/lib/testing/cssModuleStub' // before the component: Node cannot load a CSS module
import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { FirstLoadBar, FIRST_LOAD_BAR_DELAY_MS } from './FirstLoadBar'

type Ui = ReturnType<typeof mount>

const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const shown = (ui: Ui) => ui.all('[role="progressbar"]').length === 1

describe('the first-load bar', () => {
  let ui: Ui | null = null
  let qc: QueryClient
  const answers: Array<(v: string) => void> = []

  function Reader({ enabled = true }: { enabled?: boolean }) {
    useQuery({ queryKey: ['x'], enabled, staleTime: 0, queryFn: () => new Promise<string>(res => { answers.push(res) }) })
    return null
  }
  const open = (enabled = true) => {
    // gcTime Infinity: no cache timer outlives the test (node:test has no timeout, and a live timer holds the run open).
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    ui = mount(createElement(QueryClientProvider, { client: qc }, createElement(Reader, { enabled }), createElement(FirstLoadBar)))
    return ui
  }
  // React Query tells its observers on a 0 ms timer of its own, so give it a moment after the answer.
  const answer = async (v = 'data') => { await act(async () => { answers.shift()!(v); await new Promise(r => setTimeout(r, 30)) }) }

  afterEach(() => { ui?.unmount(); ui = null; qc?.clear(); answers.length = 0 })

  test('a slow first read shows the bar after the pause, and the answer takes it away', async () => {
    const u = open()
    assert.equal(shown(u), false, 'not at once')
    await wait(FIRST_LOAD_BAR_DELAY_MS + 100)
    assert.equal(shown(u), true)
    await answer()
    assert.equal(shown(u), false)
  })

  test('a quick answer never flashes it', async () => {
    const u = open()
    await wait(80)
    await answer()
    await wait(FIRST_LOAD_BAR_DELAY_MS + 100)
    assert.equal(shown(u), false)
  })

  test('refreshing data that is already on screen does not count', async () => {
    const u = open()
    await answer() // the page now has its data
    await act(async () => { void qc.invalidateQueries({ queryKey: ['x'] }); await new Promise(r => setTimeout(r, 0)) })
    assert.equal(answers.length, 1, 'a refresh is in flight')
    await wait(FIRST_LOAD_BAR_DELAY_MS + 100)
    assert.equal(shown(u), false)
  })

  test('a read that is switched off is not loading', async () => {
    const u = open(false)
    await wait(FIRST_LOAD_BAR_DELAY_MS + 100)
    assert.equal(answers.length, 0)
    assert.equal(shown(u), false)
  })

  test('it informs only: it is a progress bar that takes no clicks', async () => {
    const u = open()
    await wait(FIRST_LOAD_BAR_DELAY_MS + 100)
    const bar = u.one<HTMLElement>('[role="progressbar"]')
    assert.equal(bar.getAttribute('aria-label'), 'Loading')
    assert.equal(bar.getAttribute('aria-busy'), 'true')
    await answer()
  })
})
