/**
 * Quotation Details — sending a quotation.
 *
 * Pure helpers plus pins on how the Task Detail page wires the quotation view.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/quotationSend.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  QUOTATION_SENT_MARKER, isQuotationSentEntry, latestSentQuotation, quotationSendGate,
  sentQuotationCount, waitingLabel,
} from './quotationSend'
import { leadNameOf } from '@/components/tasks/QuotationDetailView'
import type { LogEntry } from '@/lib/types'

const entry = (id: string, over: Partial<LogEntry> = {}): LogEntry => ({
  id, action: 'note_added', note: null, from_status: null, to_status: null,
  old_val: null, new_val: null, created_at: '2026-10-21T10:00:00Z', actor_id: 'u1', attachments: [],
  ...over,
})
const att = (id: string, name: string) =>
  ({ id, file_name: name, file_type: 'PDF', storage_path: `tasks/t/${id}.pdf`, url: '' }) as never

describe('which update is the sent quotation', () => {
  test('only a note_added row carrying the marker', () => {
    assert.equal(isQuotationSentEntry(entry('a', { new_val: QUOTATION_SENT_MARKER })), true)
    assert.equal(isQuotationSentEntry(entry('b')), false)
    assert.equal(isQuotationSentEntry(entry('c', { action: 'status_changed', new_val: QUOTATION_SENT_MARKER })), false)
  })

  test('the newest sent quotation wins, with its files and note', () => {
    const log = [
      entry('new', { new_val: QUOTATION_SENT_MARKER, note: ' v2 attached ', attachments: [att('f2', 'Quote v2.pdf')] }),
      entry('msg', { note: 'ok thanks', attachments: [att('m', 'photo.pdf')] }),
      entry('old', { new_val: QUOTATION_SENT_MARKER, attachments: [att('f1', 'Quote v1.pdf')] }),
    ]
    const sent = latestSentQuotation(log)
    assert.equal(sent?.entryId, 'new')
    assert.equal(sent?.note, 'v2 attached')
    assert.deepEqual(sent?.files.map(f => f.fileName), ['Quote v2.pdf'])
    assert.equal(sentQuotationCount(log), 2)
  })

  test("sales' files and ordinary messages are never the quote", () => {
    const log = [entry('msg', { note: 'hi', attachments: [att('m', 'photo.pdf')] })]
    assert.equal(latestSentQuotation(log), null)
    assert.equal(sentQuotationCount(log), 0)
  })
})

describe('the send gate', () => {
  test('a quote file is required', () => {
    const g = quotationSendGate([])
    assert.equal(g.ok, false)
  })
  test('a failed upload blocks, one still uploading does not', () => {
    assert.equal(quotationSendGate([{ status: 'failed' }]).ok, false)
    assert.equal(quotationSendGate([{ status: 'uploading' }]).ok, true)
    assert.equal(quotationSendGate([{ status: 'uploaded' }, { status: 'preparing' }]).ok, true)
  })
})

describe('small labels', () => {
  const t0 = '2026-10-21T10:00:00Z'
  const at = (mins: number) => new Date(t0).getTime() + mins * 60000
  test('waiting time', () => {
    assert.equal(waitingLabel(t0, at(0)), '1 min')
    assert.equal(waitingLabel(t0, at(45)), '45 min')
    assert.equal(waitingLabel(t0, at(180)), '3 h')
    assert.equal(waitingLabel(t0, at(24 * 60)), '1 day')
    assert.equal(waitingLabel(t0, at(3 * 24 * 60)), '3 days')
  })
  test('lead name prefers the stored customer, else strips the title prefix', () => {
    assert.equal(leadNameOf({ title: 'Quotation - Koti Shetty Sir {Hotel}', customer_name: null }), 'Koti Shetty Sir {Hotel}')
    assert.equal(leadNameOf({ title: 'Quotation - x', customer_name: ' Taj ' }), 'Taj')
  })
})

describe('Task Detail wiring', () => {
  const PAGE = readFileSync('src/app/tasks/[id]/page.tsx', 'utf8').replace(/\r\n/g, '\n')
  const VIEW = readFileSync('src/components/tasks/QuotationDetailView.tsx', 'utf8').replace(/\r\n/g, '\n')

  test('only a live quotation task gets the new view; ordinary tasks keep the task layout', () => {
    assert.ok(PAGE.includes("{isQuotation && task.status !== 'cancelled' ? ("))
    assert.ok(PAGE.includes('<div className="boe-task-2col">'), 'the ordinary layout is still there')
    assert.ok(PAGE.includes('{activityCard}'), 'the activity feed is shared by both layouts')
  })

  test('sending saves the tagged update first, then completes — never the other way round', () => {
    const send = PAGE.slice(PAGE.indexOf('const sendQuotation = async'), PAGE.indexOf('const activityCard = ('))
    const saved = send.indexOf('await saveComment()')
    const completed = send.indexOf("applyStatusChange('completed', null)")
    assert.ok(saved > 0 && completed > saved)
    assert.ok(send.includes('quotationSendGate(attachmentQueue.items())'), 'a quote file is required')
    assert.ok(send.includes('sendingQuotationRef.current = false'), 'the tag is always released')
  })

  test('the tag lands on the update row and silences the duplicate comment notice', () => {
    assert.ok(PAGE.includes('new_val:        sendingQuotationRef.current ? QUOTATION_SENT_MARKER : null'))
    assert.ok(PAGE.includes('recipient !== currentUserId && !sendingQuotationRef.current'))
  })

  test('the view offers no Mark Complete and no task controls', () => {
    assert.equal(VIEW.includes('Mark Quotation Complete'), false)
    assert.ok(VIEW.includes('Send Quotation to'))
    assert.ok(VIEW.includes('Reopen for revision'))
    assert.equal(VIEW.includes('Acknowledge'), false)
  })
})
