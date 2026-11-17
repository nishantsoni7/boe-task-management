// What a draft order's page draws: the fields, the files with the date each was
// uploaded (in IST), the comments, and the plain words for what is missing.
// The order is invented; real orders are customer data and never enter the repository.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { OrderView } from './OrderView'
import type { DraftOrder } from '@/lib/orders/clickupDrafts'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const ORDER_ID = '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const FILE_ID = '3f2c1a9e-5b7d-4c8e-9a10-0123456789ab.xlsx'

const order = (patch: Partial<DraftOrder> = {}): DraftOrder => ({
  id: ORDER_ID,
  clickup_id: '86abc123',
  clickup_custom_id: 'BOE-1',
  order_no: '535',
  name: '535 Sample Client',
  client_name: 'Sample Client',
  status: 'running orders',
  created_in_clickup: '2026-10-01T12:02:00.000Z',
  updated_in_clickup: null,
  closed_in_clickup: null,
  start_date: null,
  due_date: '2026-11-06',
  created_by_name: 'Uploader One',
  assignees: ['Salesperson One'],
  tags: ['commission'],
  priority: '',
  description: 'Deliver in two lots.',
  fields: { 'Total Product Value': '361900', Phone: '+91 90000 00000', 'Confirm Date': '2026-09-30', 'FABRIC STATUS': 'FABRIC PENDING' },
  checklists: [{ name: 'Pack', items: [{ name: 'Tag', resolved: true }, { name: 'Box', resolved: false }] }],
  subtasks: [],
  status_history: [{ status: 'running orders', since: '2026-10-01T12:02:00.000Z' }],
  comments: [
    { id: '1', at: '2026-10-01T12:09:57.000Z', by: 'Uploader One', reply_to: null, text: 'PI attached' },
    { id: '2', at: '2026-10-02T04:30:00.000Z', by: 'Salesperson One', reply_to: '1', text: '' },
  ],
  files: [{ id: FILE_ID, name: '535 Sample ji.xlsx', uploaded_at: '2026-10-01T12:09:56.000Z', uploaded_by: 'Uploader One', size: 2346671, sha256: 'a'.repeat(64) }],
  file_count: 1,
  comment_count: 2,
  imported_at: '2026-11-14T05:00:00.000Z',
  ...patch,
})

