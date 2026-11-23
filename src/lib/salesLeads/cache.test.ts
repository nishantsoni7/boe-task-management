import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { QueryClient, QueryObserver, type InfiniteData } from '@tanstack/react-query'
import { SALES_KEY, type BoardFilter, type BoardPage, type MyDay, type WorkDetail, type WorkLead } from './api'
import { applyWritten, leavesMyDay, matchesFilter, patchColumn, patchMyDay, readAgain, settleWritten, type Written } from './cache'
import type { Stage } from './board'

// What a saved action does to the screens already showing (cache.ts). Run: npx tsx --test src/lib/salesLeads/cache.test.ts

const TODAY = '2026-11-23'
const NONE: BoardFilter = { holder: '', market: '', segment: '', temperature: '', source: '', q: '' }

function lead(id: string, over: Partial<WorkLead> = {}): WorkLead {
  return {
    id, stage: 'new', assigned_to: 'u1', market: 'domestic', segment: null, temperature: 'warm', source: 'website',
    next_due_on: TODAY, first_attempt_at: null, ...over,
  } as unknown as WorkLead
}

const page = (n: number, ...rows: WorkLead[]): BoardPage => ({ n, overdue: 0, due_today: 0, rows })
const pages = (...ps: BoardPage[]): InfiniteData<BoardPage, number> => ({ pages: ps, pageParams: ps.map((_, i) => i * 40) })
const ids = (d: InfiniteData<BoardPage, number>) => d.pages.map(p => p.rows.map(r => r.id).join(','))

describe('leavesMyDay: only says yes when it is sure', () => {
  test('a closed lead leaves', () => {
    assert.equal(leavesMyDay(lead('a', { stage: 'converted' }), TODAY), true)
    assert.equal(leavesMyDay(lead('a', { stage: 'dead' }), TODAY), true)
  })
  test('a parked lead with a later day leaves; one tried and due later leaves', () => {
    assert.equal(leavesMyDay(lead('a', { stage: 'follow_up_later', next_due_on: '2026-12-20' }), TODAY), true)
    assert.equal(leavesMyDay(lead('a', { stage: 'under_process', next_due_on: '2026-11-24', first_attempt_at: '2026-11-23T05:00:00Z' }), TODAY), true)
  })
  test('a lead due today or earlier stays', () => {
    assert.equal(leavesMyDay(lead('a', { next_due_on: TODAY, first_attempt_at: 'x' }), TODAY), false)
    assert.equal(leavesMyDay(lead('a', { next_due_on: '2026-11-01', first_attempt_at: 'x' }), TODAY), false)
  })
  test('a lead nobody has tried stays even with a later day: it may have come from ClickUp, which this screen cannot see', () => {
    assert.equal(leavesMyDay(lead('a', { next_due_on: '2026-11-30', first_attempt_at: null }), TODAY), false)
  })
})

describe('patchMyDay', () => {
  const day: MyDay = { rows: [lead('a'), lead('b'), lead('c')], done_today: 2, coming_up: 5 }
  test('the row is replaced where it stands', () => {
    const next = patchMyDay(day, lead('b', { temperature: 'hot' }), TODAY)
    assert.deepEqual(next.rows.map(r => r.id), ['a', 'b', 'c'])
    assert.equal(next.rows[1].temperature, 'hot')
    assert.equal(next.done_today, 2)
  })
  test('a lead that no longer belongs is taken off, and the others keep their order', () => {
    const next = patchMyDay(day, lead('b', { stage: 'dead' }), TODAY)
    assert.deepEqual(next.rows.map(r => r.id), ['a', 'c'])
  })
  test('a lead that was not on the list changes nothing (the same object comes back)', () => {
    assert.ok(patchMyDay(day, lead('z'), TODAY) === day)
  })
})

