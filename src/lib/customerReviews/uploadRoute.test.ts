/**
 * The trusted upload route, and the boundary it creates.
 *
 * WHY SOURCE-SHAPE ASSERTIONS. This route is where a browser stops being
 * trusted, and most of what it guarantees is a guarantee about ORDER or about
 * ABSENCE:
 *
 *   * the caller is authenticated and permission-checked BEFORE anything is read;
 *   * the request is read through the CALLER's RLS, not the server's;
 *   * the bytes are inspected BEFORE anything is stored;
 *   * the object key is generated here and never taken from the body;
 *   * the stored mime_type and byte_size come from the inspection;
 *   * the object is removed again if the metadata insert fails;
 *   * the service-role credential exists only on this side.
 *
 * Reaching those behaviourally would need a live Supabase project, a real
 * bucket and a signed-in session, which this phase may not touch. The pure logic
 * underneath — the byte inspector and the filename sanitiser — is unit-tested
 * for real in imageBytes.test.ts and below.
 *
 * Reads repository files only. No database, no network, no storage.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/uploadRoute.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeDisplayName } from '@/app/api/customer-reviews/photos/route'

const ROOT = process.cwd()

/** Source with its comments removed — the route DOCUMENTS what it refuses, and
 *  a search over raw text would match the prose promising the very property it
 *  is meant to verify. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const ROUTE_PATH = 'src/app/api/customer-reviews/photos/route.ts'
// NORMALISED, like every other reader in these tests. Without this the
// assertions below match against whatever line endings the checkout produced,
// which makes them pass or fail for a reason that has nothing to do with the
// route's content.
const raw = readFileSync(join(ROOT, ROUTE_PATH), 'utf8').replace(/\r\n/g, '\n')
const route = stripComments(raw)

const manager = stripComments(
  readFileSync(join(ROOT, 'src/components/customerReviews/ScreenshotManager.tsx'), 'utf8'),
)

const migration = readFileSync(
  join(ROOT, 'supabase/migrations/20261017000000_customer_review_outreach.sql'), 'utf8',
).replace(/\r\n/g, '\n')
const sql = migration.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

// ── 1. It exists where the client calls it ──────────────────────────────────

describe('the endpoint', () => {
  test('is a POST route at /api/customer-reviews/photos', () => {
    assert.ok(existsSync(join(ROOT, ROUTE_PATH)))
    assert.ok(route.includes('export async function POST'))
  })

  test('runs on Node, because it reads and hashes bytes', () => {
    assert.ok(route.includes("export const runtime = 'nodejs'"))
  })

  test('it is the ONLY route this module adds', () => {
    const apiDir = join(ROOT, 'src/app/api/customer-reviews')
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, out)
        else if (entry.name === 'route.ts') out.push(path)
      }
      return out
    }
    // SEVEN routes, and naming each is the point: an eighth appearing without
    // anybody noticing is what this assertion exists to catch. The photos route
    // is the only writer of a test screenshot; the images route is the only
    // writer of a review image; the image-groups route is the only writer of a
    // project image; the whatsapp route is the only builder of a wa.me link.
    // None of them is a general service.
    const routes = walk(apiDir).map(f => f.replace(/\\/g, '/')).sort()
    assert.equal(routes.length, 7, `unexpected routes: ${routes.join(', ')}`)
    assert.ok(routes.some(r => r.endsWith('customer-reviews/photos/route.ts')))
    assert.ok(routes.some(r => r.endsWith('customer-reviews/whatsapp/route.ts')))
    // Review images: the same byte pipeline as photos, a different
    // authorisation entirely — `verify` on a draft that is still pending,
    // rather than `use` on a card the caller holds.
    assert.ok(routes.some(r => r.endsWith('customer-reviews/images/route.ts')))
    // Editing a pending draft. It calls no model and holds no credential; it is
    // a route because the write goes through a definer function that must not
    // be reachable from a browser.
    assert.ok(routes.some(r => r.endsWith('customer-reviews/draft/route.ts')))
    // The two that call a model, and the only two that need the resolved verify
    // permission rather than use. They exist as routes for one reason:
    // ANTHROPIC_API_KEY, which a browser must never hold.
    assert.ok(routes.some(r => r.endsWith('customer-reviews/generate/route.ts')))
    assert.ok(routes.some(r => r.endsWith('customer-reviews/revise/route.ts')))
    // The project image library. Same byte pipeline as the two image routes
    // above and a third subject: an image belongs to a PROJECT, is reused
    // across reviews and across employees, and lives in its own private
    // bucket. It is a route for the reason they are — adding or removing one
    // spans the bucket and a metadata table, and no client may do half of it.
    assert.ok(routes.some(r => r.endsWith('customer-reviews/image-groups/route.ts')))
  })

  test('and APPROVING adds no route at all', () => {
    // Approving and releasing take their actor from auth.uid() and name no
    // user, so there is nothing for a server to establish that the database
    // cannot establish for itself. They are RPCs the browser calls directly,
    // through RLS and a definer function — the same shape as booking. A route
    // in front of them would be a layer with no question to answer.
    const list = readFileSync(
      join(ROOT, 'src/app/customer-reviews/TestCardListScreen.tsx'), 'utf8',
    ).replace(/\r\n/g, '\n')
    assert.ok(list.includes("'approve_customer_review_drafts'"))
    assert.ok(list.includes("'approve_customer_review_draft_batch'"))
    assert.equal(/fetch\('\/api\/customer-reviews\/approve/.test(list), false)

    const detail = readFileSync(
      join(ROOT, 'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx'), 'utf8',
    ).replace(/\r\n/g, '\n')
    assert.ok(detail.includes("supabase.rpc('unbook_customer_review_test_card'"))
    assert.equal(/fetch\('\/api\/customer-reviews\/unbook/.test(detail), false)
  })

  test('and it is the only place the client posts a file', () => {
    assert.ok(manager.includes("fetch('/api/customer-reviews/photos', { method: 'POST', body })"))
    // The browser no longer writes an object or a row itself.
    assert.equal(manager.includes('.storage'), true, 'reading is still direct')
    assert.equal(/\.storage[\s\S]{0,60}\.upload\(/.test(manager), false, 'the browser must not upload')
    assert.equal(
      /from\('customer_review_test_card_screenshots'\)[\s\S]{0,40}\.insert\(/.test(manager), false,
      'the browser must not insert metadata',
    )
  })
})

// ── 2. Authentication and permission, before anything else ──────────────────

describe('who may call it', () => {
  test('the caller is identified from their own session, not from a header token', () => {
    assert.ok(route.includes("const caller = await createClient()"))
    assert.ok(route.includes('await caller.auth.getUser()'))
    assert.ok(route.includes('if (authError || !user) return fail(401'))
  })

  test('an inactive employee is refused', () => {
    assert.ok(route.includes("if (!profile || profile.is_active !== true) return fail(403"))
  })

  test('customer_review_test_cards.use is resolved for them', () => {
    assert.ok(route.includes("p_module_key: 'customer_review_requests'"))
    assert.ok(route.includes("p_action_key: 'use'"))
    assert.ok(route.includes('if (allowed !== true) return fail(403'))
  })

  test('THE PERMISSION CHECK COMES BEFORE THE BODY IS READ', () => {
    // Otherwise an unauthorized caller could make the server buffer a 5 MB
    // upload before being told no.
    assert.ok(route.indexOf("p_action_key: 'use'") < route.indexOf('await req.formData()'))
  })

  test('the request is read through the CALLER, so RLS decides visibility', () => {
    // Reading it with the service role would answer "does this row exist"
    // instead of "may this person see it".
    assert.ok(route.includes("await caller\n    .from('customer_review_test_cards')")
      || route.includes("caller\n    .from('customer_review_test_cards')"))
    assert.ok(route.includes('if (!card) return fail(404'))
  })

  test('ONLY THE HOLDER MAY ATTACH, AND AN ADMINISTRATOR IS NOT AN EXCEPTION', () => {
    assert.ok(route.includes('if (card.booked_by !== user.id) return fail(403'))

    // The check that stood here was `!holdsCard && !isAdmin`, which let an
    // administrator attach a screenshot to a test somebody else ran — evidence
    // presented under another person's name. Asserted as an ABSENCE as well as
    // a presence, because the two forms differ by one disjunct and read alike.
    assert.equal(/holdsCard/.test(route), false,
      'the holds-or-is-admin helper is still there')
    assert.equal(/isAdmin\s*(\|\||&&)|(\|\||&&)\s*!?\s*isAdmin/.test(route), false,
      'isAdmin is still combined into an authorization decision')

    // isAdmin USED TO BE COMPUTED HERE, to decide whether the permission RPC
    // needed asking at all. That shortcut is gone too: the RPC is asked of
    // every caller, so there is nothing left for the variable to do and it is
    // not merely unused but absent — along with the `role` column, which
    // neither handler selects any more.
    //
    // A value that never arrives cannot be branched on by a later edit, which
    // is why this asserts the SELECT rather than only the variable.
    assert.equal(/\bisAdmin\b/.test(route), false, 'isAdmin is back in this route')
    assert.equal(/select\('role/.test(route), false, 'the route reads users.role again')
    assert.ok(route.includes("select('is_active')"))
  })

  test('THE PERMISSION RPC IS ASKED OF EVERY CALLER, IN BOTH HANDLERS', () => {
    // Two handlers, two independent copies of the check — POST attaches and
    // DELETE withdraws, and both are tester actions needing `use`. A
    // correction applied to one and forgotten in the other is exactly the
    // defect worth catching, so this counts them.
    const resolves = [...route.matchAll(/rpc\('resolve_permission'/g)]
    assert.equal(resolves.length, 2, 'both handlers must resolve the permission')

    // Both ask for `use`, and both are unconditional — each call sits at the
    // top level of its handler rather than inside a branch that could exempt
    // somebody from it.
    assert.equal((route.match(/p_action_key: 'use'/g) ?? []).length, 2)
    assert.equal(/if \(!isAdmin\) \{/.test(route), false,
      'a resolve call is still wrapped in a role check')
    assert.equal((route.match(/if \(allowed !== true\) return fail\(403/g) ?? []).length, 2)
  })

  test('A SCREENSHOT MAY ONLY BE ATTACHED WHILE THE CARD IS BOOKED', () => {
    // One rule now, not a kind ladder. Once a card is submitted the evidence is
    // what a verifier is about to look at, and once it is verified it is what
    // they looked at; neither may change underneath them. It mirrors the
    // removal side exactly, so an image can be added and withdrawn in the same
    // window.
    assert.ok(route.includes("if (card.status !== 'booked') return fail(409, MESSAGES.wrong_status)"))
  })
})

// ── 3. The bytes ────────────────────────────────────────────────────────────

describe('the file itself', () => {
  test('the declared size is refused first, and the REAL length checked after', () => {
    assert.ok(route.includes('(file as File).size > TEST_SCREENSHOT_MAX_BYTES'))
    assert.ok(route.includes('processReviewImage(bytes, TEST_SCREENSHOT_MAX_BYTES)'))
  })

  test('VALIDATION AND RE-ENCODING HAPPEN BEFORE ANYTHING IS STORED', () => {
    assert.ok(
      route.indexOf('processReviewImage(') < route.indexOf('.upload('),
      'the upload must not precede the decode',
    )
  })

  test('a rejection returns a prewritten sentence and nothing else', () => {
    assert.ok(route.includes('IMAGE_REJECTION_MESSAGES[processed.reason]'))
    assert.ok(route.includes('PROCESSING_REJECTION_MESSAGES[processed.reason]'))
  })

  test('THE STORED BYTES ARE THE DECODER’S OUTPUT, not the upload', () => {
    // `stored` is the re-encoded buffer. The uploaded bytes are not written,
    // not hashed, and not described by the metadata row.
    assert.ok(route.includes('const stored = processed.bytes'))
    assert.ok(route.includes('.upload(storagePath, stored, {'))
    assert.ok(route.includes('byte_size: stored.length'))
    assert.ok(route.includes("createHash('sha256').update(stored)"))
    assert.equal(/\.upload\(storagePath, bytes\b/.test(route), false)
  })

  test('the stored type is the one it was re-encoded as', () => {
    assert.ok(route.includes('mime_type: processed.mime'))
    assert.ok(route.includes('contentType: processed.mime'))
    assert.ok(route.includes('upsert: false'))
    assert.equal(/mime_type:\s*file\.type|byte_size:\s*file\.size/.test(route), false)
  })
})

// ── 4. The path ─────────────────────────────────────────────────────────────

describe('where the bytes land is decided by the server', () => {
  test('the key is generated here, from the card id and a fresh uuid', () => {
    assert.ok(route.includes('const storagePath = `${cardId}/${kind}/${randomUUID()}.${extension}`'))
  })

  test('NO PATH, BUCKET OR KEY IS EVER TAKEN FROM THE BODY', () => {
    for (const field of ['storagePath', 'storage_path', 'path', 'bucket', 'key']) {
      assert.equal(
        route.includes(`form.get('${field}')`), false,
        `the body must not carry ${field}`,
      )
    }
    // The three things it does read, and nothing more.
    const reads = [...route.matchAll(/form\.get\('(\w+)'\)/g)].map(m => m[1]).sort()
    assert.deepEqual(reads, ['cardId', 'file', 'kind'])
  })

  test('the card id must be a uuid before it reaches a query or a path', () => {
    assert.ok(route.includes('!UUID_RE.test(rawId)'))
  })

  test('the kind is checked against a closed list, and the list holds ONE kind', () => {
    // There are no project photographs and no review proof here: there are no
    // projects and no reviews. The list survives as a list so the shape stays
    // correct if a second kind is ever justified.
    assert.ok(route.includes("const KINDS = ['test_screenshot'] as const"))
    assert.ok(route.includes('!(KINDS as readonly string[]).includes(rawKind)'))
  })

  test('uploaded_by is the authenticated user, not a field', () => {
    assert.ok(route.includes('uploaded_by: user.id'))
    assert.equal(route.includes("form.get('uploaded_by')"), false)
  })
})

// ── 5. Cleanup and duplicates ───────────────────────────────────────────────

describe('nothing is left behind', () => {
  test('a failed metadata insert removes the object again', () => {
    const failureBranch = route.slice(route.indexOf('if (rowError || !row)'))
    assert.ok(failureBranch.includes('.remove([storagePath])'))
    assert.ok(failureBranch.indexOf('.remove([storagePath])') < failureBranch.indexOf('return fail'))
  })

  test('a repeated upload is answered by CONTENT, not by a timer', () => {
    assert.ok(route.includes("createHash('sha256').update(stored).digest('hex')"))
    assert.ok(route.includes('row.content_sha256 === digest'))
    assert.ok(route.includes('MESSAGES.duplicate'))
  })

  test('the per-card count limit is checked server-side before the bytes move', () => {
    assert.ok(route.includes('live.length >= MAX_TEST_SCREENSHOTS'))
    // A row already marked for removal does not count against the limit: it is
    // on its way out, every reader already treats it as gone, and counting it
    // would let a failed removal permanently block its own replacement.
    assert.ok(route.includes('row.removal_started_at === null'))
  })
})

// ── 5b. ONE LIVE SCREENSHOT, AND WHERE THAT IS ACTUALLY TRUE ────────────────
//
// The count above is a READ FOLLOWED BY A WRITE. Two concurrent uploads with
// different content both read zero and both proceed, so the route cannot be the
// guarantee — and a test that only matched the route's source would have called
// the defect fixed while it was still there.
//
// These tests are about the DATABASE. The behavioural proof that two concurrent
// inserts really do collide runs against a live disposable stack in
// supabase/tests/customer_review_test_card_assertions.sql and in the
// concurrency probe the runner invokes; what is checkable here is that the
// indexes exist, that they are PARTIAL in the specific way that matters, and
// that the route turns the resulting error back into an ordinary answer.

describe('one live screenshot per card is a DATABASE guarantee', () => {
  test('the count in the route is documented as insufficient on its own', () => {
    // Not decoration. The next person to read that check needs to know it is a
    // courtesy, or they will "simplify" the index away as redundant.
    const at = raw.indexOf('live.length >= MAX_TEST_SCREENSHOTS')
    const preamble = raw.slice(Math.max(0, at - 1400), at)
    assert.ok(/READ FOLLOWED BY A WRITE/i.test(preamble),
      'the route does not say why its own count cannot be the guarantee')
    assert.ok(preamble.includes('customer_review_screenshot_one_live_per_card'),
      'the route does not name the index that actually enforces this')
    // And that name is a real index, not a comment describing an intention.
    assert.ok(sql.includes('create unique index customer_review_screenshot_one_live_per_card'))
  })

  test('TWO PARTIAL UNIQUE INDEXES EXIST', () => {
    assert.ok(sql.includes(
      'create unique index customer_review_screenshot_one_live_per_card\n' +
      '  on public.customer_review_test_card_screenshots (card_id)\n' +
      '  where removal_started_at is null;'),
      'one-live-per-card index missing or not partial')

    assert.ok(sql.includes(
      'create unique index customer_review_screenshot_unique_live_content\n' +
      '  on public.customer_review_test_card_screenshots (card_id, content_sha256)\n' +
      '  where removal_started_at is null;'),
      'unique-live-content index missing or not partial')
  })

  test('THE OLD TOTAL CONSTRAINT IS GONE, and its removal is the retry fix', () => {
    // `unique (card_id, content_sha256)` counted rows already marked for
    // removal. A failed object deletion therefore left the card permanently
    // unable to accept a replacement — including the very same file, which is
    // exactly what a person retries with.
    assert.equal(sql.includes('customer_review_screenshot_unique_content_per_card'), false,
      'the total (non-partial) uniqueness constraint is still there')

    // No unqualified uniqueness on this table at all: every uniqueness rule it
    // has must exclude rows on their way out.
    const table = 'public.customer_review_test_card_screenshots'
    for (const m of sql.matchAll(/create unique index (\w+)\n([\s\S]*?);/g)) {
      if (!m[2].includes(table)) continue
      assert.ok(m[2].includes('where removal_started_at is null'),
        `index ${m[1]} on the screenshots table is not partial`)
    }
  })

  test('the losing inserter is told the same thing the count would have told it', () => {
    const branch = route.slice(route.indexOf('if (rowError || !row)'))
    assert.ok(branch.includes("rowError?.code === '23505'"),
      'a unique violation is not distinguished from a generic failure')
    assert.ok(branch.includes('MESSAGES.duplicate'))
    assert.ok(branch.includes('MESSAGES.too_many'))
    // Told apart by INDEX NAME rather than by guessing from prose.
    assert.ok(branch.includes("includes('unique_live_content')"))
    // The object is still removed first, so losing the race leaves no orphan.
    assert.ok(branch.indexOf('.remove([storagePath])') < branch.indexOf("'23505'"))
  })
})

// ── 6. What it says back ────────────────────────────────────────────────────

describe('errors are safe', () => {
  test('every message is chosen from a closed list', () => {
    assert.ok(route.includes('const MESSAGES = {'))
    // fail() is only ever called with a MESSAGES member or an inspector message.
    // Every value fail() is handed must be a member of one of the two closed
    // maps. A ternary between two members is still two members; anything that
    // is not a member — a template, a concatenation, an error's own text — is
    // what this refuses.
    for (const match of route.matchAll(/fail\(\d+,([\s\S]*?)\)\s*$/gm)) {
      const tokens = match[1].split(/\?|:/).map(t => t.trim()).filter(Boolean)
      for (const token of tokens) {
        // The condition of a ternary is not a message.
        // The condition of a ternary is not a message: a comparison, or the
        // constraint-name test that tells the two unique indexes apart.
        if (/^kind ===|^inspection\.reason ===|^constraint\.includes\(/.test(token)) continue
        assert.ok(
          token.startsWith('MESSAGES.') || token.startsWith('IMAGE_REJECTION_MESSAGES'),
          `fail() called with something that is not a prewritten message: ${token}`,
        )
      }
    }
  })

  test('no response or log carries a filename, a path, a number or a token', () => {
    for (const leak of ['displayName', 'storagePath', 'whatsapp', 'customer_name', 'signedUrl', 'SUPABASE_SERVICE_ROLE_KEY']) {
      assert.equal(
        new RegExp(`fail\\([^)]*${leak}`).test(route), false,
        `a failure response mentions ${leak}`,
      )
    }
    // The one console line names ENV VARIABLE NAMES, never values or content.
    const logs = [...route.matchAll(/console\.\w+\(([^\n]*)/g)].map(m => m[1])
    // One per handler, and both name env VARIABLES rather than values.
    assert.equal(logs.length, 2)
    for (const line of logs) assert.ok(line.includes('admin.missing.join'))
  })

  test('private answers are never cached', () => {
    assert.ok(route.includes("'Cache-Control': 'no-store, private'"))
  })

  test('a missing service-role credential is a handled result, not a throw', () => {
    assert.ok(route.includes('const admin = adminClient()'))
    assert.ok(route.includes('if (!admin.ok)'))
    assert.ok(route.includes('MESSAGES.unavailable'))
  })

  test('THE SERVICE-ROLE KEY EXISTS ONLY ON THIS SIDE', () => {
    // adminClient() reads process.env.SUPABASE_SERVICE_ROLE_KEY, which Next does
    // not inline into a client bundle — and the route carries no 'use client'.
    assert.equal(raw.includes("'use client'"), false)
    assert.equal(manager.includes('adminClient'), false)
    assert.equal(manager.includes('SERVICE_ROLE'), false)
  })
})

// ── 7. The database half of the boundary ────────────────────────────────────

describe('a client cannot go around the route', () => {
  test('there is no storage INSERT policy for this bucket', () => {
    assert.equal(sql.includes('create policy "customer_review_photos_storage_insert"'), false)
  })

  test('there is no metadata INSERT policy either', () => {
    assert.equal(sql.includes('create policy "customer_review_test_screenshots_insert"'), false)
  })

  test('and every write privilege is revoked, so a policy added later still fails', () => {
    assert.ok(sql.includes(
      'revoke insert, update, delete, truncate\n  on public.customer_review_test_card_screenshots from authenticated, anon',
    ))
  })

  test('the migration ASSERTS all of that at apply time', () => {
    const assertions = sql.slice(sql.indexOf('do $'))
    assert.ok(assertions.includes('only the trusted upload route may register an image'))
    assert.ok(assertions.includes('a client INSERT policy exists on the customer-review-test-screenshots bucket'))
    assert.ok(assertions.includes("has_table_privilege('authenticated', 'public.customer_review_test_card_screenshots', v_col)"))
  })

  test('reading is still the client’s, through short-lived signed URLs', () => {
    assert.ok(sql.includes('create policy "customer_review_test_screenshots_storage_select"'))
    assert.ok(manager.includes('createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)'))
    assert.ok(manager.includes('const SIGNED_URL_TTL_SECONDS = 300'))
  })

  test('REMOVING IS A SERVER OPERATION TOO — see photoRemoval.test.ts', () => {
    // Both delete policies are gone: a client that could remove one half of an
    // attachment would eventually leave the other half behind.
    assert.equal(sql.includes('create policy "customer_review_photos_delete"'), false)
    assert.equal(sql.includes('create policy "customer_review_photos_storage_delete"'), false)
    assert.ok(route.includes('export async function DELETE(req: NextRequest)'))
  })
})

// ── 8. The one pure function the route exports ──────────────────────────────

describe('the stored filename', () => {
  test('path separators and traversal cannot survive it', () => {
    assert.equal(sanitizeDisplayName('../../../etc/passwd'), 'etc passwd')
    assert.equal(sanitizeDisplayName('a/b/c.jpg'), 'a b c.jpg')
    assert.equal(sanitizeDisplayName('..\\..\\windows\\system32'), 'windows system32')
  })

  test('control characters are removed entirely', () => {
    const nasty = `photo${String.fromCharCode(0)}${String.fromCharCode(27)}.jpg`
    const cleaned = sanitizeDisplayName(nasty)
    assert.equal(cleaned, 'photo.jpg')
    for (const ch of cleaned) {
      const code = ch.codePointAt(0) ?? 0
      assert.ok(code >= 0x20 && code !== 0x7f)
    }
  })

  test('it is bounded, so it cannot overflow the column after the object landed', () => {
    assert.equal(sanitizeDisplayName('x'.repeat(500)).length, 120)
  })

  test('a name that sanitises to nothing becomes a constant, never empty', () => {
    // file_name is NOT NULL with a non-blank CHECK; an empty value would fail
    // the insert after the object had already been stored.
    for (const input of ['', '   ', '///', String.fromCharCode(0)]) {
      assert.equal(sanitizeDisplayName(input), 'photo')
    }
  })

  test('an ordinary filename is left alone', () => {
    assert.equal(sanitizeDisplayName('café chairs 2026.jpg'), 'café chairs 2026.jpg')
  })
})