describe('a draft order page', () => {
  test('the file shows its upload date and time in IST, who uploaded it, its size and a download link', () => {
    const html = renderToStaticMarkup(<OrderView order={order()} />)
    const t = text(html)
    assert.ok(t.includes('535 Sample ji.xlsx'))
    assert.ok(/1 Oct 2026, 5:39 pm/i.test(t), `upload date in IST, got: ${t.slice(t.indexOf('Files'), t.indexOf('Files') + 160)}`)
    assert.ok(t.includes('2.2 MB'))
    assert.ok(html.includes(`href="/api/orders/clickup-drafts/${ORDER_ID}/files/${FILE_ID}"`))
  })

  test('the client details lead with the fields people look for, the value in rupees', () => {
    const t = text(renderToStaticMarkup(<OrderView order={order()} />))
    assert.ok(t.indexOf('Confirm Date') < t.indexOf('Total Product Value'))
    assert.ok(t.indexOf('Total Product Value') < t.indexOf('Phone'))
    assert.ok(t.includes('₹3,61,900'))
    assert.ok(t.includes('+91 90000 00000'))
  })

  test('who, when and what for the order, the comments and the history', () => {
    const t = text(renderToStaticMarkup(<OrderView order={order()} />))
    assert.ok(t.includes('Running orders'))
    assert.ok(t.includes('Draft, copied from ClickUp'))
    assert.ok(t.includes('Assigned Salesperson One'))
    assert.ok(t.includes('Deliver in two lots.'))
    assert.ok(t.includes('Comments (2)'))
    assert.ok(t.includes('PI attached'))
    assert.ok(t.includes('(a file only)'), 'a comment that was only a file says so')
    assert.ok(t.includes('Running orders since'))
    assert.ok(t.includes('ClickUp task 86abc123 (BOE-1)'))
  })

  test('what ClickUp did not hold is said in words, not left blank', () => {
    const t = text(renderToStaticMarkup(<OrderView order={order({ files: [], comments: [], fields: {}, description: '', checklists: [], status_history: null, file_count: 0, comment_count: 0 })} />))
    assert.ok(t.includes('No file was attached to this order in ClickUp.'))
    assert.ok(t.includes('No comments.'))
    assert.ok(t.includes('ClickUp held no details for this order.'))
    assert.equal(t.includes('Description'), false)
    assert.equal(t.includes('Checklists'), false)
    assert.equal(t.includes('Status history'), false)
  })

  test('a file name is text, never markup', () => {
    const html = renderToStaticMarkup(<OrderView order={order({ files: [{ id: FILE_ID, name: '<img src=x onerror=alert(1)>.xlsx', uploaded_at: null, uploaded_by: '', size: 10, sha256: '' }] })} />)
    assert.equal(html.includes('<img'), false)
    assert.ok(html.includes('&lt;img'))
  })

  test('the figures people ask for sit in one strip under the status, before any detail', () => {
    const html = renderToStaticMarkup(<OrderView order={order()} />)
    assert.ok(html.includes('aria-label="Order at a glance"'))
    const t = text(html)
    for (const pair of ['Value ₹3,61,900', 'Confirm date 30 Sept 2026', 'Due 6 Nov 2026', 'Assigned Salesperson One', 'Files 1', 'Comments 2']) assert.ok(t.includes(pair), pair)
    assert.ok(html.indexOf('aria-label="Order at a glance"') < html.indexOf('aria-label="Order details"'))
  })

  test('with no value, nobody assigned and no date the strip says nobody or shows a dash, never a blank', () => {
    const t = text(renderToStaticMarkup(<OrderView order={order({ assignees: [], due_date: null, fields: {}, files: [], comments: [] })} />))
    assert.ok(t.includes('Value —'))
    assert.ok(t.includes('Due —'))
    assert.ok(t.includes('Assigned Nobody'))
    assert.ok(t.includes('Files 0'))
  })

  test('the fields come in groups (the order, the client, the rest), labels read as words, dates as dates, fabric and finish as pills', () => {
    const o = order({ fields: {
      'Total Product Value': '361900', 'Dispatch Date': '2026-11-20', 'FABRIC STATUS': 'FABRIC PENDING', 'FINISH STATUS': 'FINISH APPROVED',
      Phone: '+91 90000 00000', 'CUSTOMER BILLING': '1 Invented Road', 'Sample Approved': 'Yes', 'Another Note': 'x',
    } })
    const html = renderToStaticMarkup(<OrderView order={o} />)
    const at = (title: string) => html.indexOf(`aria-label="${title}"`)
    assert.ok(at('Order details') > 0 && at('Order details') < at('Client') && at('Client') < at('Other ClickUp fields'))
    const t = text(html)
    assert.ok(t.includes('Customer billing') && !t.includes('CUSTOMER BILLING'), 'an all-capitals label is made readable')
    assert.ok(t.includes('Sample Approved'), 'a mixed-case label is left as it is')
    assert.ok(t.indexOf('Another Note') < t.indexOf('Sample Approved'), 'the rest are alphabetical')
    assert.ok(t.includes('20 Nov 2026') && !t.includes('2026-11-20'), 'a date reads as a date')
    assert.ok(html.includes('fin-pill fin-pill--zero">Pending') && html.includes('fin-pill fin-pill--full">Approved'))
  })

  test('the PI sheet sits right under the figures, above the details and the files', () => {
    const html = renderToStaticMarkup(<OrderView order={order()} piSheet={<section aria-label="PI sheet">SHEET-MARKER</section>} />)
    const at = html.indexOf('SHEET-MARKER')
    assert.ok(html.indexOf('aria-label="Order at a glance"') < at)
    assert.ok(at < html.indexOf('aria-label="Order details"'))
    assert.ok(at < html.indexOf('aria-label="Files"'))
  })

  test('files are a list, not a table: name, upload date, who, size, and a Download button named for the file', () => {
    const html = renderToStaticMarkup(<OrderView order={order()} />)
    assert.ok(html.includes('<ul class="fileList">'))
    assert.equal(html.includes('<table'), false)
    assert.ok(html.includes('aria-label="Download 535 Sample ji.xlsx"'))
    assert.ok(/class="boe-btn boe-btn-secondary dl"/.test(html))
  })

  test('the status row names where the order stands in its own colour; the title above already names the order', () => {
    const html = renderToStaticMarkup(<OrderView order={order({ status: 'dispatched' })} />)
    assert.ok(html.includes('fin-pill fin-pill--neutral">Dispatched'))
    assert.ok(html.includes('fin-pill fin-pill--neutral">Draft, copied from ClickUp'))
    assert.equal(html.includes('<h2'), false, 'one heading per page: the layout title')
  })
})
