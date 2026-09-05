/**
 * SHARING AN APPROVED REVIEW, AND THE THINGS THAT MUST NOT BE TRUE OF IT.
 *
 * The feature is one button. What it must never become is the thing the
 * workflow spent three migrations avoiding, so most of this file is negative:
 *
 *   1. A PENDING DRAFT IS NEVER SHARED. Not by a disabled control somebody
 *      could enable, not by a direct call — the gate is asked at render AND
 *      again at the moment of action.
 *
 *   2. NOTHING IS SENT, AND NOTHING CLAIMS TO BE. There is no WhatsApp Business
 *      API, no Meta credential, no template, no token and no outbound request.
 *      `navigator.share` opens the operating system's sheet; a person picks the
 *      app, the recipient, and presses send. No string in the component says a
 *      message was sent, because nothing here can know that.
 *
 *   3. `canShare` IS ASKED BEFORE `share`. A browser that has `share` but
 *      cannot take these files does not degrade on its own — it rejects,
 *      sometimes after the sheet has flickered open.
 *
 *   4. THE FALLBACK DOES NOT SILENTLY DROP THE IMAGES. Falling back to a
 *      text-only share when files were wanted would send a review about
 *      furniture without the pictures, and the sender would never know. The
 *      capability check reports 'none' in that case on purpose.
 *
 *   5. THE EXISTING TEXT-ONLY WHATSAPP WORKFLOW IS UNTOUCHED.
 *
 * Pure functions and repository files. No DOM, no network, no share sheet.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/reviewSharing.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MANUAL_ATTACH_INSTRUCTION,
  downloadFileName,
  isShareableReview,
  shareCapability,
  type ShareCapableNavigator,
} from './sharing'
import type { TestCardStatus } from './types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/**
 * The source with EVERY comment removed, block comments included.
 *
 * The line-prefix filter the other files in this module use is not enough here.
 * This component's whole argument is made in prose — a JSDoc saying the state
 * is "opened, NOT sent", a JSX comment explaining why — and a sweep for the
 * word "sent" that only stripped `//` lines would fail on the very sentences
 * that promise the thing being asserted. Block comments go first, then line
 * comments, and what is left is what actually runs.
 */
const executable = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trimStart().startsWith('//'))
    .join('\n')

const SHARE = read('src/components/customerReviews/ShareReview.tsx')
const SHARE_CODE = executable(SHARE)

/** A stand-in for a File, which node's test runner has no reason to construct. */
const fakeFile = (name: string) => ({ name }) as unknown as File

const payload = (files: File[] = []) => ({
  title: 'A steady supplier',
  text: 'We ordered seating and the fit was right first time.',
  files,
})

// ══ 1. WHAT MAY BE SHARED ═══════════════════════════════════════════════════

describe('only an approved review leaves the building', () => {
  const card = (over: Partial<{ status: TestCardStatus; approved_at: string | null; deleted_at: string | null }> = {}) => ({
    status: 'available' as TestCardStatus,
    approved_at: '2026-09-01T00:00:00Z',
    deleted_at: null,
    ...over,
  })

  test('A PENDING DRAFT IS NEVER SHAREABLE', () => {
    // The single most important assertion in this file.
    assert.equal(isShareableReview(card({ status: 'pending_approval', approved_at: null })), false)
  })

  test('not even one that somehow carries an approval stamp', () => {
    // The status and the stamp agree — a CHECK enforces it — and both are asked
    // anyway. A row that held one without the other is refused rather than
    // trusted, because the cheap question guards the irreversible one.
    assert.equal(isShareableReview(card({ status: 'pending_approval' })), false)
  })

  test('and not one that is approved by status but has no stamp', () => {
    assert.equal(isShareableReview(card({ status: 'available', approved_at: null })), false)
  })

  test('every state a review reached BY being approved is shareable', () => {
    for (const status of ['available', 'booked', 'submitted', 'verified'] as TestCardStatus[]) {
      assert.equal(isShareableReview(card({ status })), true, `${status} was refused`)
    }
  })

  test('a deleted review is not shareable, whatever its status says', () => {
    assert.equal(isShareableReview(card({ deleted_at: '2026-09-01T00:00:00Z' })), false)
    assert.equal(isShareableReview(card({ status: 'booked', deleted_at: '2026-09-01T00:00:00Z' })), false)
  })

  test('the component asks the gate at render AND at the moment of action', () => {
    // Rendering is not enough on its own: the row may have been refreshed
    // between the button being drawn and the button being pressed.
    // The gate now carries the group's usability as its second argument, so an
    // image review whose project is missing, archived or empty is refused by
    // the same function that refuses a pending draft.
    const asks = SHARE_CODE.split('isShareableReview(card, groupUsable)').length - 1
    assert.equal(asks, 2, 'the gate is asked once, not twice')
    assert.ok(SHARE_CODE.includes('if (!shareable) return null'))
  })

  test('and it renders NOTHING rather than a disabled control', () => {
    // A disabled button is a thing somebody tries to enable. There is no
    // control at all for a review that may not be shared.
    assert.ok(SHARE_CODE.includes('if (!shareable) return null'))
    assert.equal(/disabled=\{!shareable\}/.test(SHARE_CODE), false)
  })
})

