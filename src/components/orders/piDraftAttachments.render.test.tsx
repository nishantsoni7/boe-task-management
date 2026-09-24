/**
 * CLIENT PO AND DESIGN FILES ON THE PI DRAFT (20270102000000), rendered.
 *
 * The card attaches files to a draft before it is sent; the "Submit for
 * approval" dialog then sends them. What is pinned here is what a person sees:
 * no upload offered where the database cannot keep it, the file names (never a
 * storage key), and edit controls only for someone who may edit the draft.
 *
 * Run:
 *   npx tsx --test src/components/orders/piDraftAttachments.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DRAFT_ATTACHMENTS_NOTE,
  DRAFT_ATTACHMENTS_TITLE,
  PiDraftAttachments,
  type StagedDocument,
  type SupportingState,
} from './PiSupportingDocuments'

const supabase = {} as SupabaseClient

const staged: StagedDocument[] = [
  { id: 'a', staging_submission_id: 's', category: 'design_files', file_name: 'Sofa elevation.png',
    storage_path: 'pi-documents/p/s/design_files/0f.png' },
  { id: 'b', staging_submission_id: 's', category: 'client_po', file_name: 'Client PO 118.pdf',
    storage_path: 'pi-documents/p/s/client_po/1e.pdf' },
]

const state = (over: Partial<SupportingState> = {}): SupportingState => ({
  previous: [], keep: new Set(), toggle: () => {}, design: [], po: [], pick: () => {},
  error: null, missing: [], send: async () => ({ data: null, error: null }),
  staged: [], stagedReadable: true, staging: false,
  stage: async () => null, unstage: async () => null,
  ...over,
} as SupportingState)

const html = (s: SupportingState, canEdit = true) =>
  renderToStaticMarkup(<PiDraftAttachments supabase={supabase} state={s} canEdit={canEdit} />)

describe('the draft attachments card', () => {
  test('offers nothing where the database cannot keep the files — no fake upload', () => {
    assert.equal(html(state({ stagedReadable: false })), '')
  })

  test('the owner sees both optional categories and an Add control for each', () => {
    const out = html(state())
    assert.ok(out.includes(DRAFT_ATTACHMENTS_TITLE))
    assert.ok(DRAFT_ATTACHMENTS_TITLE.includes('optional'), 'important, but never mandatory')
    assert.ok(out.includes('Add Design Files') && out.includes('Add Client PO'))
    assert.equal((out.match(/None attached yet/g) ?? []).length, 2)
    assert.ok(out.includes(DRAFT_ATTACHMENTS_NOTE))
    assert.ok(/<input[^>]*type="file"[^>]*multiple=""/.test(out), 'several design files at once')
  })

  test('attached files are listed by NAME, each can be opened and removed', () => {
    const out = html(state({ staged }))
    assert.ok(out.includes('Sofa elevation.png') && out.includes('Client PO 118.pdf'))
    assert.ok(!out.includes('pi-documents/'), 'a storage key is never shown')
    assert.ok(out.includes('aria-label="Remove Sofa elevation.png"'))
  })

  test('someone who may not edit the draft sees the files and no controls', () => {
    const out = html(state({ staged }), false)
    assert.ok(out.includes('Client PO 118.pdf'))
    assert.ok(!out.includes('Remove') && !out.includes('type="file"'))
    assert.equal(html(state(), false), '', 'and nothing at all when there is nothing to see')
  })

  test('staged files are sent under the id they were uploaded with, through #202’s door', () => {
    const src = readFileSync('src/components/orders/PiSupportingDocuments.tsx', 'utf8')
    assert.ok(src.includes('const documentSubmissionId = stagingId ?? crypto.randomUUID()'))
    assert.ok(src.includes("supabase.rpc('submit_pi_for_review_with_documents'"))
    assert.ok(src.includes(".from('order_pi_staged_documents')"))
  })
})
