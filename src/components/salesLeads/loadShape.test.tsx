// THE SALES PAGES' LOAD SHAPE (2026-11-23, page speed, PR 3): what a page shows while it waits, how a filter takes effect on the
// Lead Master, and that the popup reads a lead's quotations beside the record instead of after it.
// Run: npx tsx --test src/components/salesLeads/loadShape.test.tsx

import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkLead } from '@/lib/salesLeads/api'
import { BoardBlocks, SkeletonCards } from './SalesCheckingFrame'
import { LeadQuotes } from './LeadQuotes'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('a Sales page waits in the shape of the page, not behind a full-screen spinner', () => {
  test('the four pages that read their own data draw grey blocks while the first answer is on its way', () => {
    for (const f of ['MyDayScreen', 'TeamScreen', 'LeadMasterScreen']) {
      const src = code(`src/components/salesLeads/${f}.tsx`)
      assert.ok(src.includes('<ModulePageSkeleton variant="list"'), `${f} draws the list skeleton`)
      assert.ok(!src.includes('LoadingScreen'), `${f} no longer uses the full-screen spinner`)
    }
    // The board has no body of its own to wait behind (its columns start with the page and each shows card-shaped blocks, below).
    const board = code('src/components/salesLeads/BoardScreen.tsx')
    assert.ok(!board.includes('LoadingScreen') && !board.includes('BoardBlocks'))
  })

  test('a column waits with card-shaped blocks, and they cannot be pressed or read out', () => {
    const board = code('src/components/salesLeads/BoardScreen.tsx')
    assert.ok(board.includes('<SkeletonCards count={4} />'))
    const html = renderToStaticMarkup(createElement(SkeletonCards, { count: 3 }))
    assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 3)
    assert.ok(!/<button|<a[ >]|onclick|tabindex/i.test(html))
  })

  test('the board blocks are one frame of five columns, the same ones the page frame draws', () => {
    const html = renderToStaticMarkup(createElement(BoardBlocks))
    for (const name of ['New', 'Under Process', 'Visit / Meeting', 'Potential Clients', 'Negotiation']) assert.ok(html.includes(`>${name}<`), name)
    assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 25, 'five blocks of cards in each of five columns')
  })
})

describe('the Lead Master changes its address without asking the server', () => {
  test('it uses the shallow mode the Lead Board uses, and still goes through the router only to leave the page', () => {
    const src = code('src/components/salesLeads/LeadMasterScreen.tsx')
    assert.ok(src.includes('useListUrlState(LIST_PARAMS, { shallow: true })'))
    assert.ok(!/router\.(replace|push)\([^)]*\?/.test(src), 'no router call carries a query string')
  })
})

describe('the popup reads the lead\'s quotations beside the record', () => {
  let cleanup: (() => void) | null = null
  afterEach(() => { cleanup?.(); cleanup = null })

  const lead = { id: 'lead-1' } as unknown as WorkLead
  function setup(filling: boolean) {
    let calls = 0
    const supabase = { rpc: async () => { calls += 1; return { data: { open: true, may_create: false, quotations: [] }, error: null } } }
    const work = { supabase } as never
    // gcTime Infinity: the default 5-minute garbage-collection timer would keep the test process alive after the last test.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    const tree = (f: boolean) => createElement(QueryClientProvider, { client }, createElement(LeadQuotes, { lead, work, canMake: false, filling: f }))
    const ui = mount(tree(filling))
    cleanup = () => ui.unmount()
    return { ui, tree, calls: () => calls }
  }
  const settle = () => new Promise(r => setTimeout(r, 30))

  test('while the record is still arriving (filling) the read has already started, and nothing is drawn', async () => {
    const { ui, calls } = setup(true)
    await settle()
    assert.equal(calls(), 1, 'asked at once, not after the record')
    assert.equal(ui.container.innerHTML, '', 'no band yet')
  })

  test('when the record arrives the answer is already there: no second read', async () => {
    const { ui, tree, calls } = setup(true)
    await settle()
    ui.render(tree(false))
    await settle()
    assert.equal(calls(), 1)
  })
})
