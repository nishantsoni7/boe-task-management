/**
 * WHAT AN IMAGE REVIEW SHOWS BEFORE IT IS BOOKED.
 *
 * A candidate's card said `Image · Ready`, the sheet said the review was worth
 * the image reward, and neither showed a single photograph — the pictures only
 * appeared on the detail screen, AFTER booking. So the one decision the
 * candidate actually makes was made blind: accept a review whose subject is a
 * set of images, sight unseen.
 *
 * The photographs now sit inside the review content, immediately before the
 * Book action. This file pins the four properties that make that safe rather
 * than merely present:
 *
 *   1. THE IMAGE SHEET LOADS THE GROUP, through the reader's own client.
 *   2. THE TEXT SHEET LOADS NOTHING. The group id passed for a text review, or
 *      when no sheet is open, is `null`, and useProjectImages does no work for
 *      a null id. This is asserted on the callers, because it is the callers
 *      that decide.
 *   3. A MISSING, EMPTY OR ARCHIVED GROUP SAYS SO. The shared component's
 *      waiting panel is what renders, so an image review never quietly
 *      presents itself as a text one.
 *   4. THE BOOKING RULE IS UNCHANGED. Showing photographs is a display change;
 *      what may be booked is still canBookCard's answer, and the database's —
 *      the browser now simply supplies the third argument that helper always
 *      took, instead of guessing at it. The second describe() below is about
 *      that: the badge, the panel and the button state ONE readiness.
 *
 * There is ONE image architecture in this module and this change did not add a
 * second: every surface goes through useProjectImages/ProjectImages, so the
 * signed-URL logic exists once. That is asserted here too, because the cheap
 * way to have written this feature was a second loader.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canBookCard } from './status'
import {
  AWAITING_IMAGES_LABEL,
  CHECKING_IMAGES_LABEL,
  READY_LABEL,
  imageReadiness,
  projectGroupUsable,
  readinessLabel,
} from './reviewTypes'
import type { TestCard } from './types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const FULL_VIEW = 'src/components/customerReviews/ReviewFullView.tsx'
const PROJECT_IMAGES = 'src/components/customerReviews/ProjectImages.tsx'
const SHEET_SCREENS = [
  'src/app/customer-reviews/MyReviewsScreen.tsx',
  'src/app/customer-reviews/TestCardListScreen.tsx',
]

describe('the pre-booking sheet shows an image review its photographs', () => {
  test('the full view renders ProjectImages for an image review', () => {
    const s = read(FULL_VIEW)
    assert.ok(
      s.includes("{card.review_type === 'image' && supabase && projectImages && ("),
      'the full view no longer gates the photographs on the review being an image review',
    )
    assert.ok(s.includes('<ProjectImages supabase={supabase} set={projectImages} label={null} />'))
  })

  test('and it renders them before the Book action, not after the decision', () => {
    // The action lives in the sheet FOOTER, so "before the Book action" means
    // last in the body: on a phone the footer is pinned and the photographs are
    // the last thing scrolled past. Anything after them here would come between
    // the evidence and the decision.
    const s = read(FULL_VIEW)
    const images = s.indexOf('<ProjectImages')
    const message = s.indexOf('review-outgoing-message')
    const actions = s.indexOf('export function ReviewFullViewActions')
    assert.ok(images > message, 'the photographs sit above the review text')
    assert.ok(images < actions, 'the photographs are outside the review body')
  })

  test('through the caller’s own client — no route, no service role', () => {
    // The sheet reads the group the same way every other surface does. A
    // service-role path exposed to the browser would return images RLS refuses.
    for (const path of SHEET_SCREENS) {
      const s = read(path)
      assert.ok(
        s.includes("import { useProjectImages } from '@/components/customerReviews/ProjectImages'"),
        `${path} does not use the module's one image loader`,
      )
      assert.ok(s.includes('const readingImages = useProjectImages(\n    supabase,'))
      assert.ok(s.includes('projectImages={readingImages}'))
      assert.equal(/service_role|SERVICE_ROLE/.test(s), false, `${path} reaches for a service role`)
      assert.equal(
        s.includes('/api/customer-reviews/image-groups'), false,
        `${path} fetches project images through a route`,
      )
    }
  })

  test('and a text review’s sheet issues no project-image query at all', () => {
    // The whole lazy rule is this one ternary, in both callers: a null group id
    // makes useProjectImages return NO_PROJECT_IMAGES without a network call.
    // `reading` is null while no sheet is open, so an unopened image review
    // fetches nothing either.
    for (const path of SHEET_SCREENS) {
      const s = read(path)
      assert.ok(
        s.includes("reading?.review_type === 'image' ? reading.image_group_id : null,"),
        `${path} may load project images for a text review`,
      )
    }
    const hook = read(PROJECT_IMAGES)
    assert.ok(hook.includes('if (!groupId) return NO_PROJECT_IMAGES'))
    assert.ok(hook.includes('if (target === null) return'), 'the effect fetches for a null group')
  })

  test('a group that is missing, empty or archived says so instead of degrading', () => {
    // No silent text-only fallback: the same waiting panel the detail screen
    // shows renders inside the sheet, because it is the same component.
    const s = read(PROJECT_IMAGES)
    assert.ok(s.includes('{AWAITING_IMAGES_LABEL}'))
    assert.ok(s.includes('usable: group !== null && group.archived_at === null && images.length > 0'))
  })

  test('the wait is tile-shaped, so the review text is never pushed about', () => {
    const s = read(PROJECT_IMAGES)
    assert.ok(s.includes('if (set.loading) return <ImageGridSkeleton />'))
    const skeletons = read('src/components/customerReviews/ReviewSkeletons.tsx')
    assert.ok(skeletons.includes('export function ImageGridSkeleton'))
    // Same tracks as the real grid, or the layout jumps anyway.
    const tracks = "gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))'"
    assert.ok(skeletons.includes(tracks) && s.includes(tracks))
  })

  test('there is still exactly one signed-URL path in the module', () => {
    // createSignedUrls for the project bucket belongs to ProjectImages alone.
    const offenders = [FULL_VIEW, ...SHEET_SCREENS]
      .filter(p => read(p).includes('createSignedUrls'))
    assert.deepEqual(offenders, [], 'a second signed-URL implementation appeared')
  })
})


/**
 * AND WHAT IT SAYS ABOUT THAT REVIEW WHILE IT SHOWS THEM.
 *
 * The badge, the panel and the Book button are three statements about one fact,
 * and before this they could disagree: `Image · Ready` beside a panel reading
 * `Waiting for admin images`, with an enabled button the database was always
 * going to refuse. All three now read the same two values — projectGroupUsable()
 * and the loading flag — so a disagreement is not something to be spotted in
 * review, it is unrepresentable.
 *
 * THE DATABASE RULE IS UNTOUCHED and remains the only authority. Everything
 * below is about not INVITING a refusal the browser can already see coming; a
 * stale or racing screen is still rejected by the conditional UPDATE.
 */
