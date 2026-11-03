/**
 * Sales, Lead Board: a column reads its leads a page at a time.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/boardPage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifySalesError, fetchBoardPage, type BoardPage, type WorkLead } from './api'
import { COLUMN_PAGE, nextOffset, uniqueRows } from './boardPage'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')

const lead = (id: string) => ({ id }) as WorkLead
const page = (n: number, ...ids: string[]): BoardPage => ({ n, overdue: 0, due_today: 0, rows: ids.map(lead) })

describe('where the next page starts', () => {
  test('after the leads already received, until the column is read to its end', () => {
    const first = page(100, 'a', 'b', 'c')
    assert.equal(nextOffset(first, [first]), 3)
    const second = page(100, 'd', 'e')
    assert.equal(nextOffset(second, [first, second]), 5)
  })

  test('no next page once everything is loaded, or when a page comes back empty', () => {
    const all = page(3, 'a', 'b', 'c')
    assert.equal(nextOffset(all, [all]), undefined)
    const empty = page(100)
    assert.equal(nextOffset(empty, [page(100, 'a'), empty]), undefined)
  })

  test('a page is 40 leads, and the database caps one call at 100', () => {
    assert.equal(COLUMN_PAGE, 40)
    assert.ok(read('supabase/migrations/20270601000000_sales_board_page.sql').includes('least(greatest(coalesce(p_limit, 40), 1), 100)'))
  })
})

describe('the leads shown', () => {
  test('every page in order, a lead that arrived twice only once', () => {
    const rows = uniqueRows([page(9, 'a', 'b', 'c'), page(9, 'c', 'd'), page(9, 'e')])
    assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c', 'd', 'e'])
  })

  test('nothing loaded yet is an empty list', () => {
    assert.deepEqual(uniqueRows(undefined), [])
  })
})

describe('what the review of the board screen found', () => {
  const board = read('src/components/salesLeads/BoardScreen.tsx')
  const layoutCss = read('src/components/layout/salesLayout.module.css')
  const boardCss = read('src/components/salesLeads/leadBoard.module.css')

  test('a page that failed to load is not asked for again and again', () => {
    assert.ok(board.includes('isFetchNextPageError'), 'the column knows the last page failed')
    assert.ok(/!hasNextPage \|\| isFetchingNextPage \|\| isFetchNextPageError/.test(board), 'the scroll watcher waits for Try again')
    assert.ok(board.includes('Could not load more.'), 'and says so')
  })

  test('scrolling never cancels the refresh that follows an action', () => {
    assert.ok(!/fetchNextPage\(\)/.test(board), 'every fetchNextPage call keeps the refresh running')
    assert.ok(board.includes('fetchNextPage({ cancelRefetch: false })'))
  })

  test('a page that does not scroll still ends above the phone bar', () => {
    const phone = layoutCss.slice(layoutCss.indexOf('@media (max-width: 767px)'))
    assert.ok(/fillBody \{ padding-bottom: calc\(72px/.test(phone))
  })

  test('on a phone a folded column is shown, and the menus stay inside the bar', () => {
    assert.ok(board.includes('folded.includes(stage) && !narrow'))
    const phone = boardCss.slice(boardCss.indexOf('@media (max-width: 700px)'))
    assert.ok(phone.includes('.menu { left: 0; right: 0;'))
  })
})

describe('asking the database for a page', () => {
  const fake = (answer: { data: unknown; error: unknown }) => {
    const calls: [string, Record<string, unknown>][] = []
    return { calls, client: { rpc: (name: string, args: Record<string, unknown>) => { calls.push([name, args]); return Promise.resolve(answer) } } }
  }
  const filter = { holder: '', market: '', segment: '', temperature: 'hot', source: '', q: '' }

  test('it names the stage and the place, and an empty filter means "everyone, anything"', async () => {
    const f = fake({ data: page(1, 'a'), error: null })
    const got = await fetchBoardPage(f.client as never, 'under_process', 80, 40, filter)
    assert.equal(got.rows[0].id, 'a')
    assert.deepEqual(f.calls, [['sales_board_page', {
      p_stage: 'under_process', p_offset: 80, p_limit: 40, p_holder: 'all', p_market: null, p_segment: null, p_temperature: 'hot', p_source: null, p_q: null,
    }]])
  })

  test('a refusal reads as a sentence, not as a database message', async () => {
    const f = fake({ data: null, error: { message: 'SALES_FORBIDDEN', code: '42501' } })
    await assert.rejects(() => fetchBoardPage(f.client as never, 'new', 0, 40, filter), (e: Error) => e.message === classifySalesError({ message: 'SALES_FORBIDDEN' }).message)
  })
})
