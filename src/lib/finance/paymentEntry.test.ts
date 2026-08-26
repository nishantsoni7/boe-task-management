/**
 * The payment-entry destination model — the application half.
 *
 * TWO FORMS, ONE QUESTION. Payment Request (src/app/finance/page.tsx) and
 * Record Payment (src/app/finance/received/RecordSplitPaymentModal.tsx) both ask
 * where money is for and how it arrived. Before 20261013000000 they answered
 * from different arrays in different files, and one of them asked for a customer
 * name that the database was about to overwrite. These tests pin what makes that
 * unrepeatable.
 *
 * HALF PURE, HALF SOURCE-SHAPE, and deliberately so. The vocabulary and the
 * formatters are functions a test can call. "There is no Customer Name input" is
 * not — it is a claim about a file, and the only honest way to check it is to
 * read the file. Every source assertion below strips comments first, because a
 * sentence explaining that a thing was removed is not the thing.
 *
 * NONE OF THIS IS A SECURITY BOUNDARY. Every rule the forms appear to enforce is
 * re-derived server-side by submit_payment_request and
 * record_payment_with_allocations, and proved there by
 * supabase/tests/payment_entry_destination_model_assertions.sql. What these
 * tests protect is that the browser asks the same question the server answers.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentEntry.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MULTIPLE_CUSTOMER_LABEL,
  NO_CUSTOMER_LABEL,
  PAYMENT_DESTINATIONS,
  PAYMENT_DESTINATION_LABEL,
  PAYMENT_DESTINATION_OPTIONS,
  PAYMENT_MODES,
  PAYMENT_MODE_VALUES,
  SUSPENSE_NOTICE,
  customerDisplayName,
  destinationNeedsTarget,
  destinationTargetKind,
  isPaymentDestination,
  isPaymentMode,
  paymentEntryErrorMessage,
  paymentModeLabel,
} from './paymentEntry'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** A comment saying a thing was removed is not the thing. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const REQUEST_FORM   = 'src/app/finance/page.tsx'
const RECORD_FORM    = 'src/app/finance/received/RecordSplitPaymentModal.tsx'
const SHARED_FIELDS  = 'src/app/finance/components/PaymentEntryFields.tsx'
const DISCARD_GUARD  = 'src/app/finance/components/DiscardGuard.tsx'
const CASH_TRAIL     = 'src/app/finance/components/CashTrailFields.tsx'
const MIGRATION      = 'supabase/migrations/20261013000000_payment_entry_destination_model.sql'

const BOTH_FORMS = [REQUEST_FORM, RECORD_FORM]

/**
 * Just the modal, out of a file that holds a whole page.
 *
 * src/app/finance/page.tsx is three thousand lines: a list, five other modals
 * and the page's own auth read. An assertion aimed at the SUBMISSION FORM has to
 * be aimed at the submission form, or it fails on a legacy read three screens
 * away and says something untrue about the form.
 */
function modalSource(file: string): string {
  const src = code(read(file))
  if (file !== REQUEST_FORM) return src
  const from = src.indexOf('function NewPaymentConfirmationModal(')
  const to   = src.indexOf('function PaymentIntentSummary(')
  if (from < 0 || to < 0 || to < from) {
    throw new Error('the Payment Request modal could not be located — has it been renamed?')
  }
  return src.slice(from, to)
}

/** The correction form, sliced out of the same page. */
function editModalSource(): string {
  const src = code(read(REQUEST_FORM))
  const from = src.indexOf('function EditPaymentModal(')
  const to   = src.indexOf('function FigureBand(')
  if (from < 0 || to < 0 || to < from) {
    throw new Error('the Edit Payment Request modal could not be located — has it been renamed?')
  }
  return src.slice(from, to)
}

// ── 1. Three destinations, and the same three on both forms ───────────────────

describe('the destination vocabulary', () => {
  test('there are exactly three, and they are the values the RPC accepts', () => {
    assert.deepEqual([...PAYMENT_DESTINATIONS], ['pi_draft', 'confirmed_order', 'suspense'])
    // The same three, spelled the same way, in the door they are sent to.
    const sql = read(MIGRATION)
    assert.ok(sql.includes("v_dest not in ('pi_draft', 'confirmed_order', 'suspense')"),
      'submit_payment_request must accept exactly these three')
  })

  test('every destination has a label and a description that names the situation', () => {
    assert.equal(PAYMENT_DESTINATION_OPTIONS.length, 3)
    assert.deepEqual(PAYMENT_DESTINATION_OPTIONS.map(o => o.value), [...PAYMENT_DESTINATIONS])
    assert.deepEqual(PAYMENT_DESTINATION_OPTIONS.map(o => o.label),
      ['PI Draft', 'Confirmed Order', 'Suspense Entry'])
    for (const o of PAYMENT_DESTINATION_OPTIONS) {
      assert.ok(o.description.trim().length > 0, `${o.value} says nothing about when to choose it`)
      assert.equal(PAYMENT_DESTINATION_LABEL[o.value], o.label)
    }
  })

  test('an unknown destination is rejected rather than coerced', () => {
    for (const bad of ['order_request', 'unallocated', 'new_order', '', null, undefined]) {
      assert.equal(isPaymentDestination(bad as string), false, String(bad))
    }
  })

  test('two destinations need a target and exactly one does not', () => {
    assert.equal(destinationNeedsTarget('pi_draft'), true)
    assert.equal(destinationNeedsTarget('confirmed_order'), true)
    assert.equal(destinationNeedsTarget('suspense'), false)

    assert.equal(destinationTargetKind('pi_draft'), 'submission')
    assert.equal(destinationTargetKind('confirmed_order'), 'order')
    assert.equal(destinationTargetKind('suspense'), null)
  })

  test('Suspense says what will happen to the money, in one sentence', () => {
    assert.match(SUSPENSE_NOTICE, /unallocated/i)
    assert.match(SUSPENSE_NOTICE, /Allocate Funds/)
  })

  test('both forms draw the cards from the shared component, not from their own list', () => {
    for (const file of BOTH_FORMS) {
      const src = modalSource(file)
      assert.ok(/DestinationCards|PaymentEntryFields/.test(src),
        `${file} must render the shared destination block`)
      // No second list of destinations anywhere in either form.
      assert.equal(/'pi_draft'[\s\S]{0,120}'confirmed_order'[\s\S]{0,120}'suspense'/.test(src), false,
        `${file} must not restate the destination list`)
    }
  })
})

