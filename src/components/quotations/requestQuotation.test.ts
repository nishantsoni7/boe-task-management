// The request page shows its quotation; Excel needs a reason; the salesperson asks for a change (owner, 18 Nov 2026).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { requestQuotationMeta } from './QuotationLinks'

const read = (p: string) => readFileSync(p, 'utf8')

describe('requestQuotationMeta', () => {
  test('version, sent day and the client opening, in IST', () => {
    assert.equal(requestQuotationMeta({ version_no: 2, sent_at: '2026-11-17T20:00:00Z', last_opened_at: '2026-11-18T05:00:00Z' }),
      'version 2 · sent 18 Nov 2026 · client opened 18 Nov 2026')
  })
  test('a quotation not sent yet says so, and leaves out what it does not have', () => {
    assert.equal(requestQuotationMeta({ version_no: null, sent_at: null, last_opened_at: null }), 'not sent yet')
  })
})

describe('the request page', () => {
  const view = read('src/components/tasks/QuotationDetailView.tsx')
  const page = read('src/app/tasks/[id]/page.tsx')
  const links = read('src/components/quotations/QuotationLinks.tsx')
  test('shows the quotation for everyone who may see it, and Build in BOE One to the maker when there is none', () => {
    assert.ok(view.includes('<RequestQuotation supabase={p.supabase} taskId={task.id} canMake={p.canSend && !done} />'))
    assert.ok(links.includes("supabase.rpc('quotation_for_request', { p_task_id: taskId })"))
    assert.ok(links.includes('if (!q) return canMake ? <MakeInQuotations supabase={supabase} taskId={taskId} /> : null'))
    for (const label of ['Open builder', 'PDF', 'WhatsApp']) assert.ok(links.includes(label), label)
  })
  test('sending a file needs the reason, which leads the note', () => {
    assert.ok(view.includes("'Send as Excel'"))
    assert.ok(view.includes('disabled={c.saving || !gate.ok || !excelReason.trim()}'))
    assert.ok(page.includes('saveComment(excelReason ? `Sent as Excel: ${excelReason}` : undefined)'))
    assert.ok(page.includes("const noteText = [lead?.trim(), commentNote.trim()].filter(Boolean).join('\\n')"))
  })
  test('no button hands its click event to a handler that now takes text', () => {
    assert.ok(!page.includes('onClick={saveComment}'))
    assert.ok(!page.includes('onClick={handleReopen}'))
  })
  test('the salesperson asks for a change with a note; the maker still reopens for revision', () => {
    assert.ok(page.includes("canReopen={task.status === 'completed' && isAssignee}"))
    assert.ok(page.includes("canAskChange={task.status === 'completed' && isCreator && !isAssignee}"))
    assert.ok(view.includes('onClick={() => p.onReopen(changeNote.trim())}'))
    const route = read('src/app/api/restore-task/route.ts')
    assert.ok(route.includes("changeNote ? `Change asked: ${changeNote}` : 'Reopened task'"))
    assert.ok(route.includes('reason.trim().slice(0, 1000)'))
  })
  test('the migration is one read function, closed to anon, with the quotation_sees rule', () => {
    const sql = read('supabase/migrations/20270805000000_quotation_for_request.sql')
    assert.match(sql, /create or replace function public\.quotation_for_request\(p_task_id uuid\)\s+returns jsonb language plpgsql stable security definer/)
    assert.ok(sql.includes('public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all)'))
    assert.ok(sql.includes('revoke all on function public.quotation_for_request(uuid) from public, anon;'))
    assert.ok(!/\b(insert|update|delete)\b\s+(into\s+)?public\./i.test(sql), 'reads only')
  })
})

test('"Make it in Quotations" no longer creates a quotation: it points to New quotation, which starts from a lead', () => {
  const links = readFileSync('src/components/quotations/QuotationLinks.tsx', 'utf8')
  assert.ok(!links.includes('quotation_create_from_request'))
  assert.match(links, /href="\/quotations\?new=1"/)
})
