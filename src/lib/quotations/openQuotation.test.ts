// Opening a quotation (23 Nov 2026, page speed): its first reads leave with the click, under the keys the builder reads,
// and the screens that open it no longer use a bare router.push (which showed nothing while the page loaded).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { QueryClient } from '@tanstack/react-query'
import { OPEN_FRESH_MS, startOpeningReads } from './openQuotation'
import { pictureMarkKey, quotationKeys, suggestionsKey, type Quotation } from './api'

const BUILDER = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')
const REQUESTS = readFileSync('src/components/quotations/RequestsScreen.tsx', 'utf8')
const LIST = readFileSync('src/components/quotations/ListScreen.tsx', 'utf8')

const SAVED = { quotation: { id: 'q1', quote_no: 'QT-S-01018', status: 'draft' }, owner_name: 'Asha', may_edit: true, areas: [], lines: [], events: [] }
const answer = (fn: string) => (fn === 'quotation_get' ? SAVED : fn === 'quotation_picture_mark_get' ? true : { for_me: true })

function fake(fail = false) {
  const calls: string[] = []
  const client = {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push(args.p_id ? `${fn}:${String(args.p_id)}` : fn)
      return fail ? { data: null, error: { message: 'boom' } } : { data: answer(fn), error: null }
    },
  }
  return { calls, client: client as never }
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)) }

describe('opening a quotation starts its reads at the click', () => {
  test('the quotation, the picture-mark switch and the suggestions switch leave at once, under the keys the builder reads', async () => {
    const qc = newClient(); const sb = fake()
    startOpeningReads(qc, sb.client, 'q1'); await settle()
    assert.deepEqual([...sb.calls].sort(), ['quotation_get:q1', 'quotation_picture_mark_get:q1', 'quotation_suggestions_get'])
    assert.equal((qc.getQueryData(quotationKeys.one('q1')) as Quotation).quote_no, 'QT-S-01018')
    assert.equal(qc.getQueryData(pictureMarkKey('q1')), true)
    assert.deepEqual(qc.getQueryData(suggestionsKey), { for_me: true })
  })

  test('pressing it again inside the fresh window asks nobody again', async () => {
    const qc = newClient(); const sb = fake()
    startOpeningReads(qc, sb.client, 'q1'); await settle()
    startOpeningReads(qc, sb.client, 'q1'); await settle()
    assert.equal(sb.calls.length, 3)
    assert.equal(OPEN_FRESH_MS, 10_000)
  })

  test('a read that fails never throws at the click; the builder asks again when it opens', async () => {
    const qc = newClient(); const sb = fake(true)
    assert.doesNotThrow(() => startOpeningReads(qc, sb.client, 'q1')); await settle()
    assert.equal(qc.getQueryData(quotationKeys.one('q1')), undefined)
  })
})

describe('the builder and the screens that open it', () => {
  test('the first reads do not wait for the access answer, and share the click\'s keys and freshness', () => {
    assert.match(BUILDER, /queryKey: quotationKeys\.one\(id\), queryFn: \(\) => fetchQuotation\(supabase, id\), staleTime: OPEN_FRESH_MS, retry: false/)
    assert.match(BUILDER, /queryKey: pictureMarkKey\(id\), queryFn: \(\) => fetchPictureMark\(supabase, id\), staleTime: OPEN_FRESH_MS, retry: false/)
    assert.match(BUILDER, /queryKey: suggestionsKey, queryFn: \(\) => fetchSuggestionSettings\(supabase\), enabled: !notSetUp/)
    assert.doesNotMatch(BUILDER, /fetchQuotation\(supabase, id\), enabled/)
  })

  test('the screen still waits for access before it draws, and shows the frame with a skeleton, never the full-page spinner', () => {
    assert.match(BUILDER, /if \(!accessLoaded \|\| !base \|\| !h \|\| !totals\) return skeleton\(\)/)
    assert.match(BUILDER, /if \(loading\) return skeleton\(\)/)
    assert.doesNotMatch(BUILDER, /LoadingScreen/)
  })

  test('the first fill of price hints goes at once; a typing pause still waits 600 ms', () => {
    assert.match(BUILDER, /hintsAsked\.current \|\| dirtyRef\.current \? 600 : 0/)
  })

  test('the Requests and Quotations rows open through the hook, not a bare router.push', () => {
    assert.match(REQUESTS, /useOpenQuotation\(supabase\)/)
    assert.doesNotMatch(REQUESTS, /router\.push\(`\/quotations\/\$\{r\.quotation_id\}`\)/)
    assert.match(LIST, /useOpenQuotation\(supabase\)/)
    assert.doesNotMatch(LIST, /onOpen=\{\(\) => router\.push/)
  })

  test('the quotation route has a loading boundary that draws the Quotations shell', () => {
    assert.ok(existsSync('src/app/quotations/[id]/loading.tsx'))
    assert.match(readFileSync('src/app/quotations/[id]/loading.tsx', 'utf8'), /QuotationsRouteFallback/)
    assert.match(readFileSync('src/components/quotations/QuotationsRouteFallback.tsx', 'utf8'), /<ModulePageSkeleton variant="record"/)
  })
})
