/**
 * 20261123000000_review_native_share_records_the_open.sql — the native-share
 * equivalent of record_customer_review_test_card_whatsapp_opened(), asserted
 * function by function, the way securityContract.test.ts audits the original
 * migration.
 *
 * WHAT THIS FILE PROVES, and what it deliberately does not:
 *
 *   * the new RPC enforces the SAME rules the phone-number one does — holder,
 *     active, booked, not deleted — so recording a share cannot be aimed at
 *     somebody else's card or a card in the wrong state;
 *   * it takes NO actor parameter, unlike the phone-number RPC, and is safely
 *     granted straight to `authenticated` because of that — the same shape
 *     confirm_customer_review_test_card_sent() already uses;
 *   * it writes whatsapp_opened_at and the counter, and NOTHING else — no
 *     status, no whatsapp_target_last_four;
 *   * ShareReview.tsx calls it only after a real hand-off (a native share
 *     that returned normally, or the manual fallback completing), never after
 *     a cancelled or failed share;
 *   * a real employee's Full Review screen no longer needs the phone-number
 *     panel to reach Confirm Sent.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/shareOpened.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = 'supabase/migrations/20261123000000_review_native_share_records_the_open.sql'
const sql = read(MIGRATION)
/** Executable SQL only — comments explain, they do not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const FN = 'record_customer_review_test_card_share_opened'

/** The one function's body, so a claim about it cannot be satisfied elsewhere. */
function body(): string {
  const start = code.indexOf(`create or replace function public.${FN}(`)
  assert.ok(start >= 0, `${FN} is not defined`)
  const open = code.indexOf('$$', start)
  const close = code.indexOf('$$', open + 2)
  return code.slice(start, close + 2)
}

const FN_BODY = body()

// ══ 1. THE SIGNATURE, AND WHY IT HAS NO ACTOR PARAMETER ═════════════════════

describe('the signature takes no actor id, unlike the phone-number RPC', () => {
  test('the only parameter is the card', () => {
    const sig = /create or replace function public\.record_customer_review_test_card_share_opened\(([^)]*)\)/
      .exec(code)
    assert.ok(sig)
    assert.equal(sig![1].replace(/\s+/g, ' ').trim(), 'p_card_id uuid')
  })

  test('the actor comes from auth.uid(), the safer shape confirm_sent already uses', () => {
    assert.ok(FN_BODY.includes('auth.uid()'))
    assert.equal(/p_actor_id/.test(FN_BODY), false, 'a caller-suppliable actor id would need service-role gating')
  })

  test('signed out is refused before any row is touched', () => {
    assert.ok(FN_BODY.includes('v_uid is null'))
    const uidCheck = FN_BODY.indexOf('v_uid is null')
    const select = FN_BODY.indexOf('select * into c')
    assert.ok(uidCheck < select, 'the row is read before the signed-in check')
  })
})

// ══ 2. THE SAME AUTHORIZATION THE PHONE-NUMBER RPC ENFORCES ═════════════════

describe('every rule the phone-number RPC enforces, enforced here too', () => {
  test('deleted is refused', () => {
    assert.ok(FN_BODY.includes('c.deleted_at is not null'))
  })

  test('only the holder, and only while active — no role bypass', () => {
    assert.ok(FN_BODY.includes('c.booked_by = v_uid'))
    assert.ok(FN_BODY.includes("resolve_permission(v_uid, 'customer_review_requests', 'use')"))
    assert.ok(FN_BODY.includes('u.is_active'))
    assert.equal(/u\.role|users\.role|'admin'/i.test(FN_BODY), false, 'a role bypass is present')
  })

  test('only a booked card accepts a recorded share', () => {
    assert.ok(FN_BODY.includes("c.status <> 'booked'"))
  })
})

// ══ 3. WHAT IT WRITES, AND WHAT IT DOES NOT ═════════════════════════════════

describe('it writes the same two columns the phone-number RPC writes, and nothing else', () => {
  test('whatsapp_opened_at and the counter', () => {
    assert.ok(FN_BODY.includes('whatsapp_opened_at    = now()') || FN_BODY.includes('whatsapp_opened_at = now()'))
    assert.ok(FN_BODY.includes('whatsapp_opened_count = whatsapp_opened_count + 1'))
  })

  test('NOT whatsapp_target_last_four — there is no number to mask', () => {
    const updateStart = FN_BODY.indexOf('update public.customer_review_test_cards')
    const updateEnd = FN_BODY.indexOf(';', updateStart)
    assert.equal(FN_BODY.slice(updateStart, updateEnd).includes('whatsapp_target_last_four'), false)
  })

  test('no status is ever assigned', () => {
    const updateStart = FN_BODY.indexOf('update public.customer_review_test_cards')
    const updateEnd = FN_BODY.indexOf(';', updateStart)
    assert.equal(/set\s+status/.test(FN_BODY.slice(updateStart, updateEnd)), false)
  })

  test('an event is logged, reusing the existing whatsapp_opened event_type', () => {
    // customer_review_test_card_events.event_type already permits this value
    // (20261017000000) — reused with different detail text, not widened.
    assert.ok(FN_BODY.includes("'whatsapp_opened'"))
    assert.ok(/native share/i.test(FN_BODY))
  })
})

