import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readOpenDocumentSubmissions, readOpenPiRevisions } from './DocumentActionQueue'

// "Needs your decision" and the documents list load at the same moment on the approver's dashboard
// (2026-11-12, "remove the duplicate requests"): each table is read once, and again on the next load.

function fakeClient() {
  const reads: string[] = []
  const from = (table: string) => {
    const query = {
      select: () => query, in: () => query, eq: () => query, order: () => query,
      limit: () => { reads.push(table); return Promise.resolve({ data: [{ table }], error: null }) },
    }
    return query
  }
  return { client: { from } as unknown as SupabaseClient, reads }
}

describe('the approver dashboard reads each open-queue table once', () => {
  it('two lists asking at the same moment share one read of each table', async () => {
    const { client, reads } = fakeClient()
    const [docsA, docsB, revsA, revsB] = await Promise.all([
      readOpenDocumentSubmissions(client), readOpenDocumentSubmissions(client),
      readOpenPiRevisions(client), readOpenPiRevisions(client),
    ])
    assert.deepEqual(reads.sort(), ['order_document_submissions', 'order_pi_versions'])
    assert.equal(docsA, docsB)
    assert.equal(revsA, revsB)
  })

  it('keeps nothing once a read has answered: the next load reads again', async () => {
    const { client, reads } = fakeClient()
    await readOpenDocumentSubmissions(client)
    await readOpenDocumentSubmissions(client)
    assert.equal(reads.length, 2)
  })
})
