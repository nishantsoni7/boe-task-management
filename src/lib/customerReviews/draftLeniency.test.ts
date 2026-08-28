/**
 * A DRAFT MAY BE INCOMPLETE. Ready to Send may not.
 *
 * The two rules pull in opposite directions and both matter: an employee half
 * way through collecting a customer's details must be able to save and come
 * back, and an invitation about to reach a real person must be complete. This
 * file pins the line between them in all four places it is drawn — the column
 * nullability, the shared blocker list, the form's save path, and the database
 * functions that guard Ready to Send and Open WhatsApp — so the four cannot
 * drift apart.
 *
 * THE ONE SUBTLETY: an optional field may be EMPTY, but a value that is present
 * must be valid. A blank review destination is a draft in progress; "javascript:
 * alert(1)" is not, and saving it would store a redirect for everyone who opens
 * the record later.
 *
 * Fictional data only. Reads repository files and pure functions.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/draftLeniency.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readyToSendBlockers } from './status'
import { normalizeWhatsAppNumber } from './contact'
import { parseReviewDestination } from './destination'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const sql = read('supabase/migrations/20261017000000_customer_review_outreach.sql')
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const form = read('src/components/customerReviews/RequestForm.tsx')

/** A draft with only the one thing a draft cannot do without. */
const bareDraft: Parameters<typeof readyToSendBlockers>[0] = {
  genuine_customer_confirmed: false,
  customer_name: 'Riverside Café',
  whatsapp_number: null,
  interaction_type: null,
  review_url: null,
  image_permission_confirmed: false,
  greeting_name: null,
  project_reference: null,
}

// ── 1. The columns permit an incomplete draft ───────────────────────────────

describe('the schema lets a draft be incomplete', () => {
  test('the WhatsApp number is nullable', () => {
    assert.ok(code.includes('whatsapp_number text check ('))
    assert.ok(code.includes('whatsapp_number is null'))
    assert.equal(/whatsapp_number text not null/.test(code), false)
  })

  test('the interaction type is nullable', () => {
    assert.ok(code.includes('interaction_type text check (interaction_type is null or'))
  })

  test('the review destination is nullable', () => {
    assert.ok(code.includes('review_url text check (\n    review_url is null or'))
  })

  test('both confirmations default to false rather than being required', () => {
    assert.ok(code.includes('genuine_customer_confirmed boolean not null default false'))
    assert.ok(code.includes('image_permission_confirmed boolean not null default false'))
  })

  test('the customer name is the ONE required field, per BOE list conventions', () => {
    // Every list and every audit row identifies a request by this, so a row
    // without one would be unreadable everywhere it appears.
    assert.ok(code.includes("customer_name text not null check (btrim(customer_name) <> ''"))
  })

  test('a photograph is not required to exist for a draft to exist', () => {
    // The requirement lives in assert_customer_review_ready(), which only runs
    // on the way to Ready to Send — never on an ordinary save.
    assert.equal(/create table[\s\S]*?photo_count/.test(code), false)
    assert.ok(code.includes('if v_photos = 0 then'))
  })
})

// ── 2. The blockers are a Ready-to-Send rule, not a save rule ───────────────

describe('what the shared rule says about a bare draft', () => {
  test('it lists everything still missing, and refuses none of it as a save', () => {
    const blockers = readyToSendBlockers(bareDraft, 0)
    assert.equal(blockers.length, 5)
    for (const fragment of [
      'genuine BOE customer', 'valid WhatsApp number', 'interaction type',
      'review destination', 'at least one real photograph',
    ]) {
      assert.ok(blockers.some(b => b.includes(fragment)), fragment)
    }
  })

  test('the sharing confirmation is not demanded while there is no photograph', () => {
    // It IS demanded at Ready to Send, because a photograph is required by
    // then — but a draft with no photographs must not be nagged for permission
    // to share photographs that do not exist.
    const withoutPhotos = readyToSendBlockers(bareDraft, 0)
    assert.equal(withoutPhotos.some(b => b.includes('permission to share')), false)
  })

  test('readyToSendBlockers is never consulted on the ordinary save path', () => {
    // Save draft is `save(false)`; only `save(true)` reads the blockers.
    assert.ok(form.includes('onClick={() => save(false)}'))
    assert.ok(form.includes('if (markReady && blockers.length > 0)'))
  })
})