describe('and the sheet states one readiness, not three', () => {
  const IMAGE = {
    id: 'c1',
    status: 'available',
    card_ref: 'CR-0001',
    test_category: 'quality',
    test_title: 'A title',
    test_body: 'A body',
    review_type: 'image',
    assigned_to: 'me',
    image_group_id: 'g1',
    deleted_at: null,
  } as unknown as TestCard

  const TEXT = { ...IMAGE, review_type: 'text', image_group_id: null } as TestCard
  const viewer = { userId: 'me', canUse: true }

  /** Exactly what the sheet computes: the badge's label, and the action. */
  const sheet = (card: TestCard, set: { usable: boolean | undefined; loading: boolean }) => {
    const usable = projectGroupUsable(card, set)
    const checking = card.review_type === 'image' && !!card.image_group_id && set.loading
    return {
      badge: checking ? CHECKING_IMAGES_LABEL : readinessLabel(imageReadiness(card, usable)),
      canBook: !set.loading && canBookCard(card, viewer, usable),
    }
  }

  const LOADED = (usable: boolean | undefined) => ({ usable, loading: false })
  const LOADING = { usable: undefined, loading: true }

  test('A. a usable group — Ready, and bookable when everything else passes', () => {
    assert.deepEqual(sheet(IMAGE, LOADED(true)), { badge: READY_LABEL, canBook: true })
  })

  test('A2. …and every other booking condition still governs', () => {
    // A usable group does not make a review bookable — it only stops being the
    // reason it is not. Ownership, status and the Use permission are unchanged.
    const usable = LOADED(true)
    assert.equal(sheet({ ...IMAGE, assigned_to: 'someone-else' }, usable).canBook, false)
    assert.equal(sheet({ ...IMAGE, status: 'booked' } as TestCard, usable).canBook, false)
    assert.equal(sheet({ ...IMAGE, deleted_at: 'x' } as unknown as TestCard, usable).canBook, false)
    assert.equal(canBookCard(IMAGE, { userId: 'me', canUse: false }, true), false)
  })

  test('B. an empty group — Waiting for admin images, not bookable', () => {
    // useProjectImages answers `false` for a group holding no live image.
    assert.deepEqual(sheet(IMAGE, LOADED(false)), { badge: AWAITING_IMAGES_LABEL, canBook: false })
  })

  test('C. an archived group — the same answer, by the same route', () => {
    // Archived and empty are one value by the time they reach the sheet, which
    // is why the hook's own expression has to carry both conditions.
    assert.deepEqual(sheet(IMAGE, LOADED(false)), { badge: AWAITING_IMAGES_LABEL, canBook: false })
    assert.ok(
      read(PROJECT_IMAGES).includes(
        'usable: group !== null && group.archived_at === null && images.length > 0',
      ),
      'archived and empty no longer both resolve to unusable',
    )
    // And an archived group that still HOLDS pictures is not drawn as a gallery,
    // or the panel would contradict the badge beside it.
    assert.ok(read(PROJECT_IMAGES).includes('if (set.images.length === 0 || set.usable === false) {'))
  })

  test('D. no group at all — Waiting for admin images, not bookable', () => {
    const noGroup = { ...IMAGE, image_group_id: null } as TestCard
    assert.deepEqual(sheet(noGroup, LOADED(undefined)), { badge: AWAITING_IMAGES_LABEL, canBook: false })
    // Nothing is being read, so nothing claims to be checking.
    assert.equal(sheet(noGroup, LOADING).badge, AWAITING_IMAGES_LABEL)
  })

  test('E. while the group is being read — neither Ready nor bookable', () => {
    // The flicker this prevents is Ready → Waiting → Ready. A neutral badge
    // makes one transition, to whatever the truth turns out to be.
    assert.deepEqual(sheet(IMAGE, LOADING), { badge: CHECKING_IMAGES_LABEL, canBook: false })
    assert.equal(projectGroupUsable(IMAGE, LOADING), undefined)
  })

  test('E2. a read that failed fails closed rather than claiming Ready', () => {
    // useProjectImages returns `undefined` for a failed read and the panel shows
    // its waiting state; the badge and the button say the same thing.
    assert.deepEqual(sheet(IMAGE, LOADED(undefined)), { badge: AWAITING_IMAGES_LABEL, canBook: false })
  })

  test('F. a text review depends on none of it', () => {
    // Every image-readiness input is inert for a text review: the helper refuses
    // to answer, and canBookCard is unmoved even when told the group is unusable.
    assert.equal(projectGroupUsable(TEXT, LOADED(false)), undefined)
    assert.equal(projectGroupUsable(TEXT, LOADING), undefined)
    assert.equal(readinessLabel(imageReadiness(TEXT, false)), null, 'a text review grew a readiness badge')
    assert.equal(canBookCard(TEXT, viewer, false), true)
    assert.deepEqual(sheet(TEXT, LOADED(undefined)), { badge: null, canBook: true })
  })

  test('G. the booking SQL is untouched — the browser only stops inviting a refusal', () => {
    // The migration is the authority. If this UI check were ever mistaken for
    // the rule, these three clauses would be the thing quietly removed.
    const sql = read('supabase/migrations/20261107000000_review_types_assignment_and_image_groups.sql')
    assert.ok(sql.includes('and c2.assigned_to = v_uid'))
    assert.ok(sql.includes("c2.review_type <> 'image'"))
    assert.ok(sql.includes('and i.removal_started_at is null'))
    assert.ok(sql.includes('and g.archived_at is null'))
  })

  test('and both sheets compute exactly the pair asserted above', () => {
    // These tests describe a composition; this is what pins the screens to it.
    for (const path of SHEET_SCREENS) {
      const s = read(path)
      assert.ok(s.includes('const readingCanBook = !!reading\n    && !readingImages.loading\n    && canBookCard('),
        `${path} does not gate Book on the loaded group`)
      assert.ok(s.includes('projectGroupUsable(reading, readingImages),'))
      // One answer, used by the button and by the sentence explaining its absence.
      assert.equal((s.match(/canBook=\{readingCanBook\}/g) ?? []).length, 2)
      assert.equal(s.includes('canBook={canBookCard('), false, `${path} still has a second booking answer`)
    }
    const full = read(FULL_VIEW)
    assert.ok(full.includes('<ReadinessBadge card={card} groupHasImages={groupUsable} pending={checkingImages} />'))
    assert.ok(full.includes("imageReadiness(card, groupUsable) === 'awaiting_images'"))
    assert.ok(full.includes('const groupUsable = projectGroupUsable(card, projectImages)'))
  })
})
