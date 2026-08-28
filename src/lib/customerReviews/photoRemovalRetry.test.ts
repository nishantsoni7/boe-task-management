/**
 * THE RETRY PATH, driven for real.
 *
 * runPhotoRemoval() takes its two collaborators as arguments, so this file
 * builds a working stand-in for the database and the bucket — one that actually
 * marks rows, actually deletes objects, actually enforces the ownership and
 * verified-proof rules, and actually fails where a test tells it to — and drives
 * the real orchestration through every way a removal can be interrupted.
 *
 * These are behavioural tests, not source-shape assertions. A removal that
 * "converges on retry" is a claim about a state machine, and the only honest way
 * to check it is to break the machine halfway and run it again.
 *
 * THE DEFECT THEY WERE WRITTEN FOR: a removal whose row was already gone —
 * finish() had succeeded but its response was lost — answered 404. A completed
 * operation reported as a failure, permanently, however many times it was
 * retried.
 *
 * Fictional ids throughout. No database, no network, no storage.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/photoRemovalRetry.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isMissingObjectError,
  runPhotoRemoval,
  type BeginResult,
  type PhotoRemovalService,
  type PhotoVisibilityReader,
} from './photoRemovalFlow'

const OWNER = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const ADMIN = '33333333-3333-3333-3333-333333333333'
const PHOTO = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const PATH = `req-1/project_photo/${PHOTO}.jpg`

// ── A working stand-in for the two systems ───────────────────────────────────

type Row = {
  id: string
  ownerId: string
  kind: 'project_photo' | 'review_proof'
  verified: boolean
  status: 'draft' | 'ready_to_send' | 'sent' | 'customer_responded'
  storagePath: string
  removalStartedAt: string | null
  removalBy: string | null
}

class World {
  rows = new Map<string, Row>()
  objects = new Set<string>()
  /** One append-only entry per real removal, exactly as the delete trigger writes. */
  audit: { photoId: string; actorId: string }[] = []

  /** Injected failures, consumed once each — a real interruption happens once. */
  failNextObjectDelete = false
  failNextFinish = false
  failNextRead = false

  constructor(row?: Partial<Row>) {
    const base: Row = {
      id: PHOTO,
      ownerId: OWNER,
      kind: 'project_photo',
      verified: false,
      status: 'draft',
      storagePath: PATH,
      removalStartedAt: null,
      removalBy: null,
      ...row,
    }
    this.rows.set(base.id, base)
    this.objects.add(base.storagePath)
  }

  /**
   * The caller's own RLS: a photograph is readable when its request is. Marked
   * rows are NOT hidden here — that is the whole point of the resume path, and
   * it mirrors the route, whose read deliberately omits the removal filter.
   */
  reader(actorId: string, isAdmin = false): PhotoVisibilityReader {
    return {
      isVisibleToCaller: async (id) => {
        if (this.failNextRead) { this.failNextRead = false; return { visible: false, failed: true } }
        const row = this.rows.get(id)
        if (!row) return { visible: false, failed: false }
        return { visible: isAdmin || row.ownerId === actorId, failed: false }
      },
    }
  }

  /** The two SECURITY DEFINER halves plus the bucket, with their real rules. */
  service(isAdmin = false): PhotoRemovalService {
    return {
      beginRemoval: async (id, actorId): Promise<BeginResult> => {
        const row = this.rows.get(id)
        if (!row) return { outcome: 'gone' }
        if (!isAdmin) {
          if (row.ownerId !== actorId) return { outcome: 'forbidden' }
          if (row.kind === 'project_photo') {
            if (row.status !== 'draft' && row.status !== 'ready_to_send') return { outcome: 'locked' }
          } else {
            if (row.verified) return { outcome: 'locked' }
            if (row.status !== 'sent' && row.status !== 'customer_responded') return { outcome: 'locked' }
          }
        }
        // Idempotent: an already-marked row comes back unchanged.
        if (row.removalStartedAt === null) {
          row.removalStartedAt = '2026-08-28T00:00:00Z'
          row.removalBy = actorId
        }
        return { outcome: 'ready', storagePath: row.storagePath }
      },

      deleteObject: async (storagePath) => {
        if (this.failNextObjectDelete) {
          this.failNextObjectDelete = false
          return { ok: false, missing: false }
        }
        if (!this.objects.has(storagePath)) return { ok: false, missing: true }
        this.objects.delete(storagePath)
        return { ok: true, missing: false }
      },

      finishRemoval: async (id) => {
        if (this.failNextFinish) { this.failNextFinish = false; return { ok: false } }
        const row = this.rows.get(id)
        if (!row) return { ok: true } // already finished
        this.rows.delete(id)
        // The delete trigger, crediting removal_by rather than the uploader.
        this.audit.push({ photoId: id, actorId: row.removalBy ?? row.ownerId })
        return { ok: true }
      },
    }
  }

  /** What an ordinary list or detail read would show: marked rows are hidden. */
  ordinaryReads(): Row[] {
    return [...this.rows.values()].filter(r => r.removalStartedAt === null)
  }
}