// ══ 2. CAPABILITY IS ASKED, NOT ASSUMED ═════════════════════════════════════

describe('canShare before share', () => {
  test('no Web Share API at all is `none` — the desktop case', () => {
    assert.deepEqual(shareCapability(undefined, payload()), { kind: 'none' })
    assert.deepEqual(shareCapability({}, payload()), { kind: 'none' })
    assert.deepEqual(shareCapability({ canShare: () => true }, payload()), { kind: 'none' })
  })

  test('files supported is `files`', () => {
    const nav: ShareCapableNavigator = { share: async () => {}, canShare: () => true }
    assert.deepEqual(shareCapability(nav, payload([fakeFile('a.jpg')])), { kind: 'files' })
  })

  test('canShare IS CONSULTED WITH THE ACTUAL FILES', () => {
    // Support depends on the types and the count — a browser may accept one
    // JPEG and refuse four — so a probe would answer a question we are not
    // going to ask.
    const seen: unknown[] = []
    const nav: ShareCapableNavigator = {
      share: async () => {},
      canShare: (data) => { seen.push(data); return true },
    }
    const files = [fakeFile('a.jpg'), fakeFile('b.jpg')]
    shareCapability(nav, payload(files))
    assert.equal(seen.length, 1)
    const asked = seen[0] as { title: string; text: string; files: File[] }
    assert.equal(asked.files.length, 2)
    assert.equal(asked.title, 'A steady supplier')
    assert.ok(asked.text.length > 0)
  })

  test('a browser with share but no canShare cannot be trusted with files', () => {
    // Without canShare there is no way to ask, and calling share({files}) to
    // find out is how a sheet flickers open and then rejects.
    const nav: ShareCapableNavigator = { share: async () => {} }
    assert.deepEqual(shareCapability(nav, payload([fakeFile('a.jpg')])), { kind: 'none' })
  })

  test('THE FALLBACK DOES NOT SILENTLY DROP THE IMAGES', () => {
    // The assertion this design decision exists for. Files were wanted and
    // cannot go, so the answer is the download fallback — NOT a text-only
    // share, which would send a review about furniture without the pictures of
    // it and tell nobody.
    const nav: ShareCapableNavigator = { share: async () => {}, canShare: () => false }
    assert.deepEqual(shareCapability(nav, payload([fakeFile('a.jpg')])), { kind: 'none' })
  })

  test('with no files, a plain text share is still the better path', () => {
    const nav: ShareCapableNavigator = { share: async () => {}, canShare: () => true }
    assert.deepEqual(shareCapability(nav, payload([])), { kind: 'text' })
  })

  test('unless the browser refuses even that', () => {
    const nav: ShareCapableNavigator = { share: async () => {}, canShare: () => false }
    assert.deepEqual(shareCapability(nav, payload([])), { kind: 'none' })
  })

  test('the component consults the capability before it calls share', () => {
    const capability = SHARE_CODE.indexOf('shareCapability(')
    const share = SHARE_CODE.indexOf('await navigator.share(')
    assert.ok(capability >= 0 && share >= 0)
    assert.ok(capability < share, 'share is called before the capability is known')
  })

  test('and it passes files only when the answer was `files`', () => {
    assert.ok(SHARE_CODE.includes("capability.kind === 'files' ? { title, text, files } : { title, text }"))
  })
})

// ══ 3. THE DESKTOP FALLBACK ═════════════════════════════════════════════════

describe('the fallback', () => {
  test('it copies the text and downloads the images', () => {
    assert.ok(SHARE_CODE.includes('navigator.clipboard?.writeText'))
    assert.ok(SHARE_CODE.includes("anchor.download = file.name"))
    assert.ok(SHARE_CODE.includes('URL.createObjectURL(file)'))
  })

  test('it tells the person what to do next, in one sentence', () => {
    assert.ok(MANUAL_ATTACH_INSTRUCTION.includes('clipboard'))
    assert.ok(MANUAL_ATTACH_INSTRUCTION.includes('WhatsApp'))
    assert.ok(MANUAL_ATTACH_INSTRUCTION.includes('attach'))
    assert.ok(SHARE_CODE.includes('MANUAL_ATTACH_INSTRUCTION'))
  })

  test('THE INSTRUCTION DESCRIBES WHAT THE PERSON DOES, not what the app did', () => {
    assert.equal(/\bwe sent\b|\bhas been sent\b|\bmessage sent\b/i.test(MANUAL_ATTACH_INSTRUCTION), false)
  })

  test('a clipboard failure does not cost the person their images', () => {
    // The two halves are attempted independently. A clipboard refused by
    // permission policy is not a reason to skip the downloads.
    const copy = SHARE_CODE.indexOf('navigator.clipboard?.writeText')
    const loop = SHARE_CODE.indexOf('for (const file of files)')
    assert.ok(copy < loop)
    assert.ok(SHARE_CODE.slice(copy, loop).includes('catch'))
  })

  test('the download filenames are generated, never the uploader’s', () => {
    // The stored filename is display-only and has never been trusted to be
    // path-safe. The reference and the position are enough to keep four files
    // distinguishable in one Downloads folder.
    assert.equal(downloadFileName('RW-000101', 0, 'image/jpeg'), 'RW-000101-1.jpg')
    assert.equal(downloadFileName('RW-000101', 3, 'image/png'), 'RW-000101-4.png')
    assert.equal(downloadFileName('RW-000101', 1, 'image/webp'), 'RW-000101-2.webp')
  })

  test('and a hostile reference cannot become a path', () => {
    assert.equal(downloadFileName('../../etc/passwd', 0, 'image/jpeg'), 'etcpasswd-1.jpg')
    assert.equal(downloadFileName('', 0, 'image/jpeg'), 'review-1.jpg')
    assert.equal(downloadFileName('a/b\\c', 0, 'image/jpeg'), 'abc-1.jpg')
  })

  test('a dismissed sheet is not reported as a failure', () => {
    // Closing the share sheet rejects with AbortError. Reporting that as an
    // error tells somebody their deliberate choice went wrong.
    assert.ok(SHARE_CODE.includes("err.name === 'AbortError'"))
    assert.ok(SHARE_CODE.includes("setState({ kind: 'idle' })"))
  })
})

