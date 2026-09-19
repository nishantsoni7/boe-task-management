/**
 * A failed PI upload leaves one valid draft or none (20261219000000, PR #172).
 *
 * The database half — the keyed create, the discard door and every refusal —
 * is proved by supabase/tests/run_payment_idempotency_suite.sh. This proves the
 * screen's half: WHEN it asks for a discard, and in what order it removes the
 * workbook it uploaded, against fakes that record every call.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { afterSaveFailure, discardUnsavedDraft, type UnsavedDraftDeps } from './saveDraftFlow'

function fakes(opts: {
  saved?: string | null | undefined
  removeOk?: boolean
  discard?: 'discarded' | 'absent' | 'kept' | 'failed'
} = {}) {
  const calls: string[] = []
  const deps: UnsavedDraftDeps = {
    readSavedWorkbookPath: async id => { calls.push(`read:${id}`); return 'saved' in opts ? opts.saved : null },
    removeWorkbook: async path => { calls.push(`remove:${path}`); return opts.removeOk ?? true },
    discard: async id => { calls.push(`discard:${id}`); return opts.discard ?? 'discarded' },
  }
  return { calls, deps }
}

describe('when the screen asks', () => {
  test('a definitive failure of a draft THIS screen created → discard', () => {
    assert.equal(afterSaveFailure({ createdHere: true, ambiguous: false }), 'discard')
  })
  test('no answer (the server may have saved it) → keep, so Retry resumes the same draft', () => {
    assert.equal(afterSaveFailure({ createdHere: true, ambiguous: true }), 'keep')
  })
  test('a replacement (the record existed before this screen) → never discarded', () => {
    assert.equal(afterSaveFailure({ createdHere: false, ambiguous: false }), 'keep')
    assert.equal(afterSaveFailure({ createdHere: false, ambiguous: true }), 'keep')
  })
})

describe('what it does', () => {
  test('failed upload: no workbook to check — the draft is discarded, nothing left', async () => {
    const { calls, deps } = fakes()
    assert.equal(await discardUnsavedDraft('d1', [null], deps), true)
    assert.deepEqual(calls, ['discard:d1'])
  })

  test('failed upload whose object may have landed: removed first, THEN the row', async () => {
    const { calls, deps } = fakes()
    assert.equal(await discardUnsavedDraft('d1', [null, 'submissions/d1/original/a.xlsx'], deps), true)
    assert.deepEqual(calls, ['read:d1', 'remove:submissions/d1/original/a.xlsx', 'discard:d1'],
      'the row still authorises the removal when it happens')
  })

  test('server rejected the workbook: the uploaded file and the draft both go', async () => {
    const { calls, deps } = fakes()
    assert.equal(await discardUnsavedDraft('d1', ['submissions/d1/original/a.xlsx'], deps), true)
    assert.deepEqual(calls, ['read:d1', 'remove:submissions/d1/original/a.xlsx', 'discard:d1'])
  })

  test('a draft that WAS saved: its workbook is never touched and nothing is discarded', async () => {
    const { calls, deps } = fakes({ saved: 'submissions/d1/original/a.xlsx' })
    assert.equal(await discardUnsavedDraft('d1', ['submissions/d1/original/a.xlsx'], deps), false)
    assert.deepEqual(calls, ['read:d1'])
  })

  test('the row could not be read: the file is left alone', async () => {
    const { calls, deps } = fakes({ saved: undefined })
    assert.equal(await discardUnsavedDraft('d1', ['p'], deps), false)
    assert.deepEqual(calls, ['read:d1'])
  })

  test('the file could not be removed: the row is KEPT, so a retry can finish the job', async () => {
    const { calls, deps } = fakes({ removeOk: false })
    assert.equal(await discardUnsavedDraft('d1', ['p'], deps), false)
    assert.deepEqual(calls, ['read:d1', 'remove:p'])
  })

  test('the server refused (saved, leased, claimed…) or could not be reached: not gone', async () => {
    for (const outcome of ['kept', 'failed'] as const) {
      const { deps } = fakes({ discard: outcome })
      assert.equal(await discardUnsavedDraft('d1', [], deps), false, outcome)
    }
  })

  test('already gone counts as gone', async () => {
    const { deps } = fakes({ discard: 'absent' })
    assert.equal(await discardUnsavedDraft('d1', [], deps), true)
  })
})

describe('the whole journey, against a fake server with the migration\'s rules', () => {
  // create(key) returns the same draft per key; discard removes only a draft with
  // no saved workbook. Mirrors 20261219000000.
  function server() {
    const drafts = new Map<string, { saved: string | null }>()
    const byKey = new Map<string, string>()
    let seq = 0
    return {
      drafts,
      create(key: string) {
        const existing = byKey.get(key)
        if (existing && drafts.has(existing)) return existing
        const id = `draft-${++seq}`
        drafts.set(id, { saved: null })
        byKey.set(key, id)
        return id
      },
      deps: {
        readSavedWorkbookPath: async (id: string) => drafts.get(id)?.saved ?? null,
        removeWorkbook: async () => true,
        discard: async (id: string) => {
          const d = drafts.get(id)
          if (!d) return 'absent' as const
          if (d.saved) return 'kept' as const
          drafts.delete(id)
          return 'discarded' as const
        },
      },
    }
  }

  test('lost create response, repeated clicks: ONE draft', () => {
    const s = server()
    assert.equal(s.create('k1'), s.create('k1'))
    assert.equal(s.create('k1'), 'draft-1')
    assert.equal(s.drafts.size, 1)
  })

  test('upload fails → discarded → Retry with a new key → exactly one saved draft', async () => {
    const s = server()
    const first = s.create('k1')
    assert.equal(await discardUnsavedDraft(first, [], s.deps), true)
    assert.equal(s.drafts.size, 0, 'the failed attempt left nothing')
    const second = s.create('k2')
    s.drafts.get(second)!.saved = `submissions/${second}/original/x.xlsx`
    assert.equal(s.drafts.size, 1)
  })

  test('a save that succeeded but whose answer was lost is never discarded', async () => {
    const s = server()
    const id = s.create('k1')
    s.drafts.get(id)!.saved = `submissions/${id}/original/x.xlsx`
    assert.equal(await discardUnsavedDraft(id, [`submissions/${id}/original/x.xlsx`], s.deps), false)
    assert.equal(s.drafts.size, 1)
  })
})