// ── 2. One payment-mode source ────────────────────────────────────────────────

describe('the payment-mode vocabulary', () => {
  test('exactly the five the database CHECK allows, and no Card', () => {
    assert.deepEqual([...PAYMENT_MODE_VALUES],
      ['bank_transfer', 'cash', 'upi', 'cheque', 'other'])
    assert.deepEqual(PAYMENT_MODES.map(m => m.label),
      ['Bank Transfer', 'Cash', 'UPI', 'Cheque', 'Other'])
    assert.equal(isPaymentMode('card'), false, 'card is not in the constraint and must not be offered')
  })

  test('the migration refuses the same five, by name', () => {
    const sql = read(MIGRATION)
    assert.ok(sql.includes("v_mode not in ('bank_transfer', 'cash', 'upi', 'cheque', 'other')"),
      'submit_payment_request must restate the canonical five')
    // The migration NAMES 'card' once, in the apply-time assertion that refuses
    // it — proving its absence is the point, so the check is that the domain
    // never gains it, not that the word is unsaid.
    assert.ok(sql.includes("raise exception 'payment_mode must NOT accept ''card'"),
      'the migration must assert, at apply time, that the domain still refuses card')
    assert.equal(/in \('bank_transfer'[^)]*'card'/.test(sql), false,
      'no list in this migration may admit card')
  })

  test('an unrecognised stored mode is shown AS STORED, never relabelled', () => {
    // A row carrying something this list does not know is a fact worth seeing.
    assert.equal(paymentModeLabel('crypto'), 'crypto')
    assert.equal(paymentModeLabel('bank_transfer'), 'Bank Transfer')
    assert.equal(paymentModeLabel(''), '—')
    assert.equal(paymentModeLabel(null), '—')
  })

  test('no surface keeps its own mode list any more', () => {
    // Five files used to hold five arrays that happened to agree. They agreed;
    // nothing made them.
    for (const file of [
      REQUEST_FORM,
      RECORD_FORM,
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/app/orders/[id]/page.tsx',
      'src/lib/finance/piPaymentView.ts',
      'src/app/finance/paymentDestinations.ts',
    ]) {
      const src = code(read(file))
      assert.equal(/'bank_transfer'[\s\S]{0,200}'cheque'/.test(src), false,
        `${file} must not restate the payment-mode list — import it`)
    }
  })
})

// ── 3-5. The customer is never typed, and nothing is fabricated ───────────────

describe('the customer is derived, never entered', () => {
  test('neither form has a customer input', () => {
    for (const file of BOTH_FORMS) {
      const src = modalSource(file)
      // No state holding a typed name…
      assert.equal(/setClientName|clientName,\s*setClientName|manualClientName/.test(src), false,
        `${file} must hold no typed customer name`)
      // …and no labelled field asking for one.
      assert.equal(/label="Client Name"/.test(src), false,
        `${file} must not ask for a Client Name`)
    }
  })

  test('the shared destination block shows the customer read-only and sends nothing', () => {
    const src = code(read(SHARED_FIELDS))
    assert.ok(src.includes('state.target.clientName'),
      'the chosen record confirms which customer it names')
    // The only input in the block is the target SEARCH box — never a name.
    const inputs = [...src.matchAll(/<input\b/g)]
    assert.equal(inputs.length, 1, 'the destination block has exactly one input: the target search')
    const tag = src.slice(src.indexOf('<input'), src.indexOf('<input') + 600)
    assert.ok(tag.includes('runSearch'), 'and it is the search box')
    assert.equal(/value=\{[^}]*clientName/.test(tag), false, 'the customer is never editable')
    // No <textarea> or <select> smuggles one in either.
    assert.equal(/<textarea|<select/.test(src), false)
  })

  test('the Payment Request form sends no customer — the RPC has no parameter for one', () => {
    const src = modalSource(REQUEST_FORM)
    assert.ok(src.includes(".rpc('submit_payment_request'"))
    assert.equal(src.includes('p_client_name'), false)
    const sql = read(MIGRATION)
    assert.equal(/create or replace function public\.submit_payment_request\([^)]*p_client_name/.test(sql), false,
      'a parameter that is ignored is a parameter somebody will eventually rely on')
  })

  test('the Record Payment form sends NULL rather than a guess', () => {
    const src = code(read(RECORD_FORM))
    assert.ok(src.includes('p_client_name:  null'),
      'the customer comes from the targets the RPC validates')
    assert.ok(src.includes('p_received_in:  null'),
      'and the account is not invented to fill a nullable column')
  })

  test('no Received In control survives on the Record Payment form', () => {
    const src = code(read(RECORD_FORM))
    for (const gone of ['RECEIVED_IN', 'receivedIn', 'setReceivedIn', 'Received in', 'Received In']) {
      assert.equal(src.includes(gone), false, `${RECORD_FORM} must not still offer ${gone}`)
    }
  })

  test('the Payment Request form states no receiving account either', () => {
    const src = modalSource(REQUEST_FORM)
    const written = [...src.matchAll(/received_in:\s*([A-Za-z_$][\w$]*)/g)]
      .map(m => m[1]).filter(t => t !== 'string')
    assert.deepEqual(written, [], 'the account picker is gone and nothing replaces its value')
    assert.equal(src.includes('p_received_in'), false)
  })

  test('the migration stores NULL for both rather than inventing either', () => {
    const sql = read(MIGRATION)
    assert.ok(sql.includes('(v_client, p_amount, p_payment_date, v_mode, null,'),
      'submit_payment_request writes a null received_in for every destination')
    assert.ok(sql.includes('v_client   := null;'),
      'and a null customer for Suspense')
  })
})

