/**
 * THE FILES A SUBMITTED PI CARRIES — behaviour, run for real in a DOM.
 *
 * The owner could not open the Client PO or the Design Files on a PI waiting for
 * approval: the names were plain text, so there was nothing to judge the PI on.
 * What matters is that a person presses a name and the file opens, and that a
 * refusal says so instead of doing nothing.
 *
 * Run: npm run test:file -- src/components/orders/piSentFiles.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PiSentColumns } from './PiSupportingDocuments'
import { PiSupportingDetails } from './PiSupportingDetails'
import { sentWithPi, type PersistedDocumentSubmission } from '@/lib/orders/orderDocumentSubmissions'

const PO_PATH = 'pi-documents/pi/sub/client_po/po.pdf'
const DESIGN_PATH = 'pi-documents/pi/sub/design_files/plan.pdf'

const SENT = {
  id: 'sub', stage: 'initial', status: 'pending_admin', order_id: null, pi_submission_id: 'pi',
  submitted_at: '2026-10-30T05:00:00Z', operations_reviewer: null,
  files: [
    { id: 'f1', category: 'client_po', storage_path: PO_PATH, file_name: 'MFBPL PO.pdf', mime_type: 'application/pdf', size_bytes: 10 },
    { id: 'f2', category: 'design_files', storage_path: DESIGN_PATH, file_name: 'Furniture list.pdf', mime_type: 'application/pdf', size_bytes: 10 },
  ],
} as unknown as PersistedDocumentSubmission

/** Answers every read with `rows`; records every link asked for. */
function fakeClient(rows: unknown[], signed: string | null = 'https://files.test/signed') {
  const asked: { bucket: string; path: string; seconds: number }[] = []
  const query = () => {
    const q = {
      select: () => q, eq: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (done: (value: unknown) => unknown) => Promise.resolve(done({ data: rows, error: null })),
    }
    return q
  }
  const client = {
    from: query,
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, seconds: number) => {
          asked.push({ bucket, path, seconds })
          return { data: signed ? { signedUrl: signed } : null, error: signed ? null : { message: 'refused' } }
        },
      }),
    },
  }
  return { client: client as unknown as SupabaseClient, asked }
}

let opened: unknown[][] = []
let ui: ReturnType<typeof mount> | null = null
const realOpen = window.open

beforeEach(() => {
  opened = []
  window.open = ((...args: unknown[]) => { opened.push(args); return null }) as typeof window.open
})
afterEach(() => {
  ui?.unmount()
  ui = null
  window.open = realOpen
})

function columns(rows: PersistedDocumentSubmission[], signed?: string | null) {
  const fake = fakeClient([], signed)
  ui = mount(createElement(PiSentColumns, { supabase: fake.client, shown: sentWithPi(rows) }))
  return { ui, asked: fake.asked }
}

describe('a submitted PI: the Client PO and Design Files open', () => {
  test('pressing a name opens that file in a new tab', async () => {
    const { ui, asked } = columns([SENT])
    ui.click(ui.button('MFBPL PO.pdf'))
    await ui.settle()
    assert.deepEqual(asked, [{ bucket: 'order-files', path: PO_PATH, seconds: 60 }])
    assert.deepEqual(opened, [['https://files.test/signed', '_blank', 'noopener,noreferrer']])
  })

  test('each column opens its own file', async () => {
    const { ui, asked } = columns([SENT])
    ui.click(ui.button('Furniture list.pdf'))
    await ui.settle()
    assert.equal(asked[0]?.path, DESIGN_PATH)
  })

  test('a refused link says so under that column, and nothing opens', async () => {
    const { ui } = columns([SENT], null)
    ui.click(ui.button('MFBPL PO.pdf'))
    await ui.settle()
    assert.equal(opened.length, 0)
    const alert = ui.one('[role="alert"]')
    assert.match(alert.textContent ?? '', /could not be opened/)
    assert.ok(ui.one('[aria-label="Client PO"]').contains(alert), 'said where the person pressed')
    assert.ok(ui.button('MFBPL PO.pdf'), 'the name stays, so it can be tried again')
  })

  test('a PI sent with no files says so, with nothing to press', () => {
    const { ui } = columns([])
    assert.equal(ui.all('.pi-attach-name').length, 0)
    assert.equal(ui.all('.pi-attach-state').length, 2)
    assert.match(ui.text(), /None attached/)
  })

  test('nothing is offered to add or remove', () => {
    const { ui } = columns([SENT])
    assert.equal(ui.all('input[type="file"]').length, 0)
    assert.equal(ui.all('.pi-attach-remove').length, 0)
  })
})

describe('the locked Supporting details', () => {
  test('hand the files the same client, so they open from the real page section', async () => {
    const fake = fakeClient([SENT])
    ui = mount(createElement(PiSupportingDetails, {
      supabase: fake.client, submissionId: 'pi', rowVersion: 1, canEditFiles: false, canEditHighlight: false,
      locked: true, submittedAt: '2026-10-30T05:00:00Z', onSaved: () => {}, onHighlightRead: () => {},
      supporting: { stagedReadable: true } as Parameters<typeof PiSupportingDetails>[0]['supporting'],
    }))
    await ui.settle()
    ui.click(ui.button('Furniture list.pdf'))
    await ui.settle()
    assert.equal(fake.asked[0]?.path, DESIGN_PATH)
    assert.equal(opened.length, 1)
  })
})
