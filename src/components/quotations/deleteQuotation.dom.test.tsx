// Deleting a quotation (owner, 20 Nov 2026; 20270817000000): the confirm, the Status card's Delete button and the list's bin, run for real.
// The database decides who may delete what (quotation_delete_blocker, proved in supabase/tests/quotations_pglite.mjs); these prove the
// screens ask it, show its answer, and leave the page the way the owner asked.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DeleteQuotationDialog, goneOutNote, type DeleteTarget } from './DeleteQuotationDialog'
import { StatusCard } from './StatusCard'
import type { Quotation, QuotationStatus } from '@/lib/quotations/api'

const TARGET: DeleteTarget = { id: 'q-1', quote_no: 'QT-NS-01009', client_name: 'Hotel Aravali', project_name: 'Aravali Resort', status: 'draft' }

function open(target: DeleteTarget, answer: { error: { message: string } | null }) {
  const calls: { fn: string; args: unknown }[] = []
  let closed = 0, deleted = 0
  const supabase = { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: null, error: answer.error } } }
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false }, mutations: { gcTime: Infinity } } })
  const ui = mount(createElement(QueryClientProvider, { client: qc },
    createElement(DeleteQuotationDialog, { supabase: supabase as never, target, onClose: () => { closed++ }, onDeleted: () => { deleted++ } })))
  return { ui, calls, closed: () => closed, deleted: () => deleted }
}

describe('the delete confirm', () => {
  test('names the quotation, says what goes and that it cannot be undone; a draft gets no warning about a client link', () => {
    const { ui } = open(TARGET, { error: null })
    const text = ui.text()
    assert.match(text, /Delete QT-NS-01009\?/)
    assert.match(text, /Aravali Resort/)
    assert.match(text, /Hotel Aravali/)
    assert.match(text, /rooms, products and history\. It cannot be undone/)
    assert.ok(!/client link/.test(text))
    ui.unmount()
  })
  test('a quotation that has gone out (only an administrator reaches this) warns that its client link stops working', () => {
    assert.equal(goneOutNote('draft'), null)
    for (const st of ['sent', 'negotiating', 'confirmed', 'lost', 'archived'] as QuotationStatus[]) assert.match(goneOutNote(st) ?? '', /client link was shared, the link stops working/)
    const { ui } = open({ ...TARGET, status: 'sent' }, { error: null })
    assert.match(ui.text(), /It is marked Sent\./)
    ui.unmount()
  })
  test('Delete calls quotation_delete with the id, then reports it deleted', async () => {
    const { ui, calls, closed, deleted } = open(TARGET, { error: null })
    ui.click(ui.button('Delete quotation'))
    await ui.settle(); await ui.settle()
    assert.deepEqual(calls, [{ fn: 'quotation_delete', args: { p_id: 'q-1' } }])
    assert.equal(deleted(), 1)
    assert.equal(closed(), 0)
    ui.unmount()
  })
  test('a refusal (it was sent to a senior a moment ago) is shown in the database\'s words; nothing is reported deleted and the dialog stays', async () => {
    const { ui, deleted, closed } = open(TARGET, { error: { message: 'QUOTATION_LOCKED: This quotation was sent to a senior for prices or checking, so it can be changed but not deleted.' } })
    ui.click(ui.button('Delete quotation'))
    await ui.settle(); await ui.settle()
    assert.match(ui.text(), /sent to a senior for prices or checking, so it can be changed but not deleted/)
    assert.ok(!/QUOTATION_LOCKED/.test(ui.text()))
    assert.equal(deleted(), 0)
    assert.equal(closed(), 0)
    ui.unmount()
  })
  test('Keep it, × and Escape close it without deleting anything', () => {
    const { ui, calls, closed } = open(TARGET, { error: null })
    ui.click(ui.button('Keep it'))
    ui.click(ui.one('button[aria-label="Close"]'))
    ui.press('Escape')
    assert.equal(closed(), 3)
    assert.equal(calls.length, 0)
    ui.unmount()
  })
})

const quote = (o: Partial<Quotation> = {}) => ({ id: 'q1', quote_no: 'QT-1', status: 'draft' as QuotationStatus, may_edit: true, pi: null, price: null, share_token: null, ...o }) as Quotation
function card(base: Quotation, over: Partial<Parameters<typeof StatusCard>[0]> = {}) {
  return createElement(StatusCard, { base, dirty: false, busy: false, isAdmin: false, canConfirm: false, piProblems: [], priceBlocked: false, piStage: null,
    lostNote: null, setLostNote: () => {}, lostReason: '', setLostReason: () => {}, onMove: () => {}, onConfirm: () => {}, ...over })
}

describe('the Status card\'s Delete button', () => {
  test('is there only when the database said the person may delete, and pressing it asks to confirm', () => {
    assert.ok(!/Delete…/.test(renderToStaticMarkup(card(quote()))), 'no answer yet: no button')
    assert.ok(!/Delete…/.test(renderToStaticMarkup(card(quote(), { canDelete: false, onDelete: () => {} }))), 'not allowed: no button')
    assert.match(renderToStaticMarkup(card(quote(), { canDelete: true, onDelete: () => {} })), /Delete…/)
    let asked = 0
    const ui = mount(card(quote(), { canDelete: true, onDelete: () => { asked++ } }))
    ui.click(ui.button('Delete…'))
    assert.equal(asked, 1)
    ui.unmount()
  })
  test('an administrator sees it on a locked quotation too (the card has no other outcome there)', () => {
    assert.match(renderToStaticMarkup(card(quote({ status: 'archived', may_edit: true }), { isAdmin: true, canDelete: true, onDelete: () => {} })), /Other outcome[\s\S]*Delete…/)
  })
})

describe('where the Delete is wired', () => {
  const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')
  test('the list shows a bin only on a row the database marked may_delete, and the click does not open the row', () => {
    const list = read('src/components/quotations/ListScreen.tsx')
    assert.match(list, /\{r\.may_delete && \(\s*<button[^>]*aria-label=\{`Delete \$\{r\.quote_no\}`\}/)
    assert.match(list, /onClick=\{e => \{ e\.stopPropagation\(\); onDelete\(\) \}\}/)
    assert.match(list, /<DeleteQuotationDialog supabase=\{supabase\} target=\{toDelete\}/)
  })
  test('the page asks quotation_delete_check, leaves for the list after a delete, and clears its unsaved-edits guard first', () => {
    const page = read('src/components/quotations/BuilderScreen.tsx')
    assert.match(page, /queryFn: \(\) => fetchDeleteCheck\(supabase, id\)/)
    assert.match(page, /canDelete=\{delQ\.data\?\.may === true\} onDelete=\{\(\) => setDeleting\(true\)\}/)
    assert.match(page, /onDeleted=\{\(\) => \{ dirtyRef\.current = false; router\.push\('\/quotations'\) \}\}/)
  })
  test('the api calls the two functions the migration makes, and the list row type carries may_delete', () => {
    const api = read('src/lib/quotations/api.ts')
    assert.match(api, /s\.rpc\('quotation_delete_check', \{ p_id: id \}\)/)
    assert.match(api, /s\.rpc\('quotation_delete', \{ p_id: id \}\)/)
    assert.match(api, /may_delete\?: boolean/)
  })
  test('the confirm uses the shared dialog keyboard hook like every other quotation dialog', () => {
    const src = read('src/components/quotations/DeleteQuotationDialog.tsx')
    assert.match(src, /const dialogRef = useDialogFocus</)
    assert.match(src, /ref=\{dialogRef\} tabIndex=\{-1\} className=\{s\.modal\}/)
  })
})
