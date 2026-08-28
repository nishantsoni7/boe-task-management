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

const route = stripComments(readFileSync(join(ROOT, 'src/app/api/customer-reviews/photos/route.ts'), 'utf8'))
const manager = stripComments(readFileSync(join(ROOT, 'src/components/customerReviews/PhotoManager.tsx'), 'utf8'))
const detail = readFileSync(join(ROOT, 'src/app/customer-reviews/[id]/RequestDetailScreen.tsx'), 'utf8')
const edit = readFileSync(join(ROOT, 'src/app/customer-reviews/[id]/edit/EditRequestScreen.tsx'), 'utf8')

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
    assert.equal(sql.includes('create policy "customer_review_photos_delete"'), false)
    const policies = [...sql.matchAll(
      /create policy "([^"]+)" on public\.customer_review_request_photos\s+for (\w+)/g,
    )]
    assert.deepEqual(policies.map(p => p[2]), ['select'],
      'the metadata table must be SELECT-only for clients')
  })

  test('there is no DELETE policy on the bucket', () => {
    assert.equal(sql.includes('create policy "customer_review_photos_storage_delete"'), false)
  })

  test('THE BUCKET HAS EXACTLY ONE CLIENT POLICY, AND IT READS', () => {
    const policies = [...sql.matchAll(/create policy "(customer_review_photos[^"]*)"\s*\n?\s*on storage\.objects\s+for (\w+)/g)]
    assert.equal(policies.length, 1, `expected one, got: ${policies.map(p => p[1]).join(', ')}`)
    assert.equal(policies[0][2], 'select')
  })

  test('and the DELETE privilege is revoked, so a policy added later still fails', () => {
    assert.ok(sql.includes(
      'revoke insert, update, delete, truncate on public.customer_review_request_photos from authenticated, anon',
    ))
  })

  test('the migration ASSERTS all of it at apply time', () => {
    const assertions = sql.slice(sql.indexOf('do $$'))
    assert.ok(assertions.includes('has a DELETE policy; removal must go through the trusted route'))
    assert.ok(assertions.includes('a client DELETE policy exists on the customer-review-photos bucket'))
    assert.ok(assertions.includes('it must have exactly one, for SELECT'))
    assert.ok(assertions.includes("has_table_privilege('authenticated', 'public.customer_review_request_photos', v_bad)"))
  })

  test('the component no longer deletes anything itself', () => {
    assert.equal(
      /from\('customer_review_request_photos'\)[\s\S]{0,40}\.delete\(/.test(manager), false,
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
    // And the path used is the one begin_… returned.
    assert.ok(handler.includes('const storagePath = (marked as { storage_path?: string }).storage_path'))
  })

  test('it reads the photograph as the CALLER first, so RLS decides visibility', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(handler.includes('await caller'))
    assert.ok(handler.includes("if (!visible) return fail(404"))
    assert.ok(handler.indexOf('const { data: visible }') < handler.indexOf('adminClient()'))
  })

  test('the three steps happen in the order that makes a failure recoverable', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    const mark = handler.indexOf("'begin_customer_review_photo_removal'")
    const object = handler.indexOf('.remove([storagePath])')
    const row = handler.indexOf("'finish_customer_review_photo_removal'")
    assert.ok(mark > 0 && object > mark && row > object,
      'mark, then object, then row')
  })

  test('a failed object deletion stops there, leaving the row marked', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    const branch = handler.slice(handler.indexOf('if (objectError)'))
    assert.ok(branch.includes('return fail(500, MESSAGES.remove_failed)'))
    // It must NOT go on to delete the row, which would strand the object if the
    // removal had in fact partly succeeded.
    assert.ok(branch.indexOf('return fail') < branch.indexOf('finish_customer_review_photo_removal'))
  })

  test('a failed row deletion is reported as exactly what it is', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(handler.includes('if (rowError) return fail(500, MESSAGES.remove_partial)'))
    assert.ok(route.includes("remove_partial:  'The image was removed but the record could not be updated. Try again.'"))
  })

  test('the database refusals map to prewritten sentences, never to forwarded text', () => {
    const handler = route.slice(route.indexOf('export async function DELETE'))
    assert.ok(handler.includes("code.includes('CUSTOMER_REVIEW_LOCKED')"))
    assert.ok(handler.includes("code.includes('CUSTOMER_REVIEW_UNAUTHORIZED')"))
    assert.ok(handler.includes("code.includes('CUSTOMER_REVIEW_PHOTO_NOT_FOUND')"))
    // The database's own message text is never returned.
    assert.equal(/fail\(\d+,\s*(markError|code|rowError|objectError)/.test(handler), false)
  })
})

// ══ 3. THE SQL HALVES ═══════════════════════════════════════════════════════

