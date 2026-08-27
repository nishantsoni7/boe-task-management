/**
 * "SUBMIT FOR APPROVAL" IS THE LEAD ACTION, NOT THE SUBJECT OF THE PAGE.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The button was a saturated solid-blue block with a blue shadow, stretched to
 * the full width of its row by the shared `flex: 1 1 auto` on
 * `.boe-task-action-primary`. Fill, shadow and width together made it the
 * loudest thing on Task Details — louder than the task title, the status and
 * the activity underneath.
 *
 * The change is entirely visual, and the danger in a change like this is
 * COLLATERAL: the same primary class dresses Mark Complete and Approve &
 * Complete, `.boe-btn` dresses half the product, and Send Update sits a few
 * hundred lines away in the same file. So most of what is asserted here is what
 * did NOT move.
 *
 * Behaviour — eligibility, the handler, the disabled expression, the busy
 * label — is asserted UNCHANGED, character for character, because a restyle
 * that quietly alters when a button can be pressed is not a restyle.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/submitButtonBalance.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const PAGE = read('src/app/tasks/[id]/page.tsx')
const CSS = read('src/app/globals.css')

/** The Submit button's JSX, from its guard to its closing tag. */
const SUBMIT = (() => {
  const start = PAGE.indexOf('{maySubmit && (')
  assert.ok(start > 0, 'the Submit for Approval button must exist')
  const end = PAGE.indexOf('{mayApprove && (', start)
  assert.ok(end > start)
  return PAGE.slice(start, end)
})()

/** Its CSS block, from the class to the end of the focus rule. */
const SUBMIT_CSS = (() => {
  const start = CSS.indexOf('.boe-task-action-submit {')
  assert.ok(start > 0, 'the scoped class must exist')
  const end = CSS.indexOf('}', CSS.indexOf('.boe-task-action-submit:focus-visible'))
  return CSS.slice(start, end + 1)
})()

// ── 1-2. The block and the glow are gone ─────────────────────────────────────

