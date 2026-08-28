/**
 * REMOVING A PHOTOGRAPH IS ONE OPERATION, and a client cannot perform half of it.
 *
 * WHAT THIS FILE EXISTS TO PROVE. Deleting an attachment touches two systems —
 * the private bucket and the metadata table — and no transaction spans both. If
 * a browser can delete either half on its own then sooner or later it does
 * exactly one of them, and the result is either a file nothing names again or a
 * record pointing at nothing. Neither is recoverable by anyone looking at the
 * screen.
 *
 * So the two halves are unreachable from a client, and the operation that owns
 * both is a server route whose SQL halves are granted to service_role alone.
 *
 * Reads repository files only. No database, no network, no storage.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/photoRemoval.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const read = (p: string) => stripComments(readFileSync(join(ROOT, p), 'utf8'))
const route = read('src/app/api/customer-reviews/photos/route.ts')
const manager = stripComments(readFileSync(join(ROOT, 'src/components/customerReviews/ScreenshotManager.tsx'), 'utf8'))

const migration = readFileSync(
  join(ROOT, 'supabase/migrations/20261017000000_customer_review_outreach.sql'), 'utf8',
).replace(/\r\n/g, '\n')
const sql = migration.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} is missing`)
  const tag = /\$[A-Za-z_]*\$/.exec(sql.slice(start))![0]
  const open = sql.indexOf(tag, start)
  const close = sql.indexOf(tag, open + tag.length)
  return sql.slice(start, close + tag.length)
}

// ══ 1. THE CLIENT CANNOT DELETE EITHER HALF ═════════════════════════════════

describe('a browser cannot delete an object or a metadata row', () => {
  test('there is no DELETE policy on the metadata table', () => {
    assert.equal(sql.includes('create policy "customer_review_test_screenshots_delete"'), false)
    // `on <table>` sits on the line after the policy name, so the whitespace
    // between them has to be allowed to include a newline.
    const policies = [...sql.matchAll(
      /create policy "([^"]+)"\s+on public\.customer_review_test_card_screenshots\s+for (\w+)/g,
    )]
    assert.deepEqual(policies.map(p => p[2]), ['select'],
      'the metadata table must be SELECT-only for clients')
  })

  test('there is no DELETE policy on the bucket', () => {
    assert.equal(sql.includes('create policy "customer_review_test_screenshots_storage_delete"'), false)
  })

  test('THE BUCKET HAS EXACTLY ONE CLIENT POLICY, AND IT READS', () => {
    const policies = [...sql.matchAll(/create policy "(customer_review_test[^"]*)"\s*\n?\s*on storage\.objects\s+for (\w+)/g)]
    assert.equal(policies.length, 1, `expected one, got: ${policies.map(p => p[1]).join(', ')}`)
    assert.equal(policies[0][2], 'select')
  })

  test('and the DELETE privilege is revoked, so a policy added later still fails', () => {
    assert.ok(sql.includes(
      'revoke insert, update, delete, truncate\n  on public.customer_review_test_card_screenshots from authenticated, anon',
    ))
  })

  test('the migration ASSERTS all of it at apply time', () => {
    const assertions = sql.slice(sql.indexOf('do $'))
    assert.ok(assertions.includes('has a DELETE policy; removal must go through the trusted route'))
    assert.ok(assertions.includes('a client DELETE policy exists on the customer-review-test-screenshots bucket'))
    assert.ok(assertions.includes('it must have exactly one, for SELECT'))
    assert.ok(assertions.includes("has_table_privilege('authenticated', 'public.customer_review_test_card_screenshots', v_col)"))
  })

  test('the component no longer deletes anything itself', () => {
    assert.equal(
      /from\('customer_review_test_card_screenshots'\)[\s\S]{0,40}\.delete\(/.test(manager), false,
      'the browser must not delete metadata',
    )
    assert.equal(
      /\.storage[\s\S]{0,80}\.remove\(/.test(manager), false,
      'the browser must not delete objects',
    )
    assert.ok(manager.includes("method: 'DELETE',"))
    assert.ok(manager.includes("fetch('/api/customer-reviews/photos', {"))
  })
})

// ══ 2. THE TRUSTED OPERATION ════════════════════════════════════════════════

describe('the removal route', () => {
  test('exists as DELETE on the same endpoint', () => {
    assert.ok(route.includes('export async function DELETE(req: NextRequest)'))
  })

  test('authenticates, checks active status, then checks the permission', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(handler.includes('await caller.auth.getUser()'))
    assert.ok(handler.includes('if (authError || !user) return fail(401'))
    assert.ok(handler.includes("profile.is_active !== true) return fail(403"))
    assert.ok(handler.includes("p_action_key: 'use'"))
  })

  test('THE PERMISSION IS CHECKED BEFORE THE BODY IS READ', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(handler.indexOf("p_action_key: 'use'") < handler.indexOf('await req.json()'))
  })

  test('the photograph id must be a uuid', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(handler.includes('!UUID_RE.test(raw)'))
  })

  test('THE PATH COMES FROM THE DATABASE, NEVER FROM THE BODY', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    // The only thing read from the body.
    assert.equal([...handler.matchAll(/body\?\.(\w+)/g)].map(m => m[1]).join(','), 'photoId')
    assert.equal(/body\?\.(storagePath|path|bucket|key)/.test(handler), false)
    // And the path acted on is the one begin_… returned.
    assert.ok(handler.includes("(data as { storage_path?: string } | null)?.storage_path"))
    assert.ok(handler.includes("return { outcome: 'ready', storagePath: path }"))
  })

  test('it reads the photograph as the CALLER, so RLS decides visibility', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(handler.includes('const reader: PhotoVisibilityReader'))
    assert.ok(handler.includes('await caller'))
    assert.ok(handler.includes("from('customer_review_test_card_screenshots')"))
  })

  test('AN ID IT CANNOT RESOLVE IS ANSWERED IDENTICALLY, whatever the reason', () => {
    // A completed removal, an id that never existed and another employee\u2019s
    // photograph must be indistinguishable, or the difference is the
    // disclosure. runPhotoRemoval returns `already_removed` for all three and
    // the route maps it to the same 200 a real removal returns.
    const flow = read('src/lib/customerReviews/photoRemovalFlow.ts')
    assert.ok(flow.includes("if (!seen.visible) return { status: 'already_removed' }"))
    assert.ok(route.includes("case 'removed':"))
    assert.ok(route.includes("case 'already_removed':"))
    assert.ok(route.includes('return ok({ removed: photoId })'))
    // Nothing 404s a photograph any more.
    assert.equal(route.includes('MESSAGES.photo_not_found'), false)
  })

  test('the resume read deliberately does NOT hide a marked row', () => {
    const handler = route.slice(
      route.indexOf('const reader: PhotoVisibilityReader'),
      route.indexOf('const removal: PhotoRemovalService'),
    )
    assert.equal(handler.includes('removal_started_at'), false,
      'the resume path must be able to see what it is resuming')
  })

  test('the three steps happen in the order that makes a failure recoverable', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    const mark = handler.indexOf("'begin_customer_review_test_screenshot_removal'")
    const object = handler.indexOf('.remove([storagePath])')
    const row = handler.indexOf("'finish_customer_review_test_screenshot_removal'")
    assert.ok(mark > 0 && object > mark && row > object,
      'mark, then object, then row')
  })

  test('a failed object deletion stops there, leaving the row marked', () => {
    // Behaviourally proven in photoRemovalRetry.test.ts; this pins the
    // orchestration that decides it.
    const flow = read('src/lib/customerReviews/photoRemovalFlow.ts')
    assert.ok(flow.includes("if (!object.ok && !object.missing) return { status: 'failed', reason: 'object' }"))
    // It must NOT go on to delete the row.
    assert.ok(flow.indexOf("reason: 'object'") < flow.indexOf('finishRemoval(photoId)'))
  })

  test('AN ALREADY-DELETED OBJECT IS A SUCCESS, or the resume never converges', () => {
    // On a resume the object is missing precisely BECAUSE the last attempt got
    // that far. Treating that as a failure would stick the operation forever,
    // one step from done.
    const flow = read('src/lib/customerReviews/photoRemovalFlow.ts')
    assert.ok(flow.includes('!object.ok && !object.missing'))
    assert.ok(route.includes('missing: isMissingObjectError(error)'))
  })

  test('a failed row deletion is reported as exactly what it is', () => {
    const flow = read('src/lib/customerReviews/photoRemovalFlow.ts')
    assert.ok(flow.includes("if (!finished.ok) return { status: 'failed', reason: 'row' }"))
    assert.ok(route.includes("remove_partial:  'The image was removed but the record could not be updated. Try again.'"))
    assert.ok(route.includes("outcome.reason === 'row'"))
  })

  test('the database refusals map to prewritten sentences, never to forwarded text', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(handler.includes("code.includes('CUSTOMER_REVIEW_TEST_LOCKED')"))
    assert.ok(handler.includes("code.includes('CUSTOMER_REVIEW_TEST_UNAUTHORIZED')"))
    assert.ok(handler.includes("code.includes('CUSTOMER_REVIEW_TEST_SCREENSHOT_NOT_FOUND')"))
    // The database's own message text is never returned.
    assert.equal(/fail\(\d+,\s*(markError|code|rowError|objectError)/.test(handler), false)
  })
})

// ══ 3. THE SQL HALVES ═══════════════════════════════════════════════════════

describe('the two SQL halves are unreachable from a browser', () => {
  const both = [
    'begin_customer_review_test_screenshot_removal',
    'finish_customer_review_test_screenshot_removal',
  ]

  test('neither is granted to authenticated or anon', () => {
    for (const name of both) {
      const revoke = new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`)
      assert.ok(revoke.test(sql), `${name} is not revoked from authenticated`)
    }
  })

  test('both are granted to service_role, and to nothing else', () => {
    for (const name of both) {
      const grant = new RegExp(`grant\\s+execute on function public\\.${name}\\([^)]*\\) to service_role`)
      assert.ok(grant.test(sql), `${name} is not granted to service_role`)
      assert.equal(
        new RegExp(`grant\\s+execute on function public\\.${name}\\([^)]*\\) to authenticated`).test(sql),
        false,
      )
    }
  })

  test('THE ACTOR IS A PARAMETER, WHICH IS WHY NO CLIENT MAY CALL THEM', () => {
    // begin_… takes p_actor_id because the ROUTE establishes the identity from
    // the session. A browser able to call it could name anybody.
    assert.ok(sql.includes('p_actor_id uuid'))
    const assertions = sql.slice(sql.indexOf('do $'))
    assert.ok(assertions.includes('is executable by a client role'))
    assert.ok(assertions.includes('is not executable by service_role, so the trusted route cannot work'))
  })

  test('both pin search_path', () => {
    for (const name of both) {
      assert.ok(/set search_path = public, pg_temp/.test(fnBody(name)), name)
    }
  })

  test('the marking half locks the row, so two removals cannot both proceed', () => {
    assert.ok(fnBody('begin_customer_review_test_screenshot_removal').includes('for update'))
    assert.ok(fnBody('finish_customer_review_test_screenshot_removal').includes('for update'))
  })

  test('both are idempotent, so a retry after a lost response converges', () => {
    assert.ok(fnBody('begin_customer_review_test_screenshot_removal').includes('if s.removal_started_at is null then'))
    assert.ok(fnBody('finish_customer_review_test_screenshot_removal').includes('if not found then return true; end if;'))
  })
})

// ══ 4. WHO MAY REMOVE WHAT ══════════════════════════════════════════════════

describe('authorization inside the marking function', () => {
  const body = fnBody('begin_customer_review_test_screenshot_removal')

  test('an inactive account is refused', () => {
    assert.ok(body.includes('where u.id = p_actor_id and u.is_active'))
    assert.ok(body.includes('if v_admin is null then'))
  })

  test('a non-admin must HOLD THE CARD and hold `use`', () => {
    assert.ok(body.includes('c.booked_by = p_actor_id'))
    assert.ok(body.includes("resolve_permission(p_actor_id, 'customer_review_requests', 'use')"))
  })

  test('A TESTER MAY ONLY WITHDRAW WHILE THEY STILL HOLD THE CARD', () => {
    // Evidence a verifier has already acted on must not vanish from underneath
    // their decision — and evidence they are ABOUT to act on must not either.
    // Once a card is submitted the screenshot is frozen for everyone but an
    // administrator. This replaces the earlier two-kind ladder (a project
    // photograph while preparing, proof until verification), which described a
    // workflow that no longer exists.
    assert.ok(body.includes("if c.status <> 'booked' then"))
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_LOCKED'))
    // …and the check sits inside the non-admin branch, so a correction is still
    // possible.
    const nonAdmin = body.slice(body.indexOf('if not v_admin then'))
    assert.ok(nonAdmin.includes("c.status <> 'booked'"))
  })

  test('an admin may correct one at any status, verified included', () => {
    // The entire status ladder is inside `if not v_admin then`. Without this an
    // image uploaded by accident — a personal chat in shot, a colleague's number
    // visible — would be permanently unremovable.
    assert.ok(body.includes('if not v_admin then'))
    const beforeLadder = body.slice(0, body.indexOf('if not v_admin then'))
    assert.equal(beforeLadder.includes("c.status <>"), false)
  })

  test('every refusal carries an SQLSTATE a caller can branch on', () => {
    for (const block of body.split('raise exception').slice(1)) {
      assert.ok(/using errcode = '(42501|23514|P0002)'/.test(block.slice(0, 300)), block.split('\n')[0])
    }
  })
})

// ══ 5. THE AUDIT ENTRY ══════════════════════════════════════════════════════

describe('every removal is recorded, and credited to the right person', () => {
  test('the delete trigger writes a screenshot_removed row', () => {
    const trigger = fnBody('customer_review_test_screenshots_log_removal')
    assert.ok(trigger.includes("'screenshot_removed'"))
    assert.ok(sql.includes('before delete on public.customer_review_test_card_screenshots'))
  })

  test('IT CREDITS removal_by, NOT the uploader', () => {
    // The delete arrives through the service role, where auth.uid() is null.
    // Falling back to the uploader would credit the removal to whoever added
    // the file, which is usually somebody else.
    const trigger = fnBody('customer_review_test_screenshots_log_removal')
    assert.ok(trigger.includes('coalesce(old.removal_by, auth.uid(), old.uploaded_by)'))
  })

  test('removal_by is stamped by the marking function from the route’s actor', () => {
    assert.ok(fnBody('begin_customer_review_test_screenshot_removal').includes('removal_by = p_actor_id'))
  })

  test('the trail itself remains unwritable by any client', () => {
    assert.ok(sql.includes(
      'revoke insert, update, delete, truncate\n  on public.customer_review_test_card_events from authenticated, anon',
    ))
  })
})

// ══ 6. A MARKED ROW IS ALREADY GONE, TO EVERY READER ════════════════════════

describe('consistency while a removal is in flight', () => {
  test('the two marking columns are consistent or absent together', () => {
    assert.ok(sql.includes('constraint customer_review_screenshot_removal_fields_consistent check ('))
  })

  test('A MARKED ROW IS FILTERED OUT IN THE POLICY, not in each screen', () => {
    // This USED to check that every screen listing images added
    // .is('removal_started_at', null) to its query — the detail screen and the
    // edit screen, one filter each. That was the weaker arrangement: it worked
    // only while every author remembered, and a screen added later would have
    // shown a half-removed image with nothing to say so.
    //
    // The filter now lives in the SELECT policy, so a marked row is invisible
    // to every reader by construction, including one written next year. The
    // screens no longer carry it because they no longer need to.
    const policy = /create policy "customer_review_test_screenshots_select"[\s\S]*?;/.exec(sql)?.[0] ?? ''
    assert.ok(policy, 'the screenshot SELECT policy is missing')
    assert.ok(policy.includes('removal_started_at is null'),
      'a half-removed screenshot would still be readable')
  })

  test('the column is still selected, so the state is visible to a reader', () => {
    const types = readFileSync(join(ROOT, 'src/lib/customerReviews/types.ts'), 'utf8')
    assert.ok(types.includes('removal_started_at'))
    assert.ok(types.includes("uploaded_at, removal_started_at'"))
  })
})
