/**
 * EDITING A DRAFT, AND THE WINDOW THAT CLOSES AT APPROVAL.
 *
 * A verifier may now type over a draft's title and body. The feature is small;
 * the thing that makes it safe is not, and it is what this file tests:
 *
 *   1. THE TEXT IS HELD TO THE SAME RULES A GENERATED DRAFT IS. Hand-typed
 *      prose is not trusted more than a model's — it is trusted less, because a
 *      person can be talked into typing something. validateDraftText is the
 *      SAME function and the SAME forbidden list validateDrafts applies.
 *
 *   2. THE WINDOW IS `pending_approval` AND NOTHING ELSE. Approved, booked,
 *      submitted, verified and deleted are all refused, in three places: the
 *      screen does not offer the control, the route checks, and the definer
 *      function locks the row and checks again. The third is the one that
 *      decides.
 *
 *   3. SAVING IS NOT APPROVING. No path from the editor reaches an approval,
 *      and the editing sheet's footer does not contain one.
 *
 *   4. AN EDITED DRAFT SAYS SO. The module labels drafts as AI-generated, and
 *      that label stops being the whole truth once a person has rewritten one.
 *
 * Reads repository files and pure functions only. No database, no network, no
 * provider call.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/draftEditing.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_BODY, MAX_TITLE, MIN_BODY, validateDraftText } from './draftGeneration'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** Comments stripped, so no claim below can be satisfied by prose. */
const executable = (source: string) =>
  source
    .split('\n')
    .filter(l => !l.trimStart().startsWith('--') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')

const MIGRATION = read('supabase/migrations/20261031000000_review_workflow_twelve_drafts_editing_and_images.sql')
const SQL = executable(MIGRATION)
const ROUTE = read('src/app/api/customer-reviews/draft/route.ts')
const EDITOR = read('src/components/customerReviews/EditDraft.tsx')
const PENDING = read('src/components/customerReviews/PendingBatches.tsx')

/** The body of one plpgsql function, so a claim about it cannot match elsewhere. */
function fn(name: string): string {
  const at = SQL.indexOf(`create or replace function public.${name}(`)
  assert.ok(at >= 0, `${name} is not defined in the migration`)
  const end = SQL.indexOf('\n$$;', at)
  assert.ok(end > at, `${name} has no terminator`)
  return SQL.slice(at, end)
}

const GOOD_BODY =
  'We ordered seating for a small dining room and the fit was right first time. ' +
  'The finish has held up through two winters of full service.'

// ══ 1. THE TEXT IS VALIDATED LIKE ANY OTHER DRAFT ═══════════════════════════

describe('hand-typed text is held to the generated rules', () => {
  test('a good title and body pass, trimmed', () => {
    const result = validateDraftText('  A steady supplier  ', `  ${GOOD_BODY}  `)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.title, 'A steady supplier')
      assert.equal(result.body, GOOD_BODY)
    }
  })

  test('an empty title or body is refused, and whitespace is empty', () => {
    for (const [title, body] of [
      ['', GOOD_BODY],
      ['   ', GOOD_BODY],
      ['A title', ''],
      ['A title', '      '],
    ] as const) {
      assert.equal(validateDraftText(title, body).ok, false, `"${title}" / "${body}" was accepted`)
    }
  })

  test('a non-string is refused rather than coerced', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      assert.equal(validateDraftText(value, GOOD_BODY).ok, false)
      assert.equal(validateDraftText('A title', value).ok, false)
    }
  })

  test('the length bounds are the column bounds', () => {
    assert.equal(validateDraftText('x'.repeat(MAX_TITLE), GOOD_BODY).ok, true)
    assert.equal(validateDraftText('x'.repeat(MAX_TITLE + 1), GOOD_BODY).ok, false)
    assert.equal(validateDraftText('A title', 'y'.repeat(MAX_BODY)).ok, true)
    assert.equal(validateDraftText('A title', 'y'.repeat(MAX_BODY + 1)).ok, false)
    assert.equal(validateDraftText('A title', 'y'.repeat(MIN_BODY - 1)).ok, false)
  })

  test('A LINK, AN EMAIL, A REVIEW SITE AND AN INSTRUCTION TO POST are all refused', () => {
    // The same list validateDrafts applies to a model's reply. A person typing
    // one is no more entitled to it than a model producing one.
    const rejected = [
      `${GOOD_BODY} See https://example.com for more.`,
      `${GOOD_BODY} Visit www.example.com today.`,
      `${GOOD_BODY} Write to sales@example.com about it.`,
      `${GOOD_BODY} Find us on Trustpilot.`,
      `${GOOD_BODY} Please post this review somewhere.`,
    ]
    for (const body of rejected) {
      assert.equal(validateDraftText('A title', body).ok, false, `accepted: ${body.slice(-40)}`)
    }
  })

  test('a telephone number is refused, in the title as well as the body', () => {
    assert.equal(validateDraftText('A title', `${GOOD_BODY} Call 020 7946 0000.`).ok, false)
    assert.equal(validateDraftText('Call 9876543210', GOOD_BODY).ok, false)
  })

  test('and the refusal never echoes what was typed', () => {
    // The message is built from constants. A route that returned it verbatim
    // would otherwise reflect a phone number back into a response body.
    const result = validateDraftText('A title', `${GOOD_BODY} Call 020 7946 0000.`)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.includes('7946'), false)
      assert.equal(result.error.includes(GOOD_BODY.slice(0, 20)), false)
    }
  })
})