// ══ 4. GRANTS: SAFE TO CALL DIRECTLY, UNLIKE THE PHONE-NUMBER RPC ═══════════

describe('grants: authenticated may call it directly', () => {
  test('revoked from public and anon', () => {
    assert.ok(new RegExp(
      `revoke execute on function public\\.${FN}\\(uuid\\)\\s*\\n?\\s*from public, anon`,
    ).test(code))
  })

  test('granted to authenticated — not service_role, unlike the phone-number RPC', () => {
    assert.ok(new RegExp(`grant\\s+execute on function public\\.${FN}\\(uuid\\) to authenticated`).test(code))
    assert.equal(new RegExp(`grant\\s+execute on function public\\.${FN}\\(uuid\\) to service_role`).test(code), false)
  })
})

// ══ 5. THE CLIENT SIDE: WHEN IT IS CALLED, AND WHEN IT IS NOT ═══════════════

describe('ShareReview.tsx calls it only after a real hand-off', () => {
  const executable = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//'))
      .join('\n')

  const SHARE = read('src/components/customerReviews/ShareReview.tsx')
  const SHARE_CODE = executable(SHARE)

  test('the RPC is called by name, through supabase.rpc — not a new fetch', () => {
    assert.ok(SHARE_CODE.includes("supabase.rpc('record_customer_review_test_card_share_opened'"))
  })

  test('called after a successful native share', () => {
    const shareCall = SHARE_CODE.indexOf('await navigator.share(')
    const openedState = SHARE_CODE.indexOf("setState({ kind: 'opened' })")
    const record = SHARE_CODE.indexOf('await recordShareOpened(')
    assert.ok(shareCall >= 0 && openedState > shareCall && record > openedState)
  })

  test('NOT called when the user cancels the share sheet', () => {
    // The AbortError branch returns immediately after setting `idle` — no
    // record call appears between the AbortError check and that return.
    const abortCheck = SHARE_CODE.indexOf("err.name === 'AbortError'")
    const abortBlock = SHARE_CODE.slice(abortCheck, SHARE_CODE.indexOf('return', abortCheck) + 6)
    assert.equal(abortBlock.includes('recordShareOpened'), false)
  })

  test('called after the manual fallback completes too', () => {
    const download = SHARE_CODE.indexOf('await copyAndDownload(')
    const manualState = SHARE_CODE.indexOf("setState({ kind: 'manual' })")
    const record = SHARE_CODE.lastIndexOf('await recordShareOpened(')
    assert.ok(download >= 0 && manualState > download && record > manualState)
  })

  test('a failed record does not surface as a share failure', () => {
    // The share already happened from the candidate's point of view; a
    // failure recording it is swallowed, not shown as an error about sharing.
    const fn = SHARE_CODE.slice(SHARE_CODE.indexOf('async function recordShareOpened'))
    assert.ok(fn.includes('catch'))
  })

  test('onShared fires only when the record succeeds', () => {
    const fn = SHARE_CODE.slice(
      SHARE_CODE.indexOf('async function recordShareOpened'),
      SHARE_CODE.indexOf('async function recordShareOpened') + 600,
    )
    assert.ok(fn.includes('if (!error) onShared'))
  })
})

// ══ 6. THE EMPLOYEE SCREEN: ONE PATH, NOT TWO ════════════════════════════════

describe('a real employee no longer needs the phone-number panel to reach Confirm Sent', () => {
  const DETAIL = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')

  test('ShareReviewButton is wired to reload the card on a real hand-off', () => {
    assert.ok(DETAIL.includes('onShared={load}'))
  })

  test('the phone-number panel is gated behind caps.canVerify, not shown to every holder', () => {
    const section = DETAIL.slice(
      DETAIL.indexOf('title="Confirm you sent it"'),
      DETAIL.indexOf('title="Confirm you sent it"') + 1800,
    )
    const verifyGate = section.indexOf('caps.canVerify')
    const panel = section.indexOf('<WhatsAppTestPanel')
    assert.ok(verifyGate >= 0 && panel > verifyGate, 'WhatsAppTestPanel is not gated behind caps.canVerify')
  })

  test('ConfirmSentControl itself is unconditional — every holder can confirm once opened', () => {
    const section = DETAIL.slice(
      DETAIL.indexOf('title="Confirm you sent it"'),
      DETAIL.indexOf('title="Confirm you sent it"') + 1800,
    )
    assert.ok(section.includes('<ConfirmSentControl'))
    assert.ok(section.includes('canConfirm={!!card.whatsapp_opened_at}'))
  })
})
