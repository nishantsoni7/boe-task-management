/**
 * PERMANENT DELETION OF INTERNAL TEST RECORDS (20261209000000).
 *
 * THIS FILE proves the ORDER OF WORK — every failure and every retry of the
 * three steps, against a stateful fake of the database and the bucket — plus
 * the browser mirror of the eligibility rule and the contract the migration,
 * the route and the screens must keep.
 *
 * supabase/tests/customer_review_test_card_purge_assertions.sql proves the
 * BEHAVIOUR on a real database: who may, which cards, the freeze, the refusal
 * while files remain, and that nothing is left behind.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/testCardPurge.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PURGE_INTERNAL_EVENT_TYPES,
  PURGE_MESSAGES,
  TEST_CARD_PURGE_BUCKET,
  objectPathsForCard,
  purgeRecordFrom,
  purgeRefusalFrom,
  runTestCardPurge,
  testCardPurgeBlocker,
  testCardPurgeService,
  type PurgeRefusal,
  type PurgeService,
  type PurgeServiceDeps,
} from './testCardPurge'
import { availableActions } from './status'
import { deriveCustomerReviewCapabilities } from '@/lib/permissions/customerReviewOutreach'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = read('supabase/migrations/20261209000000_customer_review_test_card_admin_purge.sql')
const ROUTE = read('src/app/api/customer-reviews/test-cards/purge/route.ts')
const COMPONENT = read('src/components/customerReviews/PurgeTestRecord.tsx')
const DETAIL = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
const LIST = read('src/app/customer-reviews/TestCardListScreen.tsx')
const LAYOUT = read('src/app/customer-reviews/layout.tsx')
const CUSTOM_ROUTE = read('src/app/api/customer-reviews/custom-submissions/route.ts')

/** Executable SQL: comment lines dropped. */
const SQL = MIGRATION.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

function fn(name: string): string {
  const at = SQL.indexOf(`create or replace function public.${name}(`)
  assert.ok(at >= 0, `${name} is not defined in the migration`)
  const end = SQL.indexOf('\n$$;', at)
  assert.ok(end > at, `${name} has no terminator`)
  return SQL.slice(at, end)
}

const CARD = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

// ══ 1. WHO IS OFFERED IT: THE BROWSER MIRROR ═════════════════════════════════

const draft = {
  status: 'pending_approval' as const,
  deleted_at: null,
  approved_at: null,
  assigned_to: null,
  booked_by: null,
  whatsapp_opened_at: null,
  whatsapp_opened_count: 0,
  sent_confirmed_at: null,
  submitted_at: null,
  verified_at: null,
}