describe('1-2. no saturated fill, no blue shadow', () => {
  test('1. it is no longer a solid-blue block', () => {
    // The old treatment, gone from both the inline style and the class.
    assert.equal(SUBMIT.includes('background: colors.blue'), false)
    assert.equal(/background:\s*#5585E8/i.test(SUBMIT_CSS), false)
    assert.equal(SUBMIT.includes("color: '#ffffff'"), false, 'no white-on-blue label')

    // What it is instead: a pale fill with dark blue text and a soft border.
    assert.match(SUBMIT_CSS, /background:\s*#EFF6FF/i)
    assert.match(SUBMIT_CSS, /color:\s*#1E40AF/i)
    assert.match(SUBMIT_CSS, /border:\s*1\.5px solid #BFDBFE/i)
  })

  test('1b. and every colour it uses is one this project already ships', () => {
    // Tailwind blue-50 / 200 / 800 — the same trio the Orders status chips and
    // the permissions role badges already wear. Nothing invented here.
    for (const [hex, where] of [
      ['#EFF6FF', 'src/app/orders/page.tsx'],
      ['#1E40AF', 'src/app/orders/page.tsx'],
      ['#BFDBFE', 'src/app/orders/page.tsx'],
    ] as const) {
      assert.ok(read(where).includes(hex), `${hex} must already exist in ${where}`)
    }
  })

  test('2. the strong blue shadow is absent', () => {
    assert.equal(SUBMIT.includes('boxShadow'), false, 'no inline shadow')
    assert.match(SUBMIT_CSS, /box-shadow:\s*none/)
    // The exact glow it used to carry, gone from THIS button.
    assert.equal(SUBMIT.includes('0 2px 6px rgba(85,133,232,0.25)'), false)
    // But NOT gone from Send Update, which keeps its solid blue and its shadow
    // and is explicitly out of scope. That it still matches this string is the
    // proof the change did not spill sideways.
    assert.ok(PAGE.includes('0 2px 6px rgba(85,133,232,0.25)'),
      'Send Update must keep the treatment this button gave up')
  })
})

// ── 3-4. The hierarchy still reads ───────────────────────────────────────────

describe('3-4. still the lead, still ahead of its siblings', () => {
  test('3. it is the only action in the row carrying a fill', () => {
    // Copy & Assign and Cancel are white. A tinted fill is what makes this one
    // read as the lead without shouting.
    assert.match(SUBMIT_CSS, /background:\s*#EFF6FF/i)
    assert.ok(SUBMIT.includes('boe-task-action-primary'),
      'and it keeps the primary role in the row layout')
    assert.ok(SUBMIT.includes('fontWeight: 700'), 'heavier than the secondaries\' 600')
  })

  test('4. Copy & Assign and Cancel are untouched, still white and secondary', () => {
    for (const frag of [
      // Copy & Assign — outlined blue on white.
      "border: `1.5px solid ${colors.blue}55`",
      "background: '#ffffff', color: colors.blue,",
      // Cancel — neutral.
      "border: '1.5px solid #78716C33'",
      "background: '#ffffff', color: '#78716C',",
    ]) {
      assert.ok(PAGE.includes(frag), `unchanged: ${frag}`)
    }
    // Both still wear the secondary class and nothing else.
    assert.equal((PAGE.match(/className="boe-task-action-secondary"/g) ?? []).length >= 2, true)
  })
})

// ── 5-6. Nothing else moved ──────────────────────────────────────────────────

describe('5-6. no collateral damage', () => {
  test('5. the new class dresses exactly one button', () => {
    assert.equal((PAGE.match(/className="[^"]*boe-task-action-submit/g) ?? []).length, 1,
      'exactly one element wears it')
    // And nowhere else in the product uses it.
    assert.equal(read('src/app/tasks/my/page.tsx').includes('boe-task-action-submit'), false)
    assert.equal(read('src/app/dashboard/page.tsx').includes('boe-task-action-submit'), false)
  })

  test('5b. Mark Complete and Approve & Complete keep their green treatment', () => {
    for (const frag of [
      "border: `1.5px solid ${colors.green}`",
      'background: colors.green, color: \'#ffffff\',',
      'boxShadow: `0 2px 6px ${colors.green}38`',
    ]) {
      assert.ok(PAGE.includes(frag), `unchanged: ${frag}`)
    }
    // Both still carry the shared primary class, which this change does not touch.
    assert.ok(PAGE.includes("className={isQuotation ? undefined : 'boe-task-action-primary'}"))
    assert.ok(PAGE.includes('className="boe-task-action-primary"'))
  })

  test('6. no global button style changed', () => {
    // The shared row rules, byte for byte.
    assert.ok(CSS.includes('.boe-task-actions .boe-task-action-primary   { flex: 1 1 auto; min-width: 0; }'))
    assert.ok(CSS.includes('.boe-task-actions .boe-task-action-secondary { flex: 0 0 auto; white-space: nowrap; }'))
    // The product-wide button class is not mentioned by any rule added here.
    assert.equal(SUBMIT_CSS.includes('.boe-btn'), false)
    // And the retired one-off class is gone rather than left dressing nothing.
    assert.equal(CSS.includes('boe-task-action-blue'), false)
    assert.equal(PAGE.includes('boe-task-action-blue'), false)
  })

  test('6b. Send Update is untouched', () => {
    // A different button, a few hundred lines away, that also used to be blue.
    const send = PAGE.slice(PAGE.indexOf('onClick={saveComment}'))
    assert.ok(send.includes('Send Update') || PAGE.includes('Send Update'))
    assert.equal(send.slice(0, 1200).includes('boe-task-action-submit'), false)
  })
})

// ── 7. Behaviour, character for character ────────────────────────────────────

describe('7. nothing about how it behaves has moved', () => {
  test('7. handler, eligibility, disabled and busy label are unchanged', () => {
    assert.ok(SUBMIT.includes('{maySubmit && ('), 'same eligibility guard')
    assert.ok(SUBMIT.includes('onClick={submitForApproval}'), 'same handler')
    assert.ok(SUBMIT.includes('disabled={saving || reviewBusyAny || statusUpdating}'),
      'same disabled expression')
    assert.ok(SUBMIT.includes("cursor: saving || reviewBusyAny || statusUpdating ? 'not-allowed' : 'pointer'"))
    assert.ok(SUBMIT.includes('opacity: saving || reviewBusyAny || statusUpdating ? 0.6 : 1'),
      'same loading dim')
    assert.ok(SUBMIT.includes("{reviewBusy === 'submit' ? 'Submitting…' : 'Submit for Approval'}"),
      'same wording, same busy label')
  })

  test('7b. the icon and the label are preserved exactly', () => {
    assert.ok(SUBMIT.includes('<SendHorizontal size={15} strokeWidth={2.4}'))
    assert.ok(SUBMIT.includes('Submit for Approval'))
    // Not renamed, and not moved out of the action row.
    const rowStart = PAGE.indexOf('className={`boe-task-actions$')
    const rowEnd = PAGE.indexOf('{/* Completed: Reopen option */}')
    assert.ok(rowStart > 0 && PAGE.indexOf('{maySubmit && (') > rowStart)
    assert.ok(PAGE.indexOf('{maySubmit && (') < rowEnd, 'still inside the same action row')
  })

  test('7c. the approval workflow itself is not referenced by this change', () => {
    // The restyle touches presentation only: no permission helper, no status
    // value, no notification call appears inside the button's JSX.
    for (const forbidden of ['supabase', 'fetch(', 'notify', 'canSubmitForApproval', 'setTask(']) {
      assert.equal(SUBMIT.includes(forbidden), false,
        `${forbidden} must not appear in the button's markup`)
    }
  })
})

// ── 8. Hover and focus ───────────────────────────────────────────────────────

describe('8. it still responds to a pointer and to a keyboard', () => {
  test('8. a restrained pale-blue hover, one step along the same ramp', () => {
    assert.match(CSS, /\.boe-task-action-submit:not\(:disabled\):hover\s*\{\s*background:\s*#DBEAFE/i)
    // And it can actually win: the fill is no longer an inline style, which an
    // author-level :hover rule cannot override.
    assert.equal(/style=\{\{[\s\S]*background:/.test(SUBMIT), false,
      'no inline background may shadow the hover rule')
    assert.match(CSS, /\.boe-task-action-submit:not\(:disabled\):active/, 'and it still presses')
  })

  test('8b. a visible keyboard focus ring, dark enough for a pale fill', () => {
    const focus = CSS.slice(CSS.indexOf('.boe-task-action-submit:focus-visible'))
    assert.match(focus.slice(0, 140), /outline:\s*2px solid #1E40AF/i)
    assert.match(focus.slice(0, 180), /outline-offset:\s*2px/)
  })

  test('8c. hover and press are gated on :not(:disabled)', () => {
    // A disabled button that still lights up under the cursor invites a click
    // that will not happen.
    for (const rule of ['hover', 'active']) {
      assert.match(CSS, new RegExp(`\\.boe-task-action-submit:not\\(:disabled\\):${rule}`))
    }
  })
})

// ── 9-10. Width, and both viewports ──────────────────────────────────────────

describe('9-10. the row is balanced, and the phone is unchanged', () => {
  test('9. content width, not row width — and only for this button', () => {
    // The override carries BOTH class names, so it beats the shared
    // `flex: 1 1 auto` on specificity without touching it.
    assert.ok(CSS.includes(
      '.boe-task-actions .boe-task-action-primary.boe-task-action-submit { flex: 0 1 auto; }'))
    // `0 1` and not `0 0`: it may still shrink, so a narrow card cannot be
    // overflowed by a long label.
    assert.equal(/\.boe-task-action-submit\s*\{\s*flex:\s*0 0/.test(CSS), false)
  })

  test('9b. comfortably wider than its label, and the same height as before', () => {
    // 14px -> 18px horizontal: a content-width button needs more room around
    // the text than a stretched one did. Vertical padding, border and font are
    // all unchanged, so the height is too.
    assert.ok(SUBMIT.includes("padding: '9px 18px'"), 'balanced horizontal padding')
    assert.ok(SUBMIT.includes("fontSize: '13px'"))
    assert.match(SUBMIT_CSS, /border:\s*1\.5px/, 'same border width as the old solid one')
  })

  test('10. mobile keeps the full-width row it always had', () => {
    // The 600px grid still spans the primary across both columns; `flex` does
    // not apply in a grid, so the desktop override cannot leak into it.
    assert.ok(CSS.includes('.boe-task-actions .boe-task-action-primary   { grid-column: 1 / -1; }'))
    assert.ok(CSS.includes('.boe-task-actions .boe-task-action-secondary { width: 100%; }'))
    // Nothing pins the button to a pixel width, at either size.
    assert.equal(/width:\s*\d+px/.test(SUBMIT), false)
    assert.equal(/(?<![a-z-])width:\s*\d+px/.test(SUBMIT_CSS), false)
  })

  test('10b. and the row still cannot overflow on desktop', () => {
    // nowrap plus a shrinkable primary is what keeps three buttons on one line
    // inside a narrow card.
    assert.ok(CSS.includes('flex-wrap: nowrap;'))
    assert.ok(CSS.includes('.boe-task-actions .boe-task-action-primary   { flex: 1 1 auto; min-width: 0; }'),
      'min-width: 0 still lets the primary shrink')
  })
})