describe('how a payment with no customer is written down', () => {
  test('never blank, never null, never undefined', () => {
    for (const value of [null, undefined, '', '   ']) {
      const shown = customerDisplayName(value)
      assert.equal(shown, NO_CUSTOMER_LABEL)
      assert.ok(shown.trim().length > 0)
      assert.equal(/null|undefined/i.test(shown), false)
    }
  })

  test('a real name is returned untouched', () => {
    assert.equal(customerDisplayName('Mehta Textiles'), 'Mehta Textiles')
    assert.equal(customerDisplayName('  Mehta Textiles  '), 'Mehta Textiles')
  })

  test('several customers is a DISPLAY rule, never a stored value', () => {
    // The database stores NULL when a payment's allocations name more than one
    // customer, rather than a summary string that would then be searchable as a
    // customer in its own right. The sentence belongs at the point of display.
    assert.equal(customerDisplayName(null, { distinctAllocationCustomers: 2 }), MULTIPLE_CUSTOMER_LABEL)
    assert.equal(customerDisplayName(null, { distinctAllocationCustomers: 1 }), NO_CUSTOMER_LABEL)
    assert.equal(customerDisplayName(null, { distinctAllocationCustomers: 0 }), NO_CUSTOMER_LABEL)
    // A stored name always wins: it is what the server derived.
    assert.equal(customerDisplayName('Mehta Textiles', { distinctAllocationCustomers: 3 }), 'Mehta Textiles')
  })

  test('the migration stores one name only when it is unambiguous', () => {
    const sql = read(MIGRATION)
    assert.ok(sql.includes('case when count(distinct name) = 1 then min(name) end'),
      'record_payment_with_allocations must store NULL rather than a fabricated summary')
  })

  test('every payment surface renders the customer through the one formatter', () => {
    for (const file of [
      REQUEST_FORM,
      'src/app/finance/received/ReceivedPaymentsView.tsx',
      'src/components/finance/DeletePaymentModal.tsx',
      'src/app/admin/control-center/action-queue/page.tsx',
      'src/app/orders/[id]/page.tsx',
    ]) {
      const src = code(read(file))
      assert.ok(/customerDisplayName|<CustomerName/.test(src),
        `${file} must name a missing customer through the shared formatter`)
      // The two shapes that print a blank or an em dash for a real state.
      assert.equal(/client_name \|\| '—'/.test(src), false,
        `${file} must not fall back to an em dash for a customer that is genuinely absent`)
      // As a JSX CHILD, which is what prints a blank. Passing it to a component
      // that formats it — <CustomerName name={r.client_name} /> — is the fix,
      // not the failure.
      assert.equal(/>\s*\{r\.client_name\}/.test(src), false,
        `${file} must not render a nullable customer raw`)
    }
  })
})

// ── 6-8. The target search ────────────────────────────────────────────────────

describe('choosing the record a payment is for', () => {
  test('the search is bounded, and by the same limit on both sources', () => {
    const src = read('src/app/finance/received/AllocatePaymentModal.tsx')
    const limits = [...src.matchAll(/\.limit\((\d+)\)/g)].map(m => Number(m[1]))
    assert.ok(limits.length >= 2, 'both sources must be limited')
    for (const n of limits) assert.ok(n > 0 && n <= 50, `an unbounded-ish limit: ${n}`)
  })

  test('it reads only the table the destination admits', () => {
    const src = read('src/app/finance/received/AllocatePaymentModal.tsx')
    assert.ok(src.includes("const wantOrders = kind !== 'submission'"))
    assert.ok(src.includes("const wantDrafts = kind !== 'order'"))
    assert.ok(src.includes("!wantOrders ? Promise.resolve({ data: [] })"),
      'a form that has already asked PI-or-Order must not query the other table')
    assert.ok(src.includes("!wantDrafts ? Promise.resolve({ data: [] })"))
  })

  test('a superseded search never overwrites a later one', () => {
    for (const file of [SHARED_FIELDS, RECORD_FORM]) {
      const src = read(file)
      const claimed = src.indexOf('const token = ++searchToken.current')
      const checked = src.indexOf('if (token !== searchToken.current) return')
      assert.ok(claimed > -1, `${file} must claim a search token`)
      assert.ok(checked > claimed, `${file} must re-read the token before writing results`)
    }
  })

  test('and it is debounced, so a query is not fired per keystroke', () => {
    for (const file of [SHARED_FIELDS, RECORD_FORM]) {
      const src = code(read(file))
      assert.ok(src.includes('clearTimeout(debounce.current)'), `${file} must debounce its search`)
      assert.match(src, /setTimeout\([\s\S]{0,600}?\}, 250\)/, `${file} must use the shared 250ms delay`)
    }
  })

  test('Suspense searches nothing and carries no target', () => {
    const src = code(read(SHARED_FIELDS))
    // destinationTargetKind returns null for suspense, and the block gates
    // both the search and the results on it.
    assert.ok(src.includes('if (!term || !kind) { setResults([]); return }'))
    assert.ok(src.includes('{kind && !state.target && ('),
      'no target picker is drawn when the destination has no target')
    // Switching destination CLEARS the target rather than carrying it across.
    assert.ok(src.includes('return { destination, target: null }'))
  })

  test('the Record Payment form refuses a Suspense entry that still holds rows', () => {
    const src = code(read('src/lib/finance/splitPaymentEntry.ts'))
    assert.ok(src.includes('A Suspense Entry holds no allocations'),
      'a row left behind must be refused, not quietly dropped')
    assert.ok(src.includes('targetKind ? toRpcAllocations(rows) : []')
      || code(read(RECORD_FORM)).includes('targetKind ? toRpcAllocations(rows) : []'),
      'and the payload must send an empty list for Suspense')
  })
})