describe('matchesFilter', () => {
  test('every part of the filter must agree; a search never says yes', () => {
    assert.equal(matchesFilter(lead('a'), NONE), true)
    assert.equal(matchesFilter(lead('a'), { ...NONE, holder: 'u1', market: 'domestic', temperature: 'warm', source: 'website' }), true)
    assert.equal(matchesFilter(lead('a'), { ...NONE, holder: 'u2' }), false)
    assert.equal(matchesFilter(lead('a'), { ...NONE, temperature: 'hot' }), false)
    assert.equal(matchesFilter(lead('a'), { ...NONE, q: 'anna' }), false)
  })
})

describe('patchColumn', () => {
  test('in its own column the card is replaced where it stands', () => {
    const data = pages(page(3, lead('a'), lead('b')), page(3, lead('c')))
    const next = patchColumn(data, 'new', lead('c', { temperature: 'hot' }), 'new', NONE)
    assert.deepEqual(ids(next), ['a,b', 'c'])
    assert.equal(next.pages[1].rows[0].temperature, 'hot')
    assert.deepEqual(next.pages.map(p => p.n), [3, 3])
  })

  test('in another column the card is taken out and every page count goes down by one', () => {
    const data = pages(page(3, lead('a'), lead('b')), page(3, lead('c')))
    const next = patchColumn(data, 'new', lead('b', { stage: 'under_process' }), 'new', NONE)
    assert.deepEqual(ids(next), ['a', 'c'])
    assert.deepEqual(next.pages.map(p => p.n), [2, 2])
  })

  test('a lead that moved INTO the column appears at the top, and the count goes up', () => {
    const data = pages(page(2, lead('a'), lead('b')))
    const next = patchColumn(data, 'under_process', lead('z', { stage: 'under_process' }), 'new', NONE)
    assert.deepEqual(ids(next), ['z,a,b'])
    assert.equal(next.pages[0].n, 3)
  })

  test('an undo (from unknown) can bring a lead back into a column', () => {
    const next = patchColumn(pages(page(1, lead('a'))), 'new', lead('z'), null, NONE)
    assert.deepEqual(ids(next), ['z,a'])
  })

  test('an edit of a lead that sits on a page not loaded yet does NOT put a second copy at the top', () => {
    const data = pages(page(80, lead('a')))
    assert.ok(patchColumn(data, 'new', lead('far-down'), 'new', NONE) === data)
  })

  test('a lead the filter would not show is not put in, and a search never puts one in', () => {
    const data = pages(page(1, lead('a')))
    assert.ok(patchColumn(data, 'under_process', lead('z', { stage: 'under_process', temperature: 'cold' }), 'new', { ...NONE, temperature: 'hot' }) === data)
    assert.ok(patchColumn(data, 'under_process', lead('z', { stage: 'under_process' }), 'new', { ...NONE, q: 'anna' }) === data)
  })

  test('an empty list of pages gets nothing, and a column that does not hold the lead is untouched', () => {
    assert.ok(patchColumn(pages(), 'new', lead('z'), null, NONE) .pages.length === 0)
    const data = pages(page(1, lead('a')))
    assert.ok(patchColumn(data, 'negotiation', lead('z', { stage: 'new' }), 'new', NONE) === data)
  })
})