// ══ 2. THE ROUTE ════════════════════════════════════════════════════════════

describe('the edit route', () => {
  const code = executable(ROUTE)

  test('it is a PATCH, and it is the only verb', () => {
    assert.ok(code.includes('export async function PATCH('))
    for (const verb of ['GET', 'POST', 'DELETE', 'PUT']) {
      assert.equal(code.includes(`export async function ${verb}(`), false, `${verb} exists`)
    }
  })

  test('it resolves `verify` BEFORE it reads the body', () => {
    // A caller who may not edit learns nothing about what a valid request looks
    // like, and no work is done on their behalf.
    const permission = code.indexOf("p_action_key: 'verify'")
    const body = code.indexOf('await req.json()')
    assert.ok(permission >= 0, 'the permission is never resolved')
    assert.ok(body > permission, 'the body is read before the permission is resolved')
  })

  test('it reads is_active and never the role column', () => {
    assert.ok(code.includes(".select('is_active')"))
    assert.equal(/\.select\([^)]*\brole\b/.test(code), false)
    assert.equal(/isAdmin|is_admin/.test(code), false)
  })

  test('it refuses anything that is not pending', () => {
    assert.ok(code.includes("if (card.status !== 'pending_approval') return fail(409, MESSAGES.not_pending)"))
    assert.ok(code.includes('CUSTOMER_REVIEW_TEST_NOT_PENDING'))
  })

  test('it refuses a deleted review', () => {
    assert.ok(code.includes('card.deleted_at !== null'))
    assert.ok(code.includes('CUSTOMER_REVIEW_TEST_DELETED'))
  })

  test('the card is read as the CALLER, so RLS decides visibility', () => {
    // `caller`, not the service client. A draft they may not see returns no row
    // and this route cannot tell "not yours" from "does not exist".
    assert.ok(code.includes("caller\n    .from('customer_review_test_cards')"))
  })

  test('the write goes through the definer function, not a direct update', () => {
    assert.ok(code.includes("admin.client.rpc('edit_customer_review_draft'"))
    // No table write from the route. The function is the only writer, and it is
    // where the row is locked.
    assert.equal(/admin\.client[\s\S]{0,80}\.from\('customer_review_test_cards'\)[\s\S]{0,40}\.update/.test(code), false)
  })

  test('IT NEVER APPROVES ANYTHING', () => {
    // The property the whole feature rests on. No status is written, and no
    // approval RPC is reachable from here.
    assert.equal(/approve_customer_review/.test(code), false)
    assert.equal(/status:\s*'available'/.test(code), false)
    assert.equal(/'available'/.test(code), false)
  })

  test('IT NEVER CALLS A MODEL', () => {
    assert.equal(/anthropic|ANTHROPIC|api\.anthropic\.com/.test(code), false)
    assert.equal(/buildSystemPrompt|buildUserPrompt|buildRevisionPrompt/.test(code), false)
  })

  test('every response is a prewritten sentence, or the validator’s own', () => {
    // The database's message text is never forwarded: it is written for a
    // person but it is not this route's to choose, and it can name a reference
    // the caller may not be entitled to.
    assert.equal(/fail\([0-9]+,\s*error\.message/.test(code), false)
    assert.equal(/error:\s*error\.message/.test(code), false)
  })

  test('nothing is cacheable', () => {
    assert.ok(code.includes("'Cache-Control': 'no-store, private'"))
  })

  test('it runs on Node, like every other route in this module', () => {
    assert.ok(code.includes("export const runtime = 'nodejs'"))
  })
})

// ══ 3. THE DATABASE IS WHAT ACTUALLY DECIDES ════════════════════════════════

describe('edit_customer_review_draft()', () => {
  const body = fn('edit_customer_review_draft')

  test('it is a definer function the browser cannot execute', () => {
    assert.ok(body.includes('security definer'))
    assert.ok(body.includes('set search_path = public, pg_temp'))
    assert.ok(SQL.includes('revoke execute on function public.edit_customer_review_draft(uuid, text, text, uuid) from public, anon, authenticated'))
    assert.ok(SQL.includes('grant  execute on function public.edit_customer_review_draft(uuid, text, text, uuid) to service_role'))
  })

  test('it resolves `verify`, and reads no role', () => {
    assert.ok(body.includes("public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify')"))
    assert.equal(/\brole\b/.test(body), false)
  })

  test('IT LOCKS THE ROW BEFORE IT READS THE STATUS', () => {
    // The ordering is the guarantee. Reading the status and then locking would
    // let a draft approved in between be edited anyway.
    const lock = body.indexOf('for update')
    const status = body.indexOf("c.status <> 'pending_approval'")
    assert.ok(lock >= 0, 'the row is never locked')
    assert.ok(status > lock, 'the status is read before the row is locked')
  })

  test('ONE CLAUSE REFUSES EVERY NON-PENDING STATE', () => {
    // Written as `<> 'pending_approval'` rather than a list of the states to
    // refuse, so a state added later is refused by default rather than by
    // somebody remembering to add it.
    assert.ok(body.includes("if c.status <> 'pending_approval' then"))
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_NOT_PENDING'))
    assert.equal(/status\s+in\s*\(/.test(body), false, 'an allow-list of statuses crept in')
  })

  test('a deleted review is refused', () => {
    assert.ok(body.includes('if c.deleted_at is not null then'))
  })

  test('it re-checks the telephone rule in SQL', () => {
    assert.ok(body.includes('public.customer_review_contains_phone(v_title)'))
    assert.ok(body.includes('public.customer_review_contains_phone(v_body)'))
  })

  test('IT WRITES NO STATUS AND NO APPROVAL STAMP', () => {
    // The single most important assertion in this file. An edit changes words.
    assert.equal(/set[\s\S]{0,400}status\s*=/.test(body), false, 'the update touches status')
    assert.equal(/approved_at\s*=/.test(body), false)
    assert.equal(/approved_by\s*=/.test(body), false)
  })

  test('it stamps who edited and when, and writes the trail', () => {
    assert.ok(body.includes('draft_edited_at = now()'))
    assert.ok(body.includes('draft_edited_by = p_actor_id'))
    assert.ok(body.includes("'draft_edited'"))
  })

  test('the stamp is both-or-neither', () => {
    assert.ok(SQL.includes('check ((draft_edited_at is null) = (draft_edited_by is null))'))
  })

  test('the trail learned the word, in the arm that names no status', () => {
    assert.ok(SQL.includes("'draft_edited',"))
    // An edit does not move the card, so naming a status either side would be
    // inventing one.
    assert.ok(SQL.includes("event_type in ('revised', 'draft_edited', 'whatsapp_opened',"))
  })
})

// ══ 4. THE SCREEN ═══════════════════════════════════════════════════════════

describe('the editing screen', () => {
  const editor = executable(EDITOR)
  const pending = executable(PENDING)

  test('the body is a full textarea, not a compressed inline field', () => {
    // The requirement, and the reason for it: editing prose through a
    // three-line window is how sentences get mangled at the seam.
    assert.ok(editor.includes('<textarea'))
    assert.ok(editor.includes('rows={14}'))
    assert.ok(editor.includes("minHeight: '240px'"))
  })

  test('it offers Save and Cancel, and both are real controls', () => {
    assert.ok(editor.includes('Save changes'))
    assert.ok(editor.includes('>\n        Cancel\n      </button>') || editor.includes('Cancel'))
  })

  test('it shows a saving state and an error state', () => {
    assert.ok(editor.includes("{saving ? 'Saving…' : 'Save changes'}"))
    assert.ok(editor.includes('Saving your changes…'))
    assert.ok(editor.includes('role="alert"'))
    assert.ok(editor.includes('role="status"'))
  })

  test('SAVE IS NOT APPROVE — the editing footer has no approval control', () => {
    // The footer swaps with the mode. While editing, Save and Cancel are the
    // only two actions; Approve is not among them, because approving and saving
    // are two decisions and one button doing both is how unread text ships.
    //
    // Asserted against the CONTROLS rather than the word: the editor's copy
    // legitimately says "awaiting approval" and "it does not approve it", and a
    // sweep for /approve/ would fail on the very sentences that make the rule
    // clear to a reader.
    assert.equal(/onApprove|approve_customer_review|openConfirm/.test(editor), false,
      'the editor can reach an approval')
    assert.equal(/'available'/.test(editor), false, 'the editor names the approved status')

    // And the footer really does swap. The sheet's footer is one ternary on
    // `editing`: EditDraftActions is the whole of the true branch, and
    // "Approve this review" lives in the false branch after it. Asserted by
    // ORDER, which is the cheap way to say "these are the two arms of one
    // conditional" without pinning the exact whitespace between them.
    assert.ok(pending.includes('<EditDraftActions editor={editor} onCancel={() => setEditing(false)} />'))
    const editArm = pending.indexOf('<EditDraftActions editor={editor}')
    // The BUTTON's label, which sits on its own line. Searched with the
    // trailing newline so it does not match the confirmation sheet's title
    // ("Approve this review?"), which appears earlier in the file and is a
    // different control entirely.
    const approveArm = pending.indexOf('Approve this review\n')
    assert.ok(editArm >= 0 && approveArm >= 0)
    assert.ok(editArm < approveArm, 'the approve control is not in the non-editing arm')
    assert.ok(pending.slice(editArm, approveArm).includes(') : ('),
      'the two controls are not the arms of one conditional')
  })

  test('and the screen says so in words', () => {
    assert.ok(EDITOR.includes('it does not approve it'))
  })

  test('the courtesy check is the SAME function the server runs', () => {
    // Imported rather than restated, so a message shown here and a message
    // returned by the server cannot disagree about what is wrong.
    assert.ok(editor.includes('validateDraftText'))
    assert.ok(editor.includes("from '@/lib/customerReviews/draftGeneration'"))
  })

  test('a second press cannot start a second save', () => {
    assert.ok(editor.includes('inFlight.current'))
    assert.ok(editor.includes('disabled={saving || !dirty || !check.ok}'))
  })

  test('the sheet will not be dismissed by a stray tap while editing', () => {
    assert.ok(pending.includes('dismissOnBackdrop={!editing && !editor.saving}'))
  })

  test('EDITING IS OFFERED ONLY FROM THE PENDING WORKSPACE', () => {
    // PendingBatches renders pending drafts only — the caller's query is what
    // makes that true — and the editor exists nowhere else in the module.
    for (const file of [
      'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx',
      'src/app/customer-reviews/TestCardListScreen.tsx',
      'src/components/customerReviews/ReviewFullView.tsx',
    ]) {
      const source = executable(read(file))
      assert.equal(/EditDraftFields|EditDraftActions|useDraftEditor/.test(source), false,
        `${file} offers the editor`)
    }
  })
})

// ══ 5. AN EDITED DRAFT DOES NOT PRETEND TO BE UNTOUCHED ═════════════════════

describe('provenance stays honest', () => {
  test('an edited draft is labelled as edited, in the sheet and on the tile', () => {
    assert.ok(EDITOR.includes('Edited by a verifier'))
    assert.ok(executable(PENDING).includes('<DraftEditedNote card={card} compact />'))
    assert.ok(executable(PENDING).includes('<DraftEditedNote card={current} />'))
  })

  test('the note appears only when there is an edit to report', () => {
    assert.ok(executable(EDITOR).includes('if (!card.draft_edited_at) return null'))
  })

  test('THE AI LABEL IS NOT REMOVED — both facts are shown', () => {
    // The draft came from a model AND a person has since changed it. Dropping
    // either would be a different kind of untrue.
    assert.ok(executable(PENDING).includes('<InternalTestWarning'))
    assert.ok(executable(read('src/components/customerReviews/ReviewFullView.tsx')).includes('<InternalTestWarning />'))
  })

  test('the detail screen no longer promises the text can never be edited', () => {
    // It used to end "and cannot be edited — not by you, not by an
    // administrator, and not through any screen in BOE", which stopped being
    // true when this feature landed. What it says now is the narrow thing that
    // IS true: the window closed at approval.
    const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
    assert.equal(
      detail.includes('is not attributed to anybody, and cannot be edited'),
      false,
      'the retired immutability sentence is still on the detail screen',
    )
    assert.ok(detail.includes('Now that it is approved its text is final'))
    assert.ok(detail.includes('A verifier edited it before approving it.'))
  })
})