// ── 9-13. The modals ──────────────────────────────────────────────────────────

describe('a form modal never throws away what somebody typed', () => {
  test('backdrop click closes neither form', () => {
    const record = code(read(RECORD_FORM))
    assert.ok(record.includes('closeOnBackdropClick={false}'),
      'Record Payment must opt out of backdrop dismissal')

    // The Payment Request form draws its own overlay, so the proof is that the
    // overlay carries no click handler at all.
    // Read UNSTRIPPED: the overlay is located by the comment that labels it.
    const request = read(REQUEST_FORM)
    const overlay = request.slice(request.indexOf('{/* Full-page overlay'),
      request.indexOf('{/* Modal */}'))
    assert.ok(overlay.length > 0, 'the overlay must still be there to check')
    assert.equal(/onClick=/.test(overlay), false,
      'the Payment Request overlay must be inert — a stray click is not a decision')
  })

  test('Escape, ✕ and Cancel all go through the guard, never straight to onClose', () => {
    for (const file of BOTH_FORMS) {
      const src = modalSource(file)
      assert.ok(src.includes('useDiscardGuard'), `${file} must wire the guard`)
      assert.ok(src.includes('guard.requestClose'), `${file} must close through it`)
      assert.ok(src.includes('<DiscardConfirmation'), `${file} must be able to ask`)
    }
  })

  test('the question is the one the product specified, word for word', () => {
    const src = read(DISCARD_GUARD)
    assert.ok(src.includes("'Discard payment details?'"))
    assert.ok(src.includes("'The information entered in this form will be lost.'"))
    assert.ok(src.includes("'Continue Editing'"))
    assert.ok(src.includes("'Discard'"))
  })

  test('a pristine form closes on Escape; a dirty one asks first', () => {
    const src = code(read(DISCARD_GUARD))
    assert.ok(src.includes('if (dirtyRef.current()) { setAsking(true); return }'),
      'dirty asks')
    assert.ok(src.includes('onClose()'), 'pristine closes')
    // The dirtiness is read from a ref, so the handler asks the CURRENT form
    // rather than the one the listener was attached to.
    assert.ok(src.includes('useEffect(() => { dirtyRef.current = isDirty })'),
      'the guard must not close over a stale form')
  })

  test('the confirmation itself cannot be dismissed by clicking past it', () => {
    const src = code(read(DISCARD_GUARD))
    const dialog = src.slice(src.indexOf('role="alertdialog"'))
    const backdrop = dialog.slice(dialog.indexOf("position: 'absolute', inset: 0"))
    assert.equal(/onClick=/.test(backdrop.slice(0, 200)), false,
      'the question has two answers and clicking past it is not one of them')
    assert.ok(src.includes('if (open) keepRef.current?.focus()'),
      'the safe answer is the focused one')
  })

  test('nothing about a payment form reaches browser storage', () => {
    for (const file of [...BOTH_FORMS, DISCARD_GUARD, SHARED_FIELDS, CASH_TRAIL]) {
      const src = code(read(file))
      for (const api of ['localStorage', 'sessionStorage', 'indexedDB']) {
        assert.equal(src.includes(api), false,
          `${file} must not leave a half-entered payment lying in ${api}`)
      }
    }
  })

  test('a second click cannot submit a second payment', () => {
    for (const file of BOTH_FORMS) {
      const src = modalSource(file)
      assert.ok(src.includes('submitting.current'),
        `${file} must guard duplicate submission with a ref, not with state`)
      assert.ok(/if \(![\s\S]{0,40}\|\| saving \|\| submitting\.current\) return/.test(src)
        || /if \(blocked \|\| saving \|\| submitting\.current\) return/.test(src),
        `${file} must refuse a second submit synchronously`)
    }
  })

  test('a refusal keeps the form open with everything still in it', () => {
    for (const file of BOTH_FORMS) {
      const src = modalSource(file)
      // The error path releases the submit lock and sets a message; it never
      // calls the close/saved callback.
      const errorBranch = src.slice(src.indexOf('submitting.current = false'))
      assert.ok(errorBranch.includes('setError('), `${file} must say what went wrong`)
    }
  })

  test('focus enters the dialog, cycles inside it, and returns to the opener', () => {
    const shell = code(read('src/app/finance/components/FinanceModalShell.tsx'))
    assert.ok(shell.includes('export function useDialogFocus'))
    assert.ok(shell.includes('const opener = document.activeElement'))
    assert.ok(shell.includes('if (opener && document.contains(opener)) opener.focus()'))
    assert.ok(shell.includes("if (e.key !== 'Tab') return"))
    for (const file of BOTH_FORMS) {
      const src = modalSource(file)
      assert.ok(/useDialogFocus|FinanceModal/.test(src), `${file} must use the shared dialog focus`)
    }
  })
})