describe('applyWritten and settleWritten, on a real query client', () => {
  const colKey = (stage: Stage, f = NONE) => [SALES_KEY, 'board', 'column', stage, f] as const
  const sumKey = [SALES_KEY, 'board', NONE] as const

  function setup() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
    const fetched: Record<string, number> = {}
    const mount = (key: readonly unknown[], name: string, data: unknown) => {
      qc.setQueryData(key, data)
      const obs = new QueryObserver(qc, { queryKey: key, queryFn: async () => { fetched[name] = (fetched[name] ?? 0) + 1; return data }, staleTime: Infinity })
      return obs.subscribe(() => {})
    }
    const stops = [
      mount([SALES_KEY, 'my-day'], 'my-day', { rows: [lead('a')], done_today: 0, coming_up: 0 } satisfies MyDay),
      mount(sumKey, 'summary', { stats: {}, stages: {}, holders: [], waiting_allotment: null }),
      mount(colKey('new'), 'new', pages(page(1, lead('a')))),
      mount(colKey('under_process'), 'under_process', pages(page(1, lead('b', { stage: 'under_process' })))),
      mount(colKey('negotiation'), 'negotiation', pages(page(1, lead('c', { stage: 'negotiation' })))),
      mount([SALES_KEY, 'work', 'a'], 'work-a', { lead: lead('a'), events: [], activities: [] } as unknown as WorkDetail),
      mount([SALES_KEY, 'work', 'b'], 'work-b', { lead: lead('b'), events: [], activities: [] } as unknown as WorkDetail),
      mount([SALES_KEY, 'list', 'all'], 'list', { pages: [] }),
      mount([SALES_KEY, 'team'], 'team', {}),
    ]
    return { qc, fetched, stop: () => stops.forEach(s => s()) }
  }
  const settled = () => new Promise(r => setTimeout(r, 40))
  const moved: Written[] = [{ lead: lead('a', { stage: 'under_process', first_attempt_at: 'x', next_due_on: '2026-11-24' }), from: 'new' }]

  test('every screen shows the answer at once', () => {
    const { qc, stop } = setup()
    const touched = applyWritten(qc, moved, TODAY)
    assert.deepEqual([...touched].sort(), ['new', 'under_process'])
    assert.deepEqual(qc.getQueryData<MyDay>([SALES_KEY, 'my-day'])!.rows, [], 'tried and due tomorrow: off My day')
    assert.deepEqual(ids(qc.getQueryData(colKey('new')) as InfiniteData<BoardPage, number>), [''], 'out of New')
    assert.deepEqual(ids(qc.getQueryData(colKey('under_process')) as InfiniteData<BoardPage, number>), ['a,b'], 'at the top of Under Process')
    assert.equal(qc.getQueryData<WorkDetail>([SALES_KEY, 'work', 'a'])!.lead.stage, 'under_process', 'the open popup agrees')
    assert.equal(qc.getQueryData<WorkDetail>([SALES_KEY, 'work', 'b'])!.lead.stage, 'new', 'a popup of another lead is not touched by this one')
    stop()
  })

  test('only what may have changed is read again: My day, the totals, the two columns, the lead\'s popup', async () => {
    const { qc, fetched, stop } = setup()
    settleWritten(qc, moved, TODAY)
    await settled()
    assert.deepEqual(fetched, { 'my-day': 1, summary: 1, new: 1, under_process: 1, 'work-a': 1 }, 'not Negotiation, not another lead\'s popup, not the list or the team')
    stop()
  })

  test('what is not read again is marked old, so it is read when next opened', () => {
    const { qc, stop } = setup()
    settleWritten(qc, moved, TODAY)
    assert.equal(qc.getQueryState([SALES_KEY, 'team'])!.isInvalidated, true)
    assert.equal(qc.getQueryState(colKey('negotiation'))!.isInvalidated, true)
    stop()
  })

  test('readAgain: the rule on its own', () => {
    const touched = new Set<Stage>(['new'])
    const w: Written[] = [{ lead: lead('a'), from: 'new' }]
    assert.equal(readAgain([SALES_KEY, 'my-day'], touched, w), true)
    assert.equal(readAgain([SALES_KEY, 'board', NONE], touched, w), true)
    assert.equal(readAgain([SALES_KEY, 'board', 'column', 'new', NONE], touched, w), true)
    assert.equal(readAgain([SALES_KEY, 'board', 'column', 'dead', NONE], touched, w), false)
    assert.equal(readAgain([SALES_KEY, 'work', 'a'], touched, w), true)
    assert.equal(readAgain([SALES_KEY, 'work', 'zzz'], touched, w), false)
    assert.equal(readAgain([SALES_KEY, 'list', 'all'], touched, w), false)
    assert.equal(readAgain([SALES_KEY, 'people'], touched, w), false)
  })
})
