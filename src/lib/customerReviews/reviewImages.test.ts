/**
 * UP TO FOUR IMAGES ON A DRAFT, AND NEVER A FIFTH.
 *
 * ── THE PROPERTY THAT NEEDED A DATABASE, NOT A COUNT ───────────────────────
 *
 * "At most four" written as `if (existing.length >= 4) refuse` is a READ
 * FOLLOWED BY A WRITE. Two uploads arriving together both read three, both
 * proceed, and the review ends up with five. The module already learned this
 * once for screenshots, which is why the fifth image is refused by a partial
 * unique index over (card_id, image_slot) instead: slots run 0 to 3, so a fifth
 * row has nowhere to go.
 *
 * The route still counts. That is a courtesy — it refuses before five megabytes
 * are decoded and re-encoded — and the tests below assert that it is a courtesy
 * by checking that the index exists and that the route maps a 23505 back to the
 * same sentence the count produces.
 *
 * ── THE OTHER THINGS THAT HAVE TO HOLD ─────────────────────────────────────
 *
 *   * The window is `pending_approval` for both attaching and removing, and
 *     the images SURVIVE approval rather than being cascaded away.
 *   * A review image is not a test screenshot: different permission, different
 *     window, different route, and the removal function refuses the wrong kind.
 *   * Nothing is public. No public URL is minted anywhere, and the bucket is
 *     the private one.
 *   * A review image never counts towards the screenshot a submission requires.
 *
 * Reads repository files and pure functions only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/reviewImages.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_REVIEW_IMAGES,
  REVIEW_IMAGE_ALLOWED_TYPES,
  REVIEW_IMAGE_BUCKET,
  REVIEW_IMAGE_KIND,
  REVIEW_IMAGE_MAX_BYTES,
  REVIEW_IMAGE_SLOTS,
  buildReviewImagePath,
  extensionForMime,
  nextFreeSlot,
  reviewImageContentType,
  validateReviewImage,
} from './reviewImages'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const executable = (source: string) =>
  source
    .split('\n')
    .filter(l => !l.trimStart().startsWith('--') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')

const MIGRATION = read('supabase/migrations/20261031000000_review_workflow_twelve_drafts_editing_and_images.sql')
const SQL = executable(MIGRATION)
const ROUTE = read('src/app/api/customer-reviews/images/route.ts')
const MANAGER = read('src/components/customerReviews/ReviewImageManager.tsx')

function fn(name: string): string {
  const at = SQL.indexOf(`create or replace function public.${name}(`)
  assert.ok(at >= 0, `${name} is not defined in the migration`)
  const end = SQL.indexOf('\n$$;', at)
  assert.ok(end > at, `${name} has no terminator`)
  return SQL.slice(at, end)
}

const file = (over: Partial<{ name: string; type: string; size: number }> = {}) => ({
  name: 'chairs.jpg',
  type: 'image/jpeg',
  size: 400_000,
  ...over,
})

// ══ 1. ZERO TO FOUR ═════════════════════════════════════════════════════════

describe('zero to four, and the slot that makes it so', () => {
  test('four is the limit, and there are four slots', () => {
    assert.equal(MAX_REVIEW_IMAGES, 4)
    assert.deepEqual([...REVIEW_IMAGE_SLOTS], [0, 1, 2, 3])
    assert.equal(REVIEW_IMAGE_SLOTS.length, MAX_REVIEW_IMAGES)
  })

  test('ZERO IS VALID — images are optional', () => {
    // A review with no images is an ordinary review, and the share path handles
    // it. Nothing anywhere requires one.
    assert.equal(nextFreeSlot([]), 0)
    const manager = executable(MANAGER)
    assert.ok(manager.includes('No images are attached to this review.'))
    assert.equal(/required|must attach|at least one image/i.test(manager), false)
  })

  test('slots fill from the lowest free one', () => {
    assert.equal(nextFreeSlot([]), 0)
    assert.equal(nextFreeSlot([0]), 1)
    assert.equal(nextFreeSlot([0, 1]), 2)
    assert.equal(nextFreeSlot([0, 1, 2]), 3)
  })

  test('THE FIFTH HAS NOWHERE TO GO', () => {
    assert.equal(nextFreeSlot([0, 1, 2, 3]), null)
  })

  test('a gap left by a removal is reused, not appended past', () => {
    // Removing slot 1 and attaching another gives the new one slot 1. Without
    // this, four attachments after three removals would be the seventh, and the
    // fourth image would be refused with three showing on screen.
    assert.equal(nextFreeSlot([0, 2, 3]), 1)
    assert.equal(nextFreeSlot([1, 2, 3]), 0)
    assert.equal(nextFreeSlot([0, 1, 3]), 2)
  })

  test('duplicate or out-of-range slots do not confuse it', () => {
    assert.equal(nextFreeSlot([0, 0, 0]), 1)
    assert.equal(nextFreeSlot([9, 10]), 0)
  })
})

// ══ 2. WHAT A FILE HAS TO BE ════════════════════════════════════════════════

describe('the file validation', () => {
  test('JPEG, PNG and WebP, and nothing else', () => {
    assert.deepEqual([...REVIEW_IMAGE_ALLOWED_TYPES], ['image/jpeg', 'image/png', 'image/webp'])
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      assert.equal(validateReviewImage(file({ type })), null, `${type} was refused`)
    }
    for (const type of ['application/pdf', 'image/gif', 'image/svg+xml', 'video/mp4', 'image/heic']) {
      assert.notEqual(validateReviewImage(file({ type })), null, `${type} was accepted`)
    }
  })

  test('an extension cannot launder a disallowed type', () => {
    // A file that SAYS it is a PDF is refused whatever it is called. The
    // extension is consulted only when the browser reported nothing at all.
    assert.equal(reviewImageContentType({ name: 'x.jpg', type: 'application/pdf' }), null)
    assert.equal(reviewImageContentType({ name: 'x.jpg', type: '' }), 'image/jpeg')
    assert.equal(reviewImageContentType({ name: 'x.webp', type: '' }), 'image/webp')
    assert.equal(reviewImageContentType({ name: 'x.exe', type: '' }), null)
    assert.equal(reviewImageContentType({ name: 'noextension', type: '' }), null)
  })

  test('empty and oversized are both refused', () => {
    assert.notEqual(validateReviewImage(file({ size: 0 })), null)
    assert.equal(validateReviewImage(file({ size: REVIEW_IMAGE_MAX_BYTES })), null)
    assert.notEqual(validateReviewImage(file({ size: REVIEW_IMAGE_MAX_BYTES + 1 })), null)
  })

  test('the limit matches the bucket the objects land in', () => {
    // 5 MB is file_size_limit on customer-review-test-screenshots. Validating
    // against anything wider would hand Storage a file it then refuses.
    assert.equal(REVIEW_IMAGE_MAX_BYTES, 5 * 1024 * 1024)
    assert.equal(REVIEW_IMAGE_BUCKET, 'customer-review-test-screenshots')
    const outreach = read('supabase/migrations/20261017000000_customer_review_outreach.sql')
    assert.ok(outreach.includes('5242880'))
  })

  test('the object key is generated, and starts with the card id', () => {
    // The storage policy reads ownership out of split_part(name, '/', 1), and
    // the metadata CHECK requires the two to agree. Nothing the caller typed
    // contributes a character.
    const path = buildReviewImagePath('11111111-2222-4333-8444-555555555555', 'abc', 'jpg')
    assert.equal(path, '11111111-2222-4333-8444-555555555555/review_image/abc.jpg')
    assert.equal(path.split('/')[0], '11111111-2222-4333-8444-555555555555')
    assert.equal(extensionForMime('image/png'), 'png')
    assert.equal(extensionForMime('image/webp'), 'webp')
    assert.equal(extensionForMime('image/jpeg'), 'jpg')
  })
})

// ══ 3. THE DATABASE REFUSES THE FIFTH ═══════════════════════════════════════

describe('the migration', () => {
  test('the kind column learned the second value', () => {
    assert.ok(SQL.includes("check (kind in ('test_screenshot', 'review_image'))"))
  })

  test('a slot is required of a review image and forbidden of a screenshot', () => {
    assert.ok(SQL.includes('check (image_slot is null or image_slot between 0 and 3)'))
    assert.ok(SQL.includes("check ((kind = 'review_image') = (image_slot is not null))"))
  })

  test('THE FIFTH IMAGE IS REFUSED BY A UNIQUE INDEX, not by a count', () => {
    // The assertion this whole file is built around.
    assert.ok(SQL.includes('create unique index if not exists customer_review_image_one_live_per_slot'))
    assert.ok(SQL.includes('on public.customer_review_test_card_screenshots (card_id, image_slot)'))
    assert.ok(SQL.includes("where removal_started_at is null and kind = 'review_image'"))
  })

  test('the screenshot index was narrowed so the two kinds do not collide', () => {
    // one_live_per_card was unconditional on card_id. Left alone it would have
    // refused a review image on any card that already had a screenshot, and a
    // second review image on any card at all.
    assert.ok(SQL.includes('drop index if exists public.customer_review_screenshot_one_live_per_card'))
    assert.ok(SQL.includes("where removal_started_at is null and kind = 'test_screenshot'"))
  })

  test('the same-content guard is scoped by kind', () => {
    assert.ok(SQL.includes('on public.customer_review_test_card_screenshots (card_id, kind, content_sha256)'))
  })
})

// ══ 4. ACCESS CONTROL ═══════════════════════════════════════════════════════

describe('who may attach and remove', () => {
  const code = executable(ROUTE)

  test('the route resolves `verify` — not `use` — for both verbs', () => {
    // A review image is a verifier's action on a draft they have not approved.
    // The screenshot route requires `use` and card ownership; this one requires
    // neither, and requires something the screenshot route does not.
    const verifyCount = code.split("p_action_key: 'verify'").length - 1
    assert.equal(verifyCount, 2, 'both POST and DELETE must resolve verify')
    assert.equal(code.includes("p_action_key: 'use'"), false)
  })

  test('and it reads is_active, never a role', () => {
    assert.ok(code.includes(".select('is_active')"))
    assert.equal(/\.select\([^)]*\brole\b/.test(code), false)
    assert.equal(/isAdmin|is_admin/.test(code), false)
  })

  test('the card is read as the CALLER, so RLS decides visibility', () => {
    assert.ok(code.includes("caller\n    .from('customer_review_test_cards')"))
    assert.ok(code.includes('MESSAGES.not_found'))
  })

  test('attaching is refused unless the review is still pending', () => {
    assert.ok(code.includes("if (card.status !== 'pending_approval') return fail(409, MESSAGES.wrong_status)"))
  })

  test('a deleted review is refused', () => {
    assert.ok(code.includes('card.deleted_at !== null'))
  })

  test('nothing the client sends names a location', () => {
    // The bucket is a constant, the key is generated here, the slot is chosen
    // here, and uploaded_by is the authenticated user — never a field.
    assert.ok(code.includes('buildReviewImagePath(cardId, randomUUID(), extensionForMime(processed.mime))'))
    assert.ok(code.includes('uploaded_by: user.id'))
    assert.equal(/form\.get\(['"](path|bucket|slot|storage_path|uploaded_by)['"]\)/.test(code), false)
  })

  test('the bytes are decoded and RE-ENCODED before anything is stored', () => {
    // The stored object is libvips output, never the upload, which is what
    // makes the recorded mime_type a fact rather than a claim.
    assert.ok(code.includes('await processReviewImage(bytes, REVIEW_IMAGE_MAX_BYTES)'))
    assert.ok(code.includes('const stored = processed.bytes'))
    assert.ok(code.includes('byte_size: stored.length'))
    assert.ok(code.includes('mime_type: processed.mime'))
    // The hash is over the STORED bytes.
    assert.ok(code.includes("createHash('sha256').update(stored)"))
  })

  test('the count is a courtesy and the index is the guarantee', () => {
    assert.ok(code.includes('if (live.length >= MAX_REVIEW_IMAGES) return fail(409, MESSAGES.too_many)'))
    // 23505 from the slot index becomes the SAME sentence the count produces,
    // so a verifier sees one answer however the race went.
    assert.ok(code.includes("rowError?.code === '23505'"))
    assert.ok(code.includes('MESSAGES.duplicate'))
    assert.ok(code.includes('MESSAGES.too_many'))
  })

  test('a failed metadata insert removes the object again', () => {
    assert.ok(code.includes('await service.storage.from(REVIEW_IMAGE_BUCKET).remove([storagePath])'))
  })
})

// ══ 5. REMOVAL, AND WHAT SURVIVES APPROVAL ══════════════════════════════════

describe('removal', () => {
  const body = fn('begin_customer_review_image_removal')

  test('it is a definer function the browser cannot execute', () => {
    assert.ok(body.includes('security definer'))
    assert.ok(SQL.includes('revoke execute on function public.begin_customer_review_image_removal(uuid, uuid) from public, anon, authenticated'))
    assert.ok(SQL.includes('revoke execute on function public.finish_customer_review_image_removal(uuid) from public, anon, authenticated'))
  })

  test('it locks the row first', () => {
    assert.ok(body.includes('for update'))
  })

  test('IT REFUSES A TEST SCREENSHOT', () => {
    // Sending a screenshot id here would otherwise remove it under `verify`,
    // which is not the permission the screenshot half requires.
    assert.ok(body.includes("if s.kind <> 'review_image' then"))
  })

  test('it resolves `verify`, with no administrator branch', () => {
    assert.ok(body.includes("public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify')"))
    assert.equal(/\brole\b/.test(body), false)
  })

  test('REMOVAL CLOSES AT APPROVAL, and the images stay', () => {
    // The point of refusing here rather than cascading: an approved review
    // keeps the images it was approved with, and nothing deletes them later.
    assert.ok(body.includes("if c.status <> 'pending_approval' then"))
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_LOCKED'))
    // Nothing anywhere in the migration deletes an image when a review is
    // approved. `on delete cascade` from the CARD is the pre-existing
    // behaviour for a deleted card and is not touched here.
    assert.equal(/approve[\s\S]{0,400}delete from public\.customer_review_test_card_screenshots/.test(SQL), false)
  })

  test('it is idempotent, so an interrupted removal converges', () => {
    assert.ok(body.includes('if s.removal_started_at is null then'))
    assert.ok(fn('finish_customer_review_image_removal').includes('if not found then return true; end if;'))
  })

  test('the trail records an image_removed, distinct from a screenshot', () => {
    assert.ok(SQL.includes("'image_removed'"))
    assert.ok(SQL.includes("case when old.kind = 'review_image' then 'image_removed' else 'screenshot_removed' end"))
  })

  test('the route removes the object and the row as one operation', () => {
    const code = executable(ROUTE)
    assert.ok(code.includes("'begin_customer_review_image_removal'"))
    assert.ok(code.includes("'finish_customer_review_image_removal'"))
    assert.ok(code.includes('runPhotoRemoval'))
  })
})

// ══ 6. NOTHING IS PUBLIC, AND NOTHING IS CONFUSED WITH EVIDENCE ═════════════

describe('what the images are not', () => {
  test('no public URL is minted anywhere', () => {
    for (const source of [ROUTE, MANAGER, read('src/components/customerReviews/ShareReview.tsx')]) {
      const code = executable(source)
      assert.equal(/getPublicUrl|publicUrl/.test(code), false, 'a public URL is minted')
    }
  })

  test('reading is short-lived signed URLs, governed by the card policy', () => {
    const manager = executable(MANAGER)
    assert.ok(manager.includes('createSignedUrls'))
    assert.ok(manager.includes('const SIGNED_URL_TTL_SECONDS = 300'))
  })

  test('the browser cannot write an object or a row itself', () => {
    const manager = executable(MANAGER)
    assert.ok(manager.includes("fetch('/api/customer-reviews/images'"))
    assert.equal(/supabase\s*\.\s*from\(['"]customer_review_test_card_screenshots['"]\)[\s\S]{0,60}\.(insert|delete|update)/.test(manager), false)
    assert.equal(/storage[\s\S]{0,60}\.(upload|remove)\(/.test(manager), false)
  })

  test('A REVIEW IMAGE NEVER COUNTS AS THE SUBMISSION SCREENSHOT', () => {
    // Both kinds live in one table, so the detail screen's single query returns
    // both — and submissionBlockers() reads the screenshot count to decide
    // whether a card may be handed to a verifier. Letting a review image count
    // would let somebody submit a test they never screenshotted.
    const detail = executable(read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx'))
    assert.ok(detail.includes('setScreenshots(live.filter(photo => photo.kind !== REVIEW_IMAGE_KIND))'))
    assert.ok(detail.includes('.filter(photo => photo.kind === REVIEW_IMAGE_KIND)'))
    assert.ok(detail.includes('submissionBlockers(card, screenshots.length)'))
  })

  test('and the two managers are given different lists', () => {
    const detail = executable(read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx'))
    assert.ok(detail.includes('screenshots={screenshots}'))
    assert.ok(detail.includes('images={reviewImages}'))
  })

  test('the kind constant is the one the database checks', () => {
    assert.equal(REVIEW_IMAGE_KIND, 'review_image')
    assert.ok(SQL.includes("'review_image'"))
  })
})

// ══ 7. THE SCREEN ═══════════════════════════════════════════════════════════

describe('the image screen', () => {
  const manager = executable(MANAGER)

  test('thumbnails, with a removal control on each', () => {
    assert.ok(manager.includes('<img'))
    assert.ok(manager.includes('aria-label={`Remove ${image.file_name}`}'))
  })

  test('it says how many of how many', () => {
    assert.ok(manager.includes('{images.length} of {MAX_REVIEW_IMAGES}'))
  })

  test('the add control turns off at four, and says why', () => {
    assert.ok(manager.includes('const full = images.length >= MAX_REVIEW_IMAGES'))
    assert.ok(MANAGER.includes('Four images is the limit. Remove one to add another.'))
  })

  test('a multi-select that would overflow is refused before any upload', () => {
    assert.ok(manager.includes('const room = MAX_REVIEW_IMAGES - images.length'))
    assert.ok(manager.includes('if (chosen.length > room)'))
  })

  test('removal is offered only while the review is still editable', () => {
    assert.ok(manager.includes('{canEdit && ('))
    assert.ok(MANAGER.includes('This review has been approved, so its images can no longer be changed.'))
  })

  test('a second press cannot start a second upload or removal', () => {
    assert.ok(manager.includes('uploading.current'))
    assert.ok(manager.includes('removing.current'))
  })

  test('an error is announced, not only shown', () => {
    assert.ok(manager.includes('role="alert"'))
  })
})