// ── 14. Layout ────────────────────────────────────────────────────────────────

describe('both layouts stay usable', () => {
  test('the destination cards wrap rather than overflowing a narrow dialog', () => {
    const src = read(SHARED_FIELDS)
    assert.ok(src.includes("flexWrap: 'wrap'"), 'three cards must wrap on a phone')
    assert.ok(src.includes("flex: '1 1 180px'"), 'and each must have a floor, not a fixed width')
  })

  test('neither dialog can be wider than the viewport', () => {
    // The Payment Request form draws its own frame; Record Payment uses the
    // shared shell, so the shell is where its cap lives.
    for (const file of [REQUEST_FORM, 'src/app/finance/components/FinanceModalShell.tsx']) {
      const src = read(file)
      assert.ok(/maxWidth: 'calc\(100vw - \d+px\)'/.test(src), `${file} must fit a narrow screen`)
    }
    assert.ok(code(read(RECORD_FORM)).includes('<FinanceModal'),
      'Record Payment must use the shell that carries the cap')
  })

  test('the card is a real radio group, named and checkable by a screen reader', () => {
    const src = read(SHARED_FIELDS)
    assert.ok(src.includes('role="radiogroup"'))
    assert.ok(src.includes('role="radio"'))
    assert.ok(src.includes('aria-checked={selected}'))
    assert.ok(src.includes('Where should this payment go?'),
      'the group must be named, not just visually obvious')
  })

  test('the selected card is named by more than its colour', () => {
    const src = read(SHARED_FIELDS)
    assert.ok(src.includes('{selected && <Check'), 'a check mark, not a tint alone')
    assert.ok(src.includes('aria-hidden="true"'), 'and the icons stay decorative')
  })
})

// ── 15-16. Round trips ────────────────────────────────────────────────────────