describe('the browser mirror of the eligibility rule', () => {
  test('a never-released draft with internal history and review images is eligible', () => {
    assert.equal(testCardPurgeBlocker(
      draft,
      [{ event_type: 'generated' }, { event_type: 'draft_edited' }, { event_type: 'image_group_set' }],
      [{ kind: 'review_image' }],
    ), null)
  })

  test('every sign of release refuses, one field at a time', () => {
    const released: Record<string, unknown>[] = [
      { status: 'available' },
      { status: 'booked' },
      { status: 'submitted' },
      { status: 'verified' },
      { approved_at: '2026-09-01T00:00:00Z' },
      { assigned_to: 'user-1' },
      { booked_by: 'user-1' },
      { whatsapp_opened_at: '2026-09-01T00:00:00Z' },
      { whatsapp_opened_count: 1 },
      { sent_confirmed_at: '2026-09-01T00:00:00Z' },
      { submitted_at: '2026-09-01T00:00:00Z' },
      { verified_at: '2026-09-01T00:00:00Z' },
    ]
    for (const over of released) {
      assert.equal(testCardPurgeBlocker({ ...draft, ...over } as typeof draft, [], []), 'released', JSON.stringify(over))
    }
  })

  test('a tombstone is refused', () => {
    assert.equal(testCardPurgeBlocker({ ...draft, deleted_at: '2026-09-01T00:00:00Z' }, [], []), 'deleted')
  })

  test('any event beyond internal drafting refuses, including a type nobody has invented yet', () => {
    for (const event_type of [
      'approved', 'assigned', 'booked', 'unbooked', 'whatsapp_opened', 'sent_confirmed',
      'submitted', 'verified', 'returned', 'screenshot_removed', 'replaced', 'deleted', 'shared_in_future',
    ]) {
      assert.equal(testCardPurgeBlocker(draft, [{ event_type: 'generated' }, { event_type }], []), 'history', event_type)
    }
  })

  test('a test screenshot refuses; a review image does not', () => {
    assert.equal(testCardPurgeBlocker(draft, [], [{ kind: 'test_screenshot' }]), 'evidence')
    assert.equal(testCardPurgeBlocker(draft, [], [{ kind: 'review_image' }]), null)
  })

  test('the mirror allow-list is the database allow-list', () => {
    const body = fn('customer_review_test_card_purge_blocker')
    const match = /e\.event_type not in \(([^)]*)\)/.exec(body)
    assert.ok(match, 'the blocker has no event allow-list')
    const sqlTypes = [...match[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
    assert.deepEqual([...sqlTypes].sort(), [...PURGE_INTERNAL_EVENT_TYPES].sort())
  })
})

// ══ 2. THE ORDER OF WORK, AGAINST A STATEFUL FAKE ════════════════════════════

type World = {
  cardExists: boolean
  rowPaths: string[]
  objects: Set<string>
  calls: string[]
  refuseStart: { reason: PurgeRefusal; detail: string | null } | null
  failList: number
  failRemove: number
  /** Something writes a file between listing and finishing. */
  lateObject: string | null
}

function world(over: Partial<World> = {}): World {
  return {
    cardExists: true,
    rowPaths: [`${CARD}/review_image/a.jpg`],
    objects: new Set([
      `${CARD}/review_image/a.jpg`,
      `${CARD}/review_image/orphan-with-no-row.jpg`,
      `${OTHER}/review_image/bystander.jpg`,
    ]),
    calls: [],
    refuseStart: null,
    failList: 0,
    failRemove: 0,
    lateObject: null,
    ...over,
  }
}

function fakeService(w: World): PurgeService {
  return {
    async start(cardId, actorId) {
      w.calls.push(`start:${actorId}`)
      if (w.refuseStart) return { outcome: 'refused', ...w.refuseStart }
      if (!w.cardExists || cardId !== CARD) return { outcome: 'refused', reason: 'not_found', detail: null }
      return { outcome: 'started', storagePaths: [...w.rowPaths] }
    },
    async listObjects(cardId) {
      w.calls.push('list')
      if (w.failList > 0) { w.failList -= 1; return { ok: false } }
      return { ok: true, paths: [...w.objects].filter(p => p.startsWith(`${cardId}/`)) }
    },
    async removeObjects(paths) {
      w.calls.push(`remove:${paths.length}`)
      if (w.failRemove > 0) { w.failRemove -= 1; return { ok: false } }
      for (const p of paths) w.objects.delete(p)
      if (w.lateObject) { w.objects.add(w.lateObject); w.lateObject = null }
      return { ok: true }
    },
    async finish() {
      w.calls.push('finish')
      if (!w.cardExists) return { outcome: 'already_gone' }
      if ([...w.objects].some(p => p.startsWith(`${CARD}/`))) return { outcome: 'files_remain' }
      w.cardExists = false
      w.rowPaths = []
      return { outcome: 'purged' }
    },
  }
}

describe('start, then every file, then finish', () => {
  test('the happy path runs in order and removes the orphan as well as the recorded file', async () => {
    const w = world()
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'purged' })
    assert.deepEqual(w.calls, [`start:${ACTOR}`, 'list', 'remove:2', 'finish'])
    assert.equal(w.cardExists, false)
    assert.deepEqual([...w.objects], [`${OTHER}/review_image/bystander.jpg`], 'another card lost a file')
  })

  test('a refusal at START touches no file and never reaches FINISH', async () => {
    for (const reason of ['forbidden', 'not_found', 'reward_attached', 'not_eligible'] as const) {
      const w = world({ refuseStart: { reason, detail: null } })
      assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'refused', reason, detail: null })
      assert.deepEqual(w.calls, [`start:${ACTOR}`], reason)
      assert.equal(w.objects.size, 3, `${reason} removed a file`)
      assert.equal(w.cardExists, true)
    }
  })

  test('a listing failure removes nothing and does not finish; the retry converges', async () => {
    const w = world({ failList: 1 })
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'failed', reason: 'storage' })
    assert.deepEqual(w.calls, [`start:${ACTOR}`, 'list'])
    assert.equal(w.cardExists, true)
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'purged' })
    assert.equal(w.cardExists, false)
  })

  test('a removal failure leaves the record in place, and running again finishes it', async () => {
    const w = world({ failRemove: 1 })
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'failed', reason: 'storage' })
    assert.equal(w.calls.includes('finish'), false, 'FINISH ran after a failed removal')
    assert.equal(w.cardExists, true)
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'purged' })
    assert.equal([...w.objects].some(p => p.startsWith(`${CARD}/`)), false)
  })

  test('a file that appears before FINISH makes it refuse, and the retry removes that file too', async () => {
    const w = world({ lateObject: `${CARD}/review_image/late.jpg` })
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'failed', reason: 'files_remain' })
    assert.equal(w.cardExists, true, 'the record was deleted while a file remained')
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'purged' })
    assert.equal(w.objects.has(`${CARD}/review_image/late.jpg`), false)
  })

  test('a card with no files goes straight from START to FINISH', async () => {
    const w = world({ rowPaths: [], objects: new Set() })
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'purged' })
    assert.deepEqual(w.calls, [`start:${ACTOR}`, 'list', 'finish'])
  })

  test('after success, a repeat is refused as not found and removes nothing', async () => {
    const w = world()
    await runTestCardPurge(fakeService(w), ACTOR, CARD)
    const before = [...w.objects]
    assert.deepEqual(await runTestCardPurge(fakeService(w), ACTOR, CARD), { status: 'refused', reason: 'not_found', detail: null })
    assert.deepEqual([...w.objects], before)
  })

  test('only paths under the card prefix are ever removed', () => {
    assert.deepEqual(objectPathsForCard(CARD, [
      `${CARD}/b.jpg`, `${CARD}/a.jpg`, `${CARD}/a.jpg`,
      `${OTHER}/c.jpg`, `x${CARD}/d.jpg`, `${CARD}/`, 'customer-review-custom-proofs/e.jpg',
    ]), [`${CARD}/a.jpg`, `${CARD}/b.jpg`])
  })
})