// ══ 4. NOTHING IS SENT, AND NOTHING SAYS IT WAS ═════════════════════════════

describe('what sharing is not', () => {
  test('NO WHATSAPP BUSINESS API, no credential, no template', () => {
    assert.equal(/graph\.facebook\.com|business\.whatsapp|WHATSAPP_TOKEN|META_|phone_number_id|messaging_product/i.test(SHARE), false)
  })

  test('and no outbound request except fetching the images it is about to share', () => {
    // The only fetch is the signed URL for an object this viewer may already
    // read. Nothing is posted anywhere.
    const fetches = SHARE_CODE.match(/fetch\([^)]*/g) ?? []
    assert.equal(fetches.length, 1, `unexpected fetches: ${fetches.join(' | ')}`)
    assert.ok(fetches[0].includes('signed'))
    assert.equal(/method:\s*['"]POST['"]/.test(SHARE_CODE), false)
  })

  test('NO STATE CLAIMS A MESSAGE WAS SENT', () => {
    // The state after a successful share is `opened`, not `sent`, because a
    // share sheet opening is all this code can observe.
    assert.equal(/\bkind: 'sent'\b/.test(SHARE_CODE), false)
    assert.equal(/\bsent\b/i.test(SHARE_CODE.replace(/press send yourself/g, '')), false,
      'a string in the component claims something was sent')
  })

  test('and the success copy says the sheet opened and the person sends', () => {
    assert.ok(SHARE.includes('Your share sheet was opened'))
    assert.ok(SHARE.includes('press send yourself'))
    assert.ok(SHARE.includes('BOE does not send anything for you'))
  })

  test('no automatic send: sharing happens on a press, never on render', () => {
    // `run` is bound to onClick and to nothing else. No effect calls it.
    assert.ok(SHARE_CODE.includes('onClick={run}'))
    assert.equal(/useEffect\([^)]*run/.test(SHARE_CODE), false)
    assert.equal(SHARE_CODE.includes('useEffect'), false, 'the share component has an effect')
  })

  test('the module still has no message-delivery route', () => {
    const whatsapp = read('src/app/api/customer-reviews/whatsapp/route.ts')
    assert.equal(/graph\.facebook\.com|messaging_product/i.test(whatsapp), false)
  })
})

// ══ 5. THE EXISTING TEXT-ONLY WORKFLOW IS UNTOUCHED ═════════════════════════

describe('the wa.me workflow still works for a review with no images', () => {
  test('WhatsAppLaunch is unchanged and still asks the server for the link', () => {
    const launch = read('src/components/customerReviews/WhatsAppLaunch.tsx')
    assert.ok(launch.includes("fetch('/api/customer-reviews/whatsapp'"))
    assert.ok(launch.includes('RECIPIENT_CONFIRMATION'))
    // The share component did not take it over.
    assert.equal(SHARE_CODE.includes('wa.me'), false)
    assert.equal(SHARE_CODE.includes('/api/customer-reviews/whatsapp'), false)
  })

  test('the server is still the only builder of a wa.me link', () => {
    const route = read('src/app/api/customer-reviews/whatsapp/route.ts')
    assert.ok(route.includes('buildWaMeUrl'))
    for (const source of [SHARE, read('src/components/customerReviews/ReviewImageManager.tsx')]) {
      assert.equal(/wa\.me|buildWaMeUrl/.test(executable(source)), false)
    }
  })

  test('and sharing uses the SAME single message builder', () => {
    // buildReviewMessage carries the draft and nothing else — no label, no
    // reference, no category. Sharing must not invent a second wording.
    assert.ok(SHARE_CODE.includes('buildReviewMessage({'))
    assert.equal(/text\s*=\s*`/.test(SHARE_CODE), false, 'the share text is assembled by hand')
  })

  test('a review with no images shares its text and says so', () => {
    assert.ok(SHARE.includes("'The review text.'"))
  })
})