describe('what the forms cost to open and to submit', () => {
  test('submitting a Payment Request is ONE call, not a payment plus an intent', () => {
    const src = modalSource(REQUEST_FORM)
    const submit = src.slice(src.indexOf('const handleSubmit ='), src.indexOf('return (\n    <>'))
    const writes = [...submit.matchAll(/supabase\s*\n?\s*\.from\('finance_payment_requests'\)/g)]
    // The only direct table write left in the submit path is the compensation
    // delete when a proof upload fails — never an insert.
    assert.equal(/\.insert\(\{[\s\S]{0,200}payment_date/.test(submit), false,
      'the form must not insert the payment itself — two writes cannot be made atomic here')
    assert.ok(submit.includes(".rpc('submit_payment_request'"))
    assert.ok(writes.length <= 1, 'at most the compensation delete touches the table directly')
  })

  test('the cash trail asks the users table only when Cash is actually chosen', () => {
    const src = code(read(CASH_TRAIL))
    assert.ok(src.includes('if (!capturing || loaded.current) return'),
      'a bank transfer must not read the users table at all')
    assert.ok(src.includes('loaded.current = true'), 'and it must not re-read on every render')
  })

  test('no form re-reads the signed-in user or their profile', () => {
    for (const file of [...BOTH_FORMS, SHARED_FIELDS, CASH_TRAIL]) {
      const src = file === SHARED_FIELDS || file === CASH_TRAIL ? code(read(file)) : modalSource(file)
      assert.equal(/auth\.getUser\(|auth\.getSession\(/.test(src), false,
        `${file} must take the actor from its props, not re-fetch it`)
      assert.equal(/from\('users'\)[\s\S]{0,120}\.eq\('id'/.test(src), false,
        `${file} must not fetch a profile it was handed`)
    }
  })

  test('reading a payment intent is a fixed cost, never one query per row', () => {
    const src = code(read('src/app/finance/paymentIntents.ts'))
    assert.ok(src.includes('.limit(1)'), 'one intent, for one payment')
    const queries = [...src.matchAll(/\.from\('/g)]
    assert.ok(queries.length <= 3,
      'the intent, and at most one lookup for the record it names')
    // And it is called from a modal, never from a list row.
    const page = code(read(REQUEST_FORM))
    assert.equal(/\.map\([\s\S]{0,200}loadPaymentIntent/.test(page), false,
      'loadPaymentIntent must never be called inside a row map')
  })
})

// ── 17. Nothing retired comes back ────────────────────────────────────────────

describe('the retired workflows stay retired', () => {
  test('no Link or Unlink RPC has a caller in either form', () => {
    for (const file of [...BOTH_FORMS, SHARED_FIELDS]) {
      const src = read(file)
      assert.equal(src.includes(".rpc('link_finance_payment_to_order"), false, file)
      assert.equal(src.includes(".rpc('unlink_finance_payment_from_order"), false, file)
    }
  })

  test('the four-target selector is deleted, not merely unused', () => {
    assert.equal(existsSync(join(ROOT, 'src/app/finance/components/PaymentTargetFields.tsx')), false)
    assert.equal(existsSync(join(ROOT, 'src/app/finance/components/PaymentDestinationFields.tsx')), false)
    const targets = read('src/app/finance/paymentTargets.ts')
    assert.equal(/export const PAYMENT_TARGET_OPTIONS/.test(targets), false)
    assert.equal(/export function buildTargetPayload/.test(targets), false)
  })

  test('neither form writes a linkage column', () => {
    for (const file of BOTH_FORMS) {
      const src = modalSource(file)
      for (const column of ['order_request_id', 'order_request_number', 'payment_target_type']) {
        assert.equal(new RegExp(`${column}:`).test(src), false,
          `${file} must not write ${column} — the database derives it`)
      }
    }
    // order_id is the one that matters most: money reaches a record through an
    // allocation, and provenance columns stopped being read in 20261012000000.
    const sql = read(MIGRATION)
    const submit = sql.slice(sql.indexOf('create or replace function public.submit_payment_request'),
      sql.indexOf('comment on function public.submit_payment_request'))
    assert.equal(/insert into public\.finance_payment_requests[\s\S]{0,400}order_id/.test(submit), false,
      'submit_payment_request must set no order_id for any destination')
  })

  test('an intent is never read as an allocation', () => {
    // The migration asserts this against the live catalogue at apply time; this
    // is the statement that the assertion is still in the file.
    const sql = read(MIGRATION)
    assert.ok(sql.includes('INTENT IS NOT ALLOCATION'))
    assert.ok(sql.includes('finance_payment_allocation_intents'))
    assert.ok(/pg_get_functiondef|pg_get_viewdef/.test(sql),
      'the check must read the catalogue, not a list of names somebody maintains')
  })
})

// ── 18. The refusals become sentences ─────────────────────────────────────────

describe('what a refused submission tells the person', () => {
  const CASES: [string, RegExp][] = [
    ['FINANCE_MODULE_CLOSED: …',       /access to Finance/],
    ['PAYMENT_DESTINATION_INVALID: …', /PI Draft, Confirmed Order or Suspense/],
    ['PAYMENT_TARGET_REQUIRED: …',     /Choose the PI Draft or Order/],
    ['PAYMENT_TARGET_FORBIDDEN: …',    /Suspense Entry names no/],
    ['PAYMENT_TARGET_CONVERTED: …',    /now an Order/],
    ['PAYMENT_TARGET_NO_CLIENT: …',    /no customer on file/],
    ['PAYMENT_AMOUNT_INVALID: …',      /positive amount/],
    ['PAYMENT_DATE_REQUIRED: …',       /date the payment was received/],
    ['PAYMENT_MODE_INVALID: …',        /Bank Transfer, Cash, UPI, Cheque or Other/],
  ]

  for (const [raw, expected] of CASES) {
    test(raw.split(':')[0], () => assert.match(paymentEntryErrorMessage(raw), expected))
  }

  test('every code the RPC raises has a sentence here', () => {
    // Otherwise a real refusal degrades to the generic one, which is the failure
    // mode this mapping exists to prevent.
    const sql = read(MIGRATION)
    const submit = sql.slice(sql.indexOf('create or replace function public.submit_payment_request'),
      sql.indexOf('comment on function public.submit_payment_request'))
    const codes = new Set([...submit.matchAll(/raise exception\s*\n?\s*'([A-Z_]+):/g)].map(m => m[1]))
    assert.ok(codes.size >= 8, `expected the refusals to be greppable, found ${codes.size}`)
    for (const c of codes) {
      assert.notEqual(paymentEntryErrorMessage(`${c}: something`),
        paymentEntryErrorMessage('something unrelated'),
        `${c} has no sentence of its own`)
    }
  })

  test('an unrecognised refusal leaks no database text and says nothing was saved', () => {
    const message = paymentEntryErrorMessage(
      'duplicate key value violates unique constraint "finance_payment_allocation_intents_pending_pi_idx"')
    assert.doesNotMatch(message, /constraint|idx|duplicate key/)
    assert.match(message, /Nothing was saved/)
  })

  test('a null refusal is still a sentence', () => {
    assert.match(paymentEntryErrorMessage(null), /could not be submitted/)
    assert.match(paymentEntryErrorMessage(undefined), /could not be submitted/)
  })
})

// ── Correcting a pending request ──────────────────────────────────────────────
//
// A destination chosen at submission is not final: it is corrected here, and the
// row and its intent move together because a protected RPC moves them. What
// these pin is that the form asks the SAME question the creation form asks, and
// that it cannot reach the intent table by any other route.

describe('the correction form', () => {
  test('it offers the same three destinations, from the same component', () => {
    const src = editModalSource()
    assert.ok(src.includes('<PaymentEntryFields'),
      'the Edit form must render the shared destination block, not a list of its own')
    assert.equal(/'pi_draft'[\s\S]{0,120}'confirmed_order'[\s\S]{0,120}'suspense'/.test(src), false,
      'and must not restate the destination list')
  })

  test('it preloads what the request was submitted with', () => {
    const src = editModalSource()
    assert.ok(src.includes('loadPaymentIntent(supabase, r.id)'),
      'the current destination is read from the intent, not guessed from the row')
    assert.ok(src.includes("{ destination: 'suspense', target: null }"),
      'a request with no intent preloads as Suspense — which is what it is')
    assert.ok(src.includes('found.targetId'), 'and a targeted one preloads its target')
  })

  test('nothing may be saved before the destination has been read back', () => {
    const src = editModalSource()
    assert.ok(src.includes('entry !== null && isPaymentEntryComplete(entry)'),
      'a Save landing while the intent was still loading would write Suspense over a targeted request')
  })

  test('the customer is shown, never typed, and never sent', () => {
    const src = editModalSource()
    assert.equal(/label="Client Name"|setClientName|manualClientName/.test(src), false,
      'the correction form must hold no typed customer name')
    assert.equal(src.includes('p_client_name'), false,
      'edit_payment_request has no client-name parameter, on purpose')
    assert.ok(src.includes('clientName: customerDisplayName(r.client_name)'),
      'the read-only line shows the customer the server already derived')
  })

  test('the correction goes through the protected door, and never touches the intent table', () => {
    const src = editModalSource()
    assert.ok(src.includes(".rpc('edit_payment_request'"))
    // No client UPDATE of the payment row survives in this form: two writes
    // that must both land cannot be made atomic from a browser.
    assert.equal(/\.from\('finance_payment_requests'\)[\s\S]{0,80}\.update\(/.test(src), false,
      'the correction must not issue its own UPDATE')
  })

  test('NO surface writes the intent table from the client, anywhere', () => {
    // The table has a SELECT policy and no INSERT, UPDATE or DELETE policy at
    // all, so such a call would fail — but a call that cannot succeed is still a
    // call somebody wrote, and it would read as an authorized path.
    const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
      .split('\n').filter(f => /\.tsx?$/.test(f) && !f.includes('.test.'))
    for (const f of files) {
      const src = code(read(f))
      const at = src.indexOf("from('finance_payment_allocation_intents')")
      if (at < 0) continue
      const after = src.slice(at, at + 200)
      for (const write of ['.insert(', '.update(', '.upsert(', '.delete(']) {
        assert.equal(after.includes(write), false,
          `${f} must not ${write} the intent table — every write is a definer function`)
      }
    }
  })

  test('an approval that won the race collapses the form instead of retrying', () => {
    const src = editModalSource()
    assert.ok(src.includes("PAYMENT_ALREADY_APPROVED"),
      'the losing correction must recognise the conflict it was given')
    assert.ok(src.includes('setStale(true)'),
      'and stop offering a Save that can only fail the same way')
  })

  test('it keeps the same modal protection as the two entry forms', () => {
    const src = editModalSource()
    assert.ok(src.includes('useDiscardGuard'), 'dirty Escape/✕/Cancel must ask')
    assert.ok(src.includes('guard.requestClose'))
    assert.ok(src.includes('<DiscardConfirmation'))
    assert.ok(src.includes('closeOnBackdropClick={false}'), 'the backdrop must stay inert')
    assert.ok(src.includes('submitting.current'), 'a second click must not submit twice')
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB']) {
      assert.equal(src.includes(api), false, `nothing about a correction belongs in ${api}`)
    }
  })

  test('a validation error leaves the form open with everything in it', () => {
    const src = editModalSource()
    const failure = src.slice(src.indexOf('if (rpcError || !data)'))
    assert.ok(failure.includes('setError('), 'it must say what went wrong')
    assert.equal(/onSaved\(\)|onClose\(\)/.test(failure.slice(0, 500)), false,
      'and must not close on a refusal')
  })

  test('proof files are not a correction\'s business', () => {
    const src = editModalSource()
    for (const gone of ['payment_proof_attachments', 'storage', 'PROOF_BUCKET', 'buildProofPath']) {
      assert.equal(src.includes(gone), false,
        `the correction form must not touch ${gone} — an edited request keeps the proof it had`)
    }
  })
})

// ── The intent, converted exactly once ────────────────────────────────────────

describe('the migration keeps intents and allocations apart', () => {
  test('the correction door is protected, definer-safe and customer-free', () => {
    const sql = read(MIGRATION)
    const fn = sql.slice(sql.indexOf('create or replace function public.edit_payment_request'),
      sql.indexOf('comment on function public.edit_payment_request'))
    assert.ok(fn.length > 0, 'edit_payment_request must be in the migration')
    assert.ok(fn.includes('security definer'))
    assert.ok(fn.includes('set search_path = public, pg_temp'))
    assert.equal(fn.includes('p_client_name'), false)
    // The lock comes before every decision, which is what makes the race safe.
    const lock = fn.indexOf('for update')
    const status = fn.indexOf("v_req.status in ('approved_linked', 'approved_unlinked')")
    assert.ok(lock > -1 && status > lock,
      'the status must be read from the LOCKED row, not from a row read earlier')
    assert.ok(sql.includes("grant execute on function public.edit_payment_request"),
      'and it must be callable by a signed-in user')
  })

  test('a correction cancels intents rather than deleting them', () => {
    const sql = read(MIGRATION)
    const fn = sql.slice(sql.indexOf('create or replace function public.edit_payment_request'),
      sql.indexOf('comment on function public.edit_payment_request'))
    assert.ok(fn.includes("set status           = 'cancelled'"),
      'a replaced intent is audit, not litter')
    assert.equal(/delete\s+from\s+public\.finance_payment_allocation_intents/i.test(fn), false,
      'nothing about a correction deletes an intent')
  })

  test('the conversion proves it did not double-count', () => {
    const sql = read(MIGRATION)
    const fn = sql.slice(sql.indexOf('create or replace function public.apply_payment_allocation_intents'),
      sql.indexOf('comment on function public.apply_payment_allocation_intents'))
    assert.ok(fn.includes('INTENT_CONVERSION_DOUBLE_COUNTED'),
      'the post-condition must re-derive the pending-plus-allocated total')
    // …and the allocator's own capacity rule is refused if it ever reads intents.
    assert.ok(sql.includes("'DOUBLE COUNT: the allocation capacity rule reads the intent table"),
      'the apply-time assertion must forbid the arrangement that would double-count')
  })

  test('the correction asserts what it left behind, rather than what it meant to', () => {
    const sql = read(MIGRATION)
    const fn = sql.slice(sql.indexOf('create or replace function public.edit_payment_request'),
      sql.indexOf('comment on function public.edit_payment_request'))
    for (const post of [
      'PAYMENT_EDIT_DUPLICATE_INTENT',
      'PAYMENT_EDIT_SUSPENSE_INTENT',
      'PAYMENT_EDIT_MISSING_INTENT',
      'PAYMENT_EDIT_ALLOCATED',
      'INTENT_EXCEEDS_PAYMENT',
    ]) {
      assert.ok(fn.includes(post), `the correction must assert ${post}`)
    }
  })
})

// ── The privileges the local fixtures could not see ───────────────────────────
//
// 20261013000000 failed its production push in §9f: the intent table's writes
// were revoked from PUBLIC and anon but never from `authenticated`, and a
// Supabase project grants ALL on every table a migration creates. Every local
// SQL suite passed because a bare PostgreSQL grants nothing.
//
// The behavioural proof lives in run_payment_entry_privileges_suite.sh, which
// models the project's default privileges and refuses to run without them.
// These are the cheap source-shape guards that sit in front of it.

describe('the intent table is closed by name, not by omission', () => {
  const grantBlock = () => {
    const sql = read(MIGRATION)
    const from = sql.indexOf('alter table public.finance_payment_allocation_intents enable row level security')
    const to   = sql.indexOf('§3. submit_payment_request')
    assert.ok(from > -1 && to > from, "§2's privilege block could not be located")
    return sql.slice(from, to)
  }

  test('every write privilege is revoked from authenticated BY NAME', () => {
    const block = grantBlock()
    assert.match(block,
      /revoke insert, update, delete, truncate, references, trigger\s*\n\s*on public\.finance_payment_allocation_intents from anon, authenticated;/,
      'revoking from PUBLIC and anon leaves a project default grant untouched')
  })

  test('the form that failed in production is gone', () => {
    const block = grantBlock()
    // `revoke all ... from public, anon` narrows nothing on a Supabase project:
    // it never names the role that actually holds the privileges.
    assert.equal(/revoke all on public\.finance_payment_allocation_intents from public, anon;/.test(block), false,
      'this exact statement is what the production push rejected')
  })

  test('anon is closed outright, SELECT included', () => {
    assert.match(grantBlock(),
      /revoke select on public\.finance_payment_allocation_intents from anon;/)
  })

  test('authenticated keeps the SELECT the RLS policy narrows', () => {
    assert.match(grantBlock(),
      /grant select on public\.finance_payment_allocation_intents to authenticated;/)
  })

  test('the trigger functions are closed too, like every one 20260918000000 created', () => {
    const sql = read(MIGRATION)
    for (const fn of [
      'finance_payment_allocation_intents_enforce_capacity',
      'finance_payment_requests_cancel_intents_on_reject',
    ]) {
      assert.match(sql,
        new RegExp(`revoke execute on function public\\.${fn}\\(\\)\\s*\n\\s*from public, anon, authenticated;`),
        `${fn} must not be executable by a client role`)
    }
  })

  test('the apply-time assertion was widened, not weakened', () => {
    const sql = read(MIGRATION)
    // It used to test three privileges; it now tests all six, and it also
    // requires the SELECT to still be there.
    assert.match(sql, /array\['insert', 'update', 'delete', 'truncate', 'references', 'trigger'\]/,
      'every write privilege must be named in the assertion')
    assert.ok(sql.includes('authenticated must keep SELECT on the intent table'),
      'the read the modals depend on must be asserted too')
    assert.ok(sql.includes('anon must hold no privilege on the intent table'),
      'anon must be checked for every privilege, not only SELECT')
  })

  test('a permanent suite models the project default privileges, and proves it does', () => {
    const runner = read('supabase/tests/run_payment_entry_privileges_suite.sh')
    assert.ok(runner.includes('alter default privileges in schema public'),
      'the suite must model what a Supabase project does before a migration runs')
    assert.ok(runner.includes('grant all on tables    to anon, authenticated, service_role'))
    // The before-probe: the pre-fix grants must still be REFUSED.
    assert.ok(runner.includes('before-probe'),
      'a suite that only proves the fix works cannot say whether it is still needed')
    assert.ok(runner.includes('must be read-only for authenticated'),
      'and the probe must require the refusal to come from the privilege assertion')

    const assertions = read('supabase/tests/payment_entry_privileges_assertions.sql')
    assert.ok(assertions.includes('privilege_model_control'),
      'the fixture must prove ITSELF production-shaped before asserting anything')
    for (const claim of [
      'set local role authenticated',
      'set local role anon',
      "insufficient_privilege",
    ]) {
      assert.ok(assertions.includes(claim),
        `the suite must try the write as the role, not merely read has_table_privilege (${claim})`)
    }
  })

  test('a read-only residue check exists and writes nothing', () => {
    const check = read('supabase/tests/check_113_residue.sql')
    // SQL comments and \echo prose, stripped: the file EXPLAINS what a create
    // or a delete would mean, and explaining is not doing.
    const statements = check
      .split('\n')
      .filter(line => !/^\s*--/.test(line) && !/^\s*\\/.test(line))
      .join('\n')
      .toLowerCase()
    for (const write of ['insert into', 'update ', 'delete from', 'drop ', 'create ', 'alter ', 'truncate']) {
      assert.equal(statements.includes(write), false,
        `the residue check must be read-only — found "${write.trim()}"`)
    }
    assert.ok(check.includes('supabase_migrations.schema_migrations'),
      'it must look at what was actually recorded')
    assert.ok(check.includes('role_table_grants'),
      'and at the privileges, which is where the push failed')
  })
})