const run = (w: World, actorId: string, isAdmin = false) =>
  runPhotoRemoval({ reader: w.reader(actorId, isAdmin), service: w.service(isAdmin) }, actorId, PHOTO)

// ══ 1. The happy path ═══════════════════════════════════════════════════════

describe('1. initial removal succeeds', () => {
  test('the object, the row and the audit entry all end up right', async () => {
    const w = new World()
    const result = await run(w, OWNER)

    assert.deepEqual(result, { status: 'removed' })
    assert.equal(w.objects.has(PATH), false, 'the object must be gone')
    assert.equal(w.rows.has(PHOTO), false, 'the row must be gone')
    assert.deepEqual(w.audit, [{ photoId: PHOTO, actorId: OWNER }])
  })
})

// ══ 2. Object deletion fails after marking ══════════════════════════════════

describe('2. object deletion fails after marking, then the retry succeeds', () => {
  test('the first attempt leaves a marked row that still names its path', async () => {
    const w = new World()
    w.failNextObjectDelete = true

    const first = await run(w, OWNER)
    assert.deepEqual(first, { status: 'failed', reason: 'object' })

    const row = w.rows.get(PHOTO)!
    assert.ok(row.removalStartedAt, 'the row must stay marked')
    assert.equal(row.storagePath, PATH, 'it must still name its object')
    assert.equal(w.objects.has(PATH), true, 'the object is still there')
    assert.deepEqual(w.audit, [], 'nothing was removed, so nothing is recorded')
  })

  test('THE RETRY CONVERGES', async () => {
    const w = new World()
    w.failNextObjectDelete = true
    await run(w, OWNER)

    const second = await run(w, OWNER)
    assert.deepEqual(second, { status: 'removed' })
    assert.equal(w.objects.has(PATH), false)
    assert.equal(w.rows.has(PHOTO), false)
    assert.deepEqual(w.audit, [{ photoId: PHOTO, actorId: OWNER }], 'exactly one entry')
  })
})

// ══ 3. The object went, the row did not ═════════════════════════════════════

describe('3. object deleted but finalization fails, then the retry succeeds', () => {
  test('the first attempt reports the partial state honestly', async () => {
    const w = new World()
    w.failNextFinish = true

    const first = await run(w, OWNER)
    assert.deepEqual(first, { status: 'failed', reason: 'row' })
    assert.equal(w.objects.has(PATH), false, 'the object did go')
    assert.ok(w.rows.get(PHOTO)?.removalStartedAt, 'the row is marked and still present')
    assert.deepEqual(w.audit, [])
  })

  test('THE RETRY CONVERGES, over an object that is ALREADY GONE', async () => {
    // This is the case that would loop forever if a missing object counted as
    // a failure: on a resume it is missing precisely BECAUSE the last attempt
    // got that far.
    const w = new World()
    w.failNextFinish = true
    await run(w, OWNER)

    const second = await run(w, OWNER)
    assert.deepEqual(second, { status: 'removed' })
    assert.equal(w.rows.has(PHOTO), false)
    assert.deepEqual(w.audit, [{ photoId: PHOTO, actorId: OWNER }], 'exactly one entry')
  })
})

// ══ 4. A marked row is invisible to ordinary reads ══════════════════════════