// ══ 3. THE SERVICE ADAPTER ═══════════════════════════════════════════════════

describe('the service built from an RPC and a bucket', () => {
  function deps(opts: {
    rpc?: PurgeServiceDeps['rpc']
    tree?: Record<string, { name: string; id: string | null }[]>
    listError?: boolean
    removeError?: boolean
    removed?: string[][]
  } = {}): PurgeServiceDeps {
    return {
      rpc: opts.rpc ?? (async () => ({ data: null, error: null })),
      bucket: {
        async list(path, options) {
          if (opts.listError) return { data: null, error: { message: 'boom' } }
          const all = opts.tree?.[path] ?? []
          const offset = options?.offset ?? 0
          const limit = options?.limit ?? 100
          return { data: all.slice(offset, offset + limit), error: null }
        },
        async remove(paths) {
          opts.removed?.push(paths)
          return opts.removeError ? { data: null, error: { message: 'boom' } } : { data: [], error: null }
        },
      },
    }
  }

  test('START maps the database refusals and returns the recorded paths', async () => {
    const answers: Record<string, { reason: PurgeRefusal; detail: string | null }> = {
      'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only an active administrator can permanently delete a test record': { reason: 'forbidden', detail: null },
      'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test record no longer exists': { reason: 'not_found', detail: null },
      'CUSTOMER_REVIEW_TEST_PURGE_REWARD_ATTACHED: This review has BOE Credits attached': { reason: 'reward_attached', detail: null },
      'CUSTOMER_REVIEW_TEST_PURGE_NOT_ELIGIBLE: This review carries a test screenshot, so it cannot be permanently deleted': {
        reason: 'not_eligible', detail: 'This review carries a test screenshot, so it cannot be permanently deleted.',
      },
    }
    for (const [message, expected] of Object.entries(answers)) {
      const service = testCardPurgeService(deps({ rpc: async () => ({ data: null, error: { message } }) }))
      assert.deepEqual(await service.start(CARD, ACTOR), { outcome: 'refused', ...expected })
    }
    const unknown = testCardPurgeService(deps({ rpc: async () => ({ data: null, error: { message: 'connection reset' } }) }))
    assert.deepEqual(await unknown.start(CARD, ACTOR), { outcome: 'error' })

    let called: { fn: string; args: Record<string, unknown> } | null = null
    const ok = testCardPurgeService(deps({
      rpc: async (fnName, args) => {
        called = { fn: fnName, args }
        return { data: { storage_paths: [`${CARD}/review_image/a.jpg`, 7] }, error: null }
      },
    }))
    assert.deepEqual(await ok.start(CARD, ACTOR), { outcome: 'started', storagePaths: [`${CARD}/review_image/a.jpg`] })
    assert.deepEqual(called, { fn: 'begin_customer_review_test_card_purge', args: { p_card_id: CARD, p_actor_id: ACTOR } })
  })

  test('FINISH tells remaining files apart from a refusal, and a gone card from an error', async () => {
    const answer = (data: unknown, message?: string) =>
      testCardPurgeService(deps({ rpc: async () => ({ data, error: message ? { message } : null }) })).finish(CARD, ACTOR)
    assert.deepEqual(await answer(null, 'CUSTOMER_REVIEW_TEST_PURGE_FILES_REMAIN: 2 file(s) of this record are still stored; nothing was deleted'), { outcome: 'files_remain' })
    assert.deepEqual(await answer(null, 'CUSTOMER_REVIEW_TEST_PURGE_REWARD_ATTACHED: x'), { outcome: 'refused', reason: 'reward_attached', detail: null })
    assert.deepEqual(await answer(null, 'CUSTOMER_REVIEW_TEST_PURGE_NOT_STARTED: x'), { outcome: 'error' })
    assert.deepEqual(await answer({ purged: true }), { outcome: 'purged' })
    assert.deepEqual(await answer({ purged: false, already_gone: true }), { outcome: 'already_gone' })
    assert.deepEqual(await answer({}), { outcome: 'error' })
  })

  test('the listing walks folders, pages, and returns every nested file', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.jpg`, id: `id-${i}` }))
    const service = testCardPurgeService(deps({
      tree: {
        [CARD]: [{ name: 'review_image', id: null }, { name: 'test_screenshot', id: null }, { name: 'loose.jpg', id: 'x' }],
        [`${CARD}/review_image`]: many,
        [`${CARD}/test_screenshot`]: [{ name: 's.png', id: 's' }],
      },
    }))
    const listed = await service.listObjects(CARD)
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.equal(listed.paths.length, 1003)
    assert.ok(listed.paths.includes(`${CARD}/review_image/f1000.jpg`), 'the second page was not read')
    assert.ok(listed.paths.includes(`${CARD}/test_screenshot/s.png`))
    assert.ok(listed.paths.includes(`${CARD}/loose.jpg`))
  })

  test('a listing error is a failure, never an empty folder', async () => {
    assert.deepEqual(await testCardPurgeService(deps({ listError: true })).listObjects(CARD), { ok: false })
  })

  test('removal goes in chunks, and any chunk failing is a failure', async () => {
    const removed: string[][] = []
    const paths = Array.from({ length: 250 }, (_, i) => `${CARD}/review_image/${i}.jpg`)
    assert.deepEqual(await testCardPurgeService(deps({ removed })).removeObjects(paths), { ok: true })
    assert.deepEqual(removed.map(c => c.length), [100, 100, 50])
    assert.deepEqual(await testCardPurgeService(deps({ removeError: true })).removeObjects(paths), { ok: false })
  })

  test('an unrecognised marker is not a refusal', () => {
    assert.equal(purgeRefusalFrom('CUSTOMER_REVIEW_CUSTOM_NOT_OWNER: nope'), null)
    assert.equal(purgeRefusalFrom('no marker at all'), null)
    assert.equal(purgeRefusalFrom(null), null)
  })
})

// ══ 4. THE MIGRATION ═════════════════════════════════════════════════════════

describe('the migration', () => {
  test('the authority is an active, non-deleted admin, read in exactly one function', () => {
    const auth = fn('customer_review_test_card_purge_authorized')
    assert.ok(auth.includes("u.role::text = 'admin'"))
    assert.ok(auth.includes('u.is_active = true'))
    assert.ok(auth.includes('coalesce(u.is_deleted, false) = false'))
    assert.equal(/resolve_permission/.test(auth), false, 'the purge authority consults the Review permissions')
    for (const name of [
      'can_purge_customer_review_test_cards',
      'customer_review_test_card_purge_blocker',
      'customer_review_test_card_purge_refuse',
      'begin_customer_review_test_card_purge',
      'finish_customer_review_test_card_purge',
    ]) {
      assert.equal(/\brole\b|'admin'/.test(fn(name)), false, `${name} reads a role`)
    }
  })

  test('START and FINISH are the service role\'s alone; the screen may only ask', () => {
    for (const name of ['begin_customer_review_test_card_purge', 'finish_customer_review_test_card_purge']) {
      assert.ok(SQL.includes(`revoke execute on function public.${name}(uuid, uuid) from public, anon, authenticated;`))
      assert.ok(SQL.includes(`grant  execute on function public.${name}(uuid, uuid) to service_role;`))
      assert.ok(fn(name).includes('security definer'))
    }
    for (const helper of ['customer_review_test_card_purge_authorized(uuid)', 'customer_review_test_card_purge_blocker(uuid)', 'customer_review_test_card_purge_refuse(text)']) {
      assert.ok(SQL.includes(`revoke execute on function public.${helper}\n  from public, anon, authenticated, service_role;`), helper)
      assert.equal(SQL.includes(`grant  execute on function public.${helper}`), false, `${helper} is granted`)
    }
    assert.ok(SQL.includes('grant  execute on function public.can_purge_customer_review_test_cards() to authenticated;'))
  })

  test('the eligibility predicate is the documented one', () => {
    const body = fn('customer_review_test_card_purge_blocker')
    // 1. credits, of any type, in both places a review reward is recorded
    assert.ok(body.includes('from public.boe_credit_transactions t where t.source_id = p_card_id'))
    assert.ok(body.includes('from public.boe_credit_review_rewards r where r.card_id = p_card_id'))
    // 2. a verifier's tombstone
    assert.ok(body.includes("c.deleted_at is not null and c.deleted_source is distinct from 'purge'"))
    // 3. never released
    for (const clause of [
      "c.status <> 'pending_approval'",
      'c.approved_at is not null',
      'c.assigned_to is not null',
      'c.booked_by is not null',
      'c.whatsapp_opened_at is not null',
      'c.whatsapp_opened_count <> 0',
      'c.sent_confirmed_at is not null',
      'c.submitted_at is not null',
      'c.verified_at is not null',
    ]) assert.ok(body.includes(clause), clause)
    // 5. only review images
    assert.ok(body.includes("s.kind <> 'review_image'"))
    // Credits are checked first, so the reward sentence is the one a rewarded card gets.
    assert.ok(body.indexOf('boe_credit_transactions') < body.indexOf("c.status <> 'pending_approval'"))
  })

  test('START checks before it freezes, and writes the event before the tombstone', () => {
    const body = fn('begin_customer_review_test_card_purge')
    const auth = body.indexOf('customer_review_test_card_purge_authorized(p_actor_id)')
    const lock = body.indexOf('for update')
    const block = body.indexOf('customer_review_test_card_purge_blocker(p_card_id)')
    const event = body.indexOf('insert into public.customer_review_test_card_events')
    const tomb = body.indexOf("deleted_source = 'purge'")
    assert.ok(auth > 0 && auth < lock && lock < block && block < event && event < tomb, 'START is out of order')
    assert.ok(body.includes('if c.deleted_at is null then'), 'a repeated START writes a second tombstone')
  })

  test('FINISH re-checks, refuses while any file under the prefix remains, then deletes', () => {
    const body = fn('finish_customer_review_test_card_purge')
    const auth = body.indexOf('customer_review_test_card_purge_authorized(p_actor_id)')
    const started = body.indexOf("c.deleted_source is distinct from 'purge'")
    const block = body.indexOf('customer_review_test_card_purge_blocker(p_card_id)')
    const files = body.indexOf('from storage.objects o')
    const del = body.indexOf('delete from public.customer_review_test_cards where id = p_card_id')
    assert.ok(auth > 0 && auth < started && started < block && block < files && files < del, 'FINISH is out of order')
    assert.ok(body.includes("o.bucket_id = 'customer-review-test-screenshots'"))
    assert.ok(body.includes("split_part(o.name, '/', 1) = p_card_id::text"))
    assert.ok(body.includes("'already_gone', true"), 'a repeated FINISH is not a success')
    // One DELETE statement in the whole file (the apply-time assertions quote
    // the phrase inside strings, which is not a statement).
    assert.equal((SQL.match(/^\s*delete\s+from/gim) ?? []).length, 1, 'the migration deletes something else')
  })

  test('it reaches nothing but internal test records, and writes nothing to the ledger', () => {
    assert.equal(/customer_review_custom|customer-review-custom-proofs|customer-review-project-images|customer_review_group_images|customer_review_image_groups/.test(
      ['can_purge_customer_review_test_cards', 'customer_review_test_card_purge_blocker', 'begin_customer_review_test_card_purge', 'finish_customer_review_test_card_purge']
        .map(fn).join('\n'),
    ), false)
    assert.equal(/insert into public\.boe_credit|post_boe_credit|reverse_boe_credit/.test(SQL), false)
    assert.equal(/storage\.from|delete from storage/i.test(SQL), false, 'SQL tries to delete a stored object')
  })

  test('the verifier soft deletion is not redefined, and the CHECK keeps its four values', () => {
    for (const name of ['delete_customer_review_test_cards', 'delete_all_customer_review_test_cards', 'customer_review_replace_available']) {
      assert.equal(SQL.includes(`function public.${name}(`), false, `${name} was redefined`)
    }
    for (const s of ['single', 'selected', 'all', 'replacement', 'purge']) {
      assert.ok(SQL.includes(`'${s}'`), s)
    }
  })

  test('the migration asserts its own claims at apply time', () => {
    for (const marker of [
      "raise exception 'PURGE: %() reads a role outside the authority helper', v_name",
      "raise exception 'PURGE: finish does not refuse remaining files before deleting'",
      "raise exception 'PURGE: soft deletion %() now deletes rows or touches storage', v_name",
      "raise notice 'PASS  review-workflow admin purge of internal test records'",
    ]) assert.ok(SQL.includes(marker), marker)
  })
})

// ══ 5. THE ROUTE ═════════════════════════════════════════════════════════════

describe('the route', () => {
  const code = ROUTE.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

  test('the caller comes from the session, and the actor passed on is that caller', () => {
    assert.ok(code.includes("import { createClient } from '@/lib/supabase/server'"))
    assert.ok(code.includes('await caller.auth.getUser()'))
    assert.ok(code.includes(".select('is_active')"))
    assert.ok(code.includes('user.id,\n    cardId,'))
    assert.equal(/body\?\.(actorId|userId|employeeId)/.test(code), false)
  })

  test('it reads no role and decides no authority of its own', () => {
    assert.equal(/select\(['"][^'"]*role/.test(code), false)
    assert.equal(/'admin'|"admin"|isAdmin|resolve_permission/.test(code), false)
  })

  test('only POST, a validated uuid, the one bucket, and the privileged client from its helper', () => {
    assert.ok(code.includes('export async function POST('))
    assert.equal(/export async function (GET|DELETE|PUT|PATCH)/.test(code), false)
    assert.ok(code.includes('UUID_RE.test(raw)'))
    assert.ok(code.includes('service.storage.from(TEST_CARD_PURGE_BUCKET)'))
    assert.equal(TEST_CARD_PURGE_BUCKET, 'customer-review-test-screenshots')
    assert.ok(code.includes("import { adminClient } from '@/lib/supabase/admin'"))
  })

  test('a rewarded review gets the reward sentence, and every answer is from the allow-list', () => {
    assert.ok(code.includes("case 'reward_attached': return fail(409, PURGE_MESSAGES.reward_attached)"))
    assert.match(PURGE_MESSAGES.reward_attached, /BOE Credits attached/)
    assert.match(PURGE_MESSAGES.reward_attached, /handled separately/)
    assert.equal(/error\.message|String\(error\)/.test(code), false, 'a raw error reaches the response')
  })

  test('the custom submissions route is not part of this', () => {
    assert.equal(/purge/i.test(CUSTOM_ROUTE), false)
  })
})

// ══ 6. THE SCREENS ═══════════════════════════════════════════════════════════

describe('the screens', () => {
  test('the detail screen asks the database, and draws the control only for an eligible draft', () => {
    assert.ok(DETAIL.includes("supabase.rpc('can_purge_customer_review_test_cards')"))
    assert.ok(DETAIL.includes('{canPurge && testCardPurgeBlocker(card, events, [...screenshots, ...reviewImages]) === null && ('))
    assert.ok(DETAIL.indexOf('<PurgeTestRecord') > DETAIL.indexOf('<Section title="Activity">'), 'the purge control is not below the activity history')
    // The verifier's own Delete is unchanged beside Back.
    assert.ok(DETAIL.includes('canDeleteCard({ userId: profile?.id ?? null, canVerify: caps.canVerify })'))
  })

  test('the confirmation says what is removed and that it is final', () => {
    const copy = COMPONENT.replace(/\{' '\}/g, ' ').replace(/\s+/g, ' ')
    assert.ok(copy.includes('This permanently removes the internal test record'))
    assert.ok(copy.includes('Screenshots and activity history will also be removed'))
    assert.ok(copy.includes('This action cannot be undone.'))
    assert.ok(COMPONENT.includes("export const PURGE_DELETE_LABEL = 'Permanently delete test record'"))
    assert.ok(COMPONENT.includes('title={resume ? `${PURGE_CONTINUE_LABEL}?` : `${PURGE_DELETE_LABEL}?`}'))
    assert.ok(COMPONENT.includes('label={resume ? PURGE_CONTINUE_LABEL : PURGE_DELETE_LABEL}'))
  })

  test('one tap does not delete, and a failure keeps the sheet open to try again', () => {
    assert.ok(COMPONENT.includes('onClick={() => { setError(null); setOpen(true) }}'))
    const purge = COMPONENT.slice(COMPONENT.indexOf('const purge = useCallback'), COMPONENT.indexOf('return ('))
    assert.ok(purge.includes("fetch('/api/customer-reviews/test-cards/purge'"))
    const failure = purge.slice(purge.indexOf('if (!response.ok)'), purge.indexOf('setOpen(false)'))
    assert.ok(failure.includes('return'), 'a refusal closes the sheet')
    for (const m of COMPONENT.matchAll(/minHeight: '(\d+)px'/g)) assert.ok(Number(m[1]) >= 44)
  })

  test('there is no list-level purge', () => {
    assert.equal(/PurgeTestRecord|PurgeRecordView|test-cards\/purge|can_purge_customer_review_test_cards|customer_review_test_card_purge_record/.test(LIST), false)
  })
})

// ══ 7. AN ADMIN WITHOUT verify REACHES THE PURGE, AND ONLY THE PURGE ═════════

describe('an admin without verify reaches the purge, and only the purge', () => {
  const code = (s: string) => s.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

  test('the layout lets them onto one card page, on the database answer, and nowhere else', () => {
    const layout = code(LAYOUT)
    // Ordinary entry is unchanged: use OR verify, both catches denying.
    assert.ok(layout.includes("hasPermission(supabase, session.user.id, 'customer_review_requests', 'use').catch(() => false)"))
    assert.ok(layout.includes("hasPermission(supabase, session.user.id, 'customer_review_requests', 'verify').catch(() => false)"))
    const exception = layout.slice(layout.indexOf('if (!allowed) {'), layout.indexOf('setAuthorized(true)'))
    assert.ok(exception.includes("PURGE_PAGE.test(pathname ?? '')"))
    assert.ok(exception.includes("supabase.rpc('can_purge_customer_review_test_cards').then(({ data }: { data: unknown }) => data === true, () => false)"))
    assert.ok(exception.includes("router.replace('/coming-soon')"))
    assert.ok(exception.includes('setPurgeOnly(true)'))
    // Admitted that way, any other page of the module is refused.
    assert.ok(layout.includes('const outsidePurgePage = purgeOnly && !PURGE_PAGE.test(pathname ?? \'\')'))
    assert.ok(layout.includes('if (!authorized) return <LoadingScreen />'))
    assert.ok(layout.includes('if (outsidePurgePage) return <LoadingScreen />'))
    assert.equal(/role/.test(layout), false, 'the layout reads a role')

    const literal = /const PURGE_PAGE = \/(.+)\/$/m.exec(LAYOUT)
    assert.ok(literal, 'the purge page pattern is missing')
    const page = new RegExp(literal[1])
    assert.equal(page.test(`/customer-reviews/${CARD}`), true)
    for (const other of ['/customer-reviews', '/customer-reviews/reviews', '/customer-reviews/custom',
      `/customer-reviews/${CARD}/edit`, `/customer-reviews/x${CARD}`, '/customer-reviews/batches']) {
      assert.equal(page.test(other), false, other)
    }
  })

  test('the detail page shows them the purge page and returns before any review control', () => {
    const branch = 'if (!authLoading && purgeRecord && (purgeRecord.purgeInProgress || !caps.canVerify)) {'
    const at = DETAIL.indexOf(branch)
    assert.ok(at > 0, 'the purge page branch is missing')
    assert.ok(at < DETAIL.indexOf('if (!authLoading && candidateGeneratedReviewsHidden(caps)) {'))
    assert.ok(at < DETAIL.indexOf('if (authLoading || loading) return <LoadingScreen />'))
    assert.ok(at < DETAIL.indexOf('if (notFound || !card) {'))
    const body = DETAIL.slice(at, DETAIL.indexOf('\n  }\n', at))
    assert.ok(body.includes('<PurgeRecordView'))
    assert.equal(/VerifyPanel|availableActions|runAction|DeleteReviewButton|DeleteReviewsSheet|ScreenshotManager|ShareReviewButton|WhatsApp|ProjectGroupControl/.test(body), false)
    // A page about to say paused or not available waits for the purge answer.
    assert.ok(DETAIL.includes('awaitingPurgeCheck && (candidateGeneratedReviewsHidden(caps) || (!loading && (notFound || !card)))'))
  })

  test('the purge page itself offers no review action', () => {
    const view = COMPONENT.slice(COMPONENT.indexOf('export function PurgeRecordView'))
    assert.equal(/rpc\(|transition_customer_review_test_card|approve_customer_review|book_customer_review|unbook|delete_customer_review_test_cards|VerifyPanel|availableActions|ScreenshotManager|ReviewImageManager|ShareReview|WhatsApp|EditDraft/.test(view), false)
    assert.ok(view.includes('<PurgeTestRecord'))
    // The only request anywhere in the component is the purge.
    assert.equal((COMPONENT.match(/fetch\(/g) ?? []).length, 1)
  })

  test('holding the admin role lends no review permission: capabilities and actions stay empty', () => {
    const caps = deriveCustomerReviewCapabilities('admin', [
      { actionKey: 'use', allowed: false, source: 'employee_override' },
      { actionKey: 'verify', allowed: false, source: 'employee_override' },
    ])
    assert.deepEqual(caps, { canAccessModule: false, canUse: false, canVerify: false })
    for (const status of ['pending_approval', 'available', 'booked', 'submitted'] as const) {
      assert.deepEqual(
        availableActions({ status, booked_by: ACTOR, deleted_at: null }, { userId: ACTOR, canUse: caps.canUse, canVerify: caps.canVerify }),
        [],
        status,
      )
    }
  })

  test('a verifier who is not an admin gets neither the purge page nor the control', () => {
    // Both come from the database answer; `verify` contributes nothing to them.
    assert.ok(DETAIL.includes('const canPurge = purgeCheck?.canPurge === true'))
    assert.ok(DETAIL.includes("const record = allowed\n      ? purgeRecordFrom((await supabase.rpc('customer_review_test_card_purge_record', { p_card_id: cardId })).data)\n      : null"))
    assert.equal(/caps\.canVerify\s*\|\|\s*canPurge|canPurge\s*\|\|\s*caps\.canVerify/.test(DETAIL), false)
    const read = fn('customer_review_test_card_purge_record')
    assert.ok(read.indexOf('customer_review_test_card_purge_authorized(auth.uid())') < read.indexOf('from public.customer_review_test_cards'))
    assert.equal(/resolve_permission|verify|\brole\b|'admin'/.test(read), false)
  })
})

// ══ 8. AN INTERRUPTED PURGE CAN BE CONTINUED AFTER A RELOAD ══════════════════

describe('an interrupted purge can be continued after a reload', () => {
  test('the purge page read returns a purge tombstone, flagged, and still refuses every other card', () => {
    const read = fn('customer_review_test_card_purge_record')
    assert.ok(read.includes("'purge_in_progress', c.deleted_source is not distinct from 'purge'"))
    assert.ok(read.includes('if public.customer_review_test_card_purge_blocker(p_card_id) is not null then\n    return null;'))
    // The blocker still refuses a verifier's ordinary tombstone, so that never reaches the page.
    assert.ok(fn('customer_review_test_card_purge_blocker').includes("c.deleted_at is not null and c.deleted_source is distinct from 'purge'"))
    assert.ok(SQL.includes('grant  execute on function public.customer_review_test_card_purge_record(uuid) to authenticated;'))
    assert.ok(SQL.includes('revoke execute on function public.customer_review_test_card_purge_record(uuid) from public, anon;'))
  })

  test('the page says the deletion is in progress and offers to continue it with the same request', () => {
    assert.ok(COMPONENT.includes("export const PURGE_CONTINUE_LABEL = 'Continue permanent deletion'"))
    assert.ok(COMPONENT.includes("export const PURGE_IN_PROGRESS_HEADING = 'Permanent deletion in progress'"))
    const view = COMPONENT.slice(COMPONENT.indexOf('export function PurgeRecordView'))
    assert.ok(view.includes('{record.purgeInProgress && ('))
    assert.ok(view.includes('resume={record.purgeInProgress}'))
    // resume changes only the words: the request is the one the fresh purge sends.
    const purge = COMPONENT.slice(COMPONENT.indexOf('const purge = useCallback'), COMPONENT.indexOf('return ('))
    assert.equal(/\bresume\b/.test(purge), false, 'continuing sends a different request')
  })

  test('the database answer is read into a record, and nothing else is', () => {
    assert.equal(purgeRecordFrom(null), null)
    assert.equal(purgeRecordFrom([]), null)
    assert.equal(purgeRecordFrom({ id: CARD }), null)
    const raw = {
      id: CARD, card_ref: 'RW-009001', test_title: 'T', test_body: 'B', status: 'pending_approval',
      review_type: 'image', created_at: '2026-09-13T00:00:00Z', purge_in_progress: true,
      attachments: [{ kind: 'review_image', file_name: 'a.jpg' }, 'junk'],
      events: [{ event_type: 'deleted', detail: null, created_at: '2026-09-13T01:00:00Z' }],
    }
    assert.deepEqual(purgeRecordFrom(raw), {
      id: CARD, cardRef: 'RW-009001', testTitle: 'T', testBody: 'B', status: 'pending_approval',
      reviewType: 'image', createdAt: '2026-09-13T00:00:00Z', purgeInProgress: true,
      attachments: [{ kind: 'review_image', fileName: 'a.jpg' }],
      events: [{ eventType: 'deleted', detail: null, createdAt: '2026-09-13T01:00:00Z' }],
    })
    assert.equal(purgeRecordFrom({ ...raw, purge_in_progress: 'true' })?.purgeInProgress, false)
  })

  test('the detail page routes a purge in progress to the purge page for every purge admin', () => {
    // `purgeInProgress ||` comes first, so a verifier who is also an admin gets
    // the continue page rather than "not available".
    assert.ok(DETAIL.includes('(purgeRecord.purgeInProgress || !caps.canVerify)'))
    // The ordinary tombstone branch is unchanged for everybody else.
    assert.ok(DETAIL.includes('if ((cardRow as unknown as TestCard).deleted_at) {'))
  })
})