describe('the two SQL halves are unreachable from a browser', () => {
  const both = [
    'begin_customer_review_photo_removal',
    'finish_customer_review_photo_removal',
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
    const assertions = sql.slice(sql.indexOf('do $$'))
    assert.ok(assertions.includes('is executable by a client role'))
    assert.ok(assertions.includes('is not executable by service_role, so the removal route cannot work'))
  })

  test('both pin search_path', () => {
    for (const name of both) {
      assert.ok(/set search_path = public, pg_temp/.test(fnBody(name)), name)
    }
  })

  test('the marking half locks the row, so two removals cannot both proceed', () => {
    assert.ok(fnBody('begin_customer_review_photo_removal').includes('for update'))
    assert.ok(fnBody('finish_customer_review_photo_removal').includes('for update'))
  })

  test('both are idempotent, so a retry after a lost response converges', () => {
    assert.ok(fnBody('begin_customer_review_photo_removal').includes('if p.removal_started_at is null then'))
    assert.ok(fnBody('finish_customer_review_photo_removal').includes('if not found then return true; end if;'))
  })
})

// ══ 4. WHO MAY REMOVE WHAT ══════════════════════════════════════════════════

describe('authorization inside the marking function', () => {
  const body = fnBody('begin_customer_review_photo_removal')

  test('an inactive account is refused', () => {
    assert.ok(body.includes('where u.id = p_actor_id and u.is_active'))
    assert.ok(body.includes('if v_admin is null then'))
  })

  test('a non-admin must own the request AND hold `use`', () => {
    assert.ok(body.includes('r.created_by = p_actor_id'))
    assert.ok(body.includes("resolve_permission(p_actor_id, 'customer_review_requests', 'use')"))
  })

  test('a project photograph is removable only while the request is being prepared', () => {
    assert.ok(body.includes("if r.status not in ('draft', 'ready_to_send') then"))
  })

  test('VERIFIED PROOF CANNOT BE WITHDRAWN BY THE EMPLOYEE', () => {
    // Evidence a verifier has already acted on must not vanish from underneath
    // their decision. This is the rule this whole branch exists for.
    assert.ok(body.includes('if r.verified_at is not null then'))
    assert.ok(body.includes('Verified proof can only be withdrawn by an administrator'))
    // …and the check sits inside the non-admin branch, so a correction is still
    // possible.
    const nonAdmin = body.slice(body.indexOf('if not v_admin then'))
    assert.ok(nonAdmin.includes('r.verified_at is not null'))
  })

  test('an admin may correct either kind at any status', () => {
    // The entire status/kind ladder is inside `if not v_admin then`.
    assert.ok(body.includes('if not v_admin then'))
    const beforeLadder = body.slice(0, body.indexOf('if not v_admin then'))
    assert.equal(beforeLadder.includes("r.status not in"), false)
  })

  test('every refusal carries an SQLSTATE a caller can branch on', () => {
    for (const block of body.split('raise exception').slice(1)) {
      assert.ok(/using errcode = '(42501|23514|P0002)'/.test(block.slice(0, 300)), block.split('\n')[0])
    }
  })
})

// ══ 5. THE AUDIT ENTRY ══════════════════════════════════════════════════════

describe('every removal is recorded, and credited to the right person', () => {
  test('the delete trigger writes a photo_removed row', () => {
    const trigger = fnBody('customer_review_photos_log_removal')
    assert.ok(trigger.includes("'photo_removed'"))
    assert.ok(sql.includes('before delete on public.customer_review_request_photos'))
  })

  test('IT CREDITS removal_by, NOT the uploader', () => {
    // The delete arrives through the service role, where auth.uid() is null.
    // Falling back to the uploader would credit the removal to whoever added
    // the file, which is usually somebody else.
    const trigger = fnBody('customer_review_photos_log_removal')
    assert.ok(trigger.includes('coalesce(old.removal_by, auth.uid(), old.uploaded_by)'))
  })

  test('removal_by is stamped by the marking function from the route’s actor', () => {
    assert.ok(fnBody('begin_customer_review_photo_removal').includes('removal_by = p_actor_id'))
  })

  test('the trail itself remains unwritable by any client', () => {
    assert.ok(sql.includes(
      'revoke insert, update, delete, truncate on public.customer_review_request_events from authenticated, anon',
    ))
  })
})

// ══ 6. A MARKED ROW IS ALREADY GONE, TO EVERY READER ════════════════════════

describe('consistency while a removal is in flight', () => {
  test('the two marking columns are consistent or absent together', () => {
    assert.ok(sql.includes('constraint customer_review_photos_removal_fields_consistent check ('))
  })

  test('every screen that lists photographs filters a marked row out', () => {
    for (const [label, source] of [['detail', detail], ['edit', edit]] as const) {
      assert.ok(source.includes(".is('removal_started_at', null)"), `${label} does not filter`)
    }
  })

  test('the column is selected, so a filter cannot silently stop working', () => {
    const types = readFileSync(join(ROOT, 'src/lib/customerReviews/types.ts'), 'utf8')
    assert.ok(types.includes('removal_started_at'))
    assert.ok(types.includes("uploaded_at, removal_started_at'"))
  })
})