describe('4. a marked row stays hidden from ordinary reads', () => {
  test('it disappears from the list the moment it is marked, and never comes back', async () => {
    const w = new World()
    assert.equal(w.ordinaryReads().length, 1)

    w.failNextObjectDelete = true
    await run(w, OWNER)

    assert.equal(w.ordinaryReads().length, 0, 'a marked row must not be listed')
    assert.equal(w.rows.has(PHOTO), true, 'though it is still there for the resume path')
  })

  test('the resume path sees it even though the screens do not', async () => {
    const w = new World()
    w.failNextObjectDelete = true
    await run(w, OWNER)

    const seen = await w.reader(OWNER).isVisibleToCaller(PHOTO)
    assert.deepEqual(seen, { visible: true, failed: false })
  })

  test('and the real screens really do filter it', () => {
    // The stand-in above is only as honest as the code it stands in for.
    for (const file of [
      'src/app/customer-reviews/[id]/RequestDetailScreen.tsx',
      'src/app/customer-reviews/[id]/edit/EditRequestScreen.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      assert.ok(source.includes(".is('removal_started_at', null)"), file)
    }
  })

  test('THE ROUTE’S OWN READ DOES NOT FILTER — deliberately, and pinned here', () => {
    // The retry used to work only because nobody had added the filter to this
    // one query. If somebody adds it now, this fails instead of the resume path
    // dying silently in production.
    const route = readFileSync(join(process.cwd(), 'src/app/api/customer-reviews/photos/route.ts'), 'utf8')
    const reader = route.slice(route.indexOf('const reader: PhotoVisibilityReader'), route.indexOf('const removal: PhotoRemovalService'))
    assert.ok(reader.includes("from('customer_review_request_photos')"))
    assert.equal(reader.includes('removal_started_at'), false,
      'the resume read must not filter marked rows')
  })
})

// ══ 5, 6, 7. Who may resume ═════════════════════════════════════════════════

describe('5. the authorized remover can resume', () => {
  test('the owner finishes what the owner started', async () => {
    const w = new World()
    w.failNextObjectDelete = true
    await run(w, OWNER)

    assert.deepEqual(await run(w, OWNER), { status: 'removed' })
  })
})

describe('6. another employee can neither resume nor probe', () => {
  test('they cannot resume an interrupted removal', async () => {
    const w = new World()
    w.failNextObjectDelete = true
    await run(w, OWNER)

    const result = await run(w, OTHER)
    assert.deepEqual(result, { status: 'already_removed' })
    // Nothing happened.
    assert.equal(w.rows.has(PHOTO), true, 'the row is untouched')
    assert.equal(w.objects.has(PATH), true, 'the object is untouched')
    assert.deepEqual(w.audit, [])
  })

  test('THE ANSWER IS IDENTICAL FOR EVERY ID THEY CANNOT RESOLVE', async () => {
    // The disclosure this prevents: if a completed removal answered differently
    // from somebody else's photograph, a caller could walk uuids and learn which
    // ones exist on requests they cannot see.
    const somebodyElses = new World()
    const answers = [
      // (a) exists, belongs to another employee
      await run(somebodyElses, OTHER),
      // (b) never existed
      await runPhotoRemoval(
        { reader: new World().reader(OTHER), service: new World().service() },
        OTHER,
        '99999999-9999-9999-9999-999999999999',
      ),
      // (c) their own, already fully removed
      await (async () => {
        const w = new World()
        await run(w, OWNER)
        return run(w, OWNER)
      })(),
    ]
    assert.deepEqual(answers, [
      { status: 'already_removed' },
      { status: 'already_removed' },
      { status: 'already_removed' },
    ])
  })

  test('an employee is still refused a photograph they can see but may not remove', async () => {
    // A refusal is only ever reachable for a photograph the caller can already
    // read, so a distinct answer here discloses nothing new.
    const w = new World({ kind: 'review_proof', status: 'sent', verified: true })
    assert.deepEqual(await run(w, OWNER), { status: 'refused', reason: 'locked' })
    assert.equal(w.rows.has(PHOTO), true)
    assert.equal(w.objects.has(PATH), true)
  })
})

describe('7. an admin correction can resume', () => {
  test('an admin finishes a removal somebody else started', async () => {
    const w = new World()
    w.failNextObjectDelete = true
    await run(w, OWNER)

    const result = await run(w, ADMIN, true)
    assert.deepEqual(result, { status: 'removed' })
    // The audit credits whoever MARKED it, which is the owner here.
    assert.deepEqual(w.audit, [{ photoId: PHOTO, actorId: OWNER }])
  })

  test('an admin can remove verified proof, which the employee cannot', async () => {
    const w = new World({ kind: 'review_proof', status: 'customer_responded', verified: true })
    assert.deepEqual(await run(w, OWNER), { status: 'refused', reason: 'locked' })
    assert.deepEqual(await run(w, ADMIN, true), { status: 'removed' })
    assert.deepEqual(w.audit, [{ photoId: PHOTO, actorId: ADMIN }])
  })
})

// ══ 8. Repeating after completion ═══════════════════════════════════════════

describe('8. repeating DELETE after completion is safe', () => {
  test('THE SECOND CALL SUCCEEDS — this is the defect that was fixed', async () => {
    const w = new World()
    assert.deepEqual(await run(w, OWNER), { status: 'removed' })
    // Used to be a 404: a completed removal reported as a failure, forever.
    assert.deepEqual(await run(w, OWNER), { status: 'already_removed' })
  })

  test('and it writes NO second audit event', async () => {
    const w = new World()
    await run(w, OWNER)
    await run(w, OWNER)
    await run(w, OWNER)
    assert.deepEqual(w.audit, [{ photoId: PHOTO, actorId: OWNER }], 'exactly one, however many calls')
  })

  test('nothing privileged is even attempted once the row is gone', async () => {
    const w = new World()
    await run(w, OWNER)

    let begun = false
    const spy: PhotoRemovalService = {
      ...w.service(),
      beginRemoval: async (id, actorId) => { begun = true; return w.service().beginRemoval(id, actorId) },
    }
    await runPhotoRemoval({ reader: w.reader(OWNER), service: spy }, OWNER, PHOTO)
    assert.equal(begun, false, 'an unresolvable id must not reach the privileged path')
  })
})

// ══ A read that did not answer is not a read that said no ═══════════════════

describe('a failed visibility read is never mistaken for an absent row', () => {
  test('it reports a failure, so nothing is silently called "already removed"', async () => {
    const w = new World()
    w.failNextRead = true
    assert.deepEqual(await run(w, OWNER), { status: 'failed', reason: 'unknown' })
    assert.equal(w.rows.has(PHOTO), true, 'nothing was touched')
  })
})

// ══ 9. No client path becomes available ═════════════════════════════════════

describe('9. no direct client storage or metadata deletion becomes possible', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261017000000_customer_review_outreach.sql'), 'utf8',
  ).replace(/\r\n/g, '\n')
  const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

  test('the metadata table and the bucket still have no DELETE policy', () => {
    assert.equal(code.includes('create policy "customer_review_photos_delete"'), false)
    assert.equal(code.includes('create policy "customer_review_photos_storage_delete"'), false)
  })

  test('the DELETE privilege is still revoked', () => {
    assert.ok(code.includes(
      'revoke insert, update, delete, truncate on public.customer_review_request_photos from authenticated, anon',
    ))
  })

  test('the two halves are still service-role only', () => {
    for (const name of ['begin_customer_review_photo_removal', 'finish_customer_review_photo_removal']) {
      assert.ok(new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`).test(code), name)
      assert.ok(new RegExp(`grant\\s+execute on function public\\.${name}\\([^)]*\\) to service_role`).test(code), name)
    }
  })

  test('the browser still deletes nothing itself', () => {
    const manager = readFileSync(
      join(process.cwd(), 'src/components/customerReviews/PhotoManager.tsx'), 'utf8',
    )
    assert.equal(/from\('customer_review_request_photos'\)[\s\S]{0,40}\.delete\(/.test(manager), false)
    assert.equal(/\.storage[\s\S]{0,80}\.remove\(/.test(manager), false)
    assert.ok(manager.includes("method: 'DELETE',"))
  })

  test('the actor is never taken from the browser', () => {
    const route = readFileSync(
      join(process.cwd(), 'src/app/api/customer-reviews/photos/route.ts'), 'utf8',
    )
    const handler = route.slice(route.indexOf('export async function DELETE'))
    // The only field read from the body.
    assert.deepEqual([...handler.matchAll(/body\?\.(\w+)/g)].map(m => m[1]), ['photoId'])
    // And the identity handed to the flow is the session's.
    assert.ok(handler.includes('user.id, photoId'))
  })

  test('the storage path is the database’s, never the browser’s', () => {
    const route = readFileSync(
      join(process.cwd(), 'src/app/api/customer-reviews/photos/route.ts'), 'utf8',
    )
    assert.ok(route.includes('return { outcome: \'ready\', storagePath: path }'))
    assert.ok(route.includes("(data as { storage_path?: string } | null)?.storage_path"))
  })
})

// ══ The missing-object helper ═══════════════════════════════════════════════

describe('a missing object counts as gone, not as broken', () => {
  test('the shapes a storage layer uses to say "not there"', () => {
    assert.equal(isMissingObjectError({ status: 404 }), true)
    assert.equal(isMissingObjectError({ message: 'Object not found' }), true)
    assert.equal(isMissingObjectError({ message: 'The resource does not exist' }), true)
    assert.equal(isMissingObjectError({ message: 'no such key' }), true)
  })

  test('and everything else does not', () => {
    assert.equal(isMissingObjectError(null), false)
    assert.equal(isMissingObjectError({ message: 'permission denied' }), false)
    assert.equal(isMissingObjectError({ message: 'network error' }), false)
    assert.equal(isMissingObjectError({ status: 500 }), false)
  })
})