// ── 3. Present values are still validated ──────────────────────────────────

describe('an optional field may be empty, but not wrong', () => {
  test('a blank number and a blank destination are simply absent', () => {
    assert.ok(form.includes("draft.whatsappInput.trim() === '' ? null : normalizeWhatsAppNumber(draft.whatsappInput)"))
    assert.ok(form.includes("draft.reviewUrl.trim() === '' ? null : parseReviewDestination(draft.reviewUrl)"))
  })

  test('a supplied number that is not a number blocks the save', () => {
    assert.ok(form.includes('if (phone && !phone.ok) { setError(phone.error); return }'))
    assert.equal(normalizeWhatsAppNumber('not a phone').ok, false)
  })

  test('a supplied destination that is not safe https blocks the save', () => {
    assert.ok(form.includes('if (destination && !destination.ok) { setError(destination.error); return }'))
    for (const unsafe of ['http://example.test/r', 'javascript:alert(1)', 'example.test']) {
      assert.equal(parseReviewDestination(unsafe).ok, false, unsafe)
    }
  })

  test('AND THE DATABASE AGREES — a stored destination can only ever be https', () => {
    // The browser check protects the person typing; this one protects everyone
    // who opens the record afterwards.
    assert.ok(code.includes("review_url like 'https://%'"))
  })

  test('the customer name is required on every save, draft included', () => {
    assert.ok(form.includes("if (draft.customerName.trim() === '')"))
  })
})

// ── 4. Ready to Send, and Open WhatsApp, enforce everything ────────────────

describe('the two gates that do demand a complete request', () => {
  test('Ready to Send goes through the RPC, which re-checks in the database', () => {
    assert.ok(form.includes("supabase.rpc('transition_customer_review_request'"))
    assert.ok(form.includes("p_next_status: 'ready_to_send'"))
    assert.ok(code.includes("if p_next_status = 'ready_to_send' then"))
    assert.ok(code.includes('perform public.assert_customer_review_ready(p_request_id)'))
  })

  test('the button is dead until every blocker clears', () => {
    assert.ok(form.includes('disabled={saving || blockers.length > 0}'))
  })

  test('Open WhatsApp is unavailable unless the request is Ready to Send', () => {
    assert.ok(form.includes("const awaitingSend = request?.status === 'ready_to_send'"))
    assert.ok(form.includes('{request && awaitingSend && ('))
  })

  test('…and the database re-checks the SAVED data when it is clicked', () => {
    // The screen's belief is not the authority: a request edited in another tab,
    // or a photograph removed since, is caught here.
    const opened = code.slice(code.indexOf('create or replace function public.record_customer_review_whatsapp_opened'))
    assert.ok(opened.includes("if r.status <> 'ready_to_send' then"))
    assert.ok(opened.includes('perform public.assert_customer_review_ready(p_request_id)'))
  })

  test('the eight Ready-to-Send checks exist in the database, not only in the browser', () => {
    const ready = code.slice(
      code.indexOf('create or replace function public.assert_customer_review_ready'),
      code.indexOf('revoke execute on function public.assert_customer_review_ready'),
    )
    for (const check of [
      'r.genuine_customer_confirmed is not true',
      "btrim(coalesce(r.customer_name, '')) = ''",
      'r.whatsapp_number is null',
      'r.interaction_type is null',
      'r.review_url is null',
      'customer_review_text_steers(r.greeting_name)',
      'customer_review_text_steers(r.project_reference)',
      'if v_photos = 0 then',
      'r.image_permission_confirmed is not true',
    ]) {
      assert.ok(ready.includes(check), `assert_customer_review_ready is missing: ${check}`)
    }
  })
})
