/**
 * QUICK CAPTURE AND NEEDS DETAILS — the rules, and the schema behind them.
 *
 * As with expenseDeletion.test.ts, both halves live here so they cannot
 * disagree: the pure functions the screens call, and source assertions over
 * 20261222000000, because the database is what actually decides.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPENSE_PAYMENT_MODE_VALUES } from './expenses'
import {
  DISCARD_DRAFT_EXPLANATION,
  DRAFT_RAW_TEXT_MAX,
  EXPENSE_DRAFT_STATUSES,
  NEEDS_DETAILS_BLURB,
  NEEDS_DETAILS_LABEL,
  QUICK_CAPTURE_SAVED_MESSAGE,
  draftDateWasAssumed,
  draftMissingFields,
  draftMissingSummary,
  draftTextProblem,
  draftWritePayload,
  expenseFormFromDraft,
  isDraftPending,
  isExpenseDraftStatus,
  mayActOnDraft,
  mayDiscardDraft,
  mayFinalizeDraft,
  pendingDraftCount,
  type ExpenseDraftRow,
} from './expenseDrafts'

/**
 * A migration, with its line endings normalized.
 *
 * core.autocrlf is on in this repository, so a checked-out .sql file carries
 * CRLF on Windows and LF on CI. Several assertions below pin a multi-line shape
 * — a policy's `as restrictive` clause, the state CHECK's three branches — and
 * without this they would pass on one machine and fail on the other. The same
 * normalization expenseSurfaces.test.ts applies for the same reason.
 */
const readSql = (p: string) =>
  readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = readSql('supabase/migrations/20261222000000_expense_lifecycle.sql')
const PHASE_ONE = readSql('supabase/migrations/20261220000000_finance_expenses.sql')
/** The follow-up that takes finalize_expense_draft away from anon. */
const GRANT_FIX = readSql('supabase/migrations/20261223000000_finalize_expense_draft_is_not_for_anon.sql')

const TODAY = '2026-09-20'

const draft = (over: Partial<ExpenseDraftRow> = {}): ExpenseDraftRow => ({
  id: 'draft-1',
  raw_text: '500 cash to Ramesh for diesel',
  parsed_date: TODAY,
  parsed_amount: '500',
  parsed_paid_to: 'Ramesh',
  parsed_payment_mode: 'cash',
  parsed_remark: 'diesel',
  category_id: null,
  status: 'pending',
  expense_id: null,
  finalized_at: null,
  discarded_by: null,
  discarded_at: null,
  created_by: 'author',
  created_at: '2026-09-20T09:00:00Z',
  updated_at: '2026-09-20T09:00:00Z',
  ...over,
})

// ── Saving a capture ─────────────────────────────────────────────────────────

describe('THE ONLY REQUIREMENT IS THAT SOMETHING WAS SAID', () => {
  test('an empty capture is refused', () => {
    assert.equal(draftTextProblem(''), 'Type or say what was paid, then save it.')
    assert.equal(draftTextProblem('   '), 'Type or say what was paid, then save it.')
  })

  test('and nothing else is required — not an amount, not a payee, not a category', () => {
    assert.equal(draftTextProblem('750 for factory work'), null)
    assert.equal(draftTextProblem('something about a payment'), null)
    assert.equal(draftTextProblem('x'), null,
      'a single character is a record of something; an empty box is a record of nothing')
  })

  test('a capture longer than the column allows is refused rather than truncated', () => {
    assert.equal(draftTextProblem('a'.repeat(DRAFT_RAW_TEXT_MAX)), null)
    assert.ok(draftTextProblem('a'.repeat(DRAFT_RAW_TEXT_MAX + 1))?.includes('500'))
  })
})

describe('what one line of text becomes', () => {
  test('the four example sentences, each read as far as it can be', () => {
    const a = draftWritePayload('Paid 1000 rupees to Vikram for machine repair.', TODAY)
    assert.equal(a.parsed_amount, '1000')
    assert.equal(a.parsed_paid_to, 'Vikram')
    assert.equal(a.parsed_remark, 'machine repair')
    assert.equal(a.parsed_date, TODAY)

    const b = draftWritePayload('500 cash to Ramesh for diesel.', TODAY)
    assert.equal(b.parsed_amount, '500')
    assert.equal(b.parsed_paid_to, 'Ramesh')
    assert.equal(b.parsed_payment_mode, 'cash')
    assert.equal(b.parsed_remark, 'diesel')

    const c = draftWritePayload('Paid Mohan 2200 yesterday.', TODAY)
    assert.equal(c.parsed_amount, '2200')
    assert.equal(c.parsed_date, '2026-09-19', 'yesterday, from the reader\'s own date')

    const d = draftWritePayload('750 for factory work.', TODAY)
    assert.equal(d.parsed_amount, '750')
    assert.equal(d.parsed_paid_to, null, 'no payee was said, so none is invented')
    assert.equal(d.parsed_remark, 'factory work',
      'the purpose is kept even though it names no category — the suggestion needs it later')
  })

  test('NOTHING IS INVENTED — an unheard field is null', () => {
    const payload = draftWritePayload('something happened', TODAY)
    assert.equal(payload.parsed_amount, null)
    assert.equal(payload.parsed_paid_to, null)
    assert.equal(payload.parsed_payment_mode, null)
    assert.equal(payload.category_id, null)
  })

  test('A CAPTURE NEVER PICKS A CATEGORY', () => {
    // Matching happens at COMPLETION time, against the categories that exist
    // then — which may not be the ones that existed when it was spoken.
    for (const text of ['500 to Ramesh for diesel', 'tea for the staff', '1000 for transport']) {
      assert.equal(draftWritePayload(text, TODAY).category_id, null)
    }
  })

  test('THE DATE IS THE ONE ASSUMPTION, and the UI can tell that it is one', () => {
    assert.equal(draftWritePayload('750 for factory work', TODAY).parsed_date, TODAY)
    assert.equal(draftDateWasAssumed('750 for factory work', TODAY), true)
    assert.equal(draftDateWasAssumed('Paid Mohan 2200 yesterday', TODAY), false)
  })

  test('the transcript is stored trimmed and verbatim', () => {
    assert.equal(draftWritePayload('  500 to Ramesh  ', TODAY).raw_text, '500 to Ramesh')
  })

  test('a parsed mode is always one the expense form can render', () => {
    const payload = draftWritePayload('500 by UPI to Ramesh', TODAY)
    assert.ok(EXPENSE_PAYMENT_MODE_VALUES.includes(payload.parsed_payment_mode as never))
  })
})

// ── What is missing ──────────────────────────────────────────────────────────

describe('a draft says what it is missing, before anybody opens it', () => {
  test('a complete capture is missing only its category', () => {
    assert.deepEqual(draftMissingFields(draft()), ['Category'])
  })

  test('A MISSING AMOUNT IS SAID PLAINLY — it is the one nobody will remember', () => {
    assert.ok(draftMissingFields(draft({ parsed_amount: null })).includes('Amount'))
    assert.ok(draftMissingSummary(draftMissingFields(draft({ parsed_amount: null })))
      .includes('Amount'))
  })

  test('every required field of a finalized expense is checked', () => {
    assert.deepEqual(
      draftMissingFields(draft({
        parsed_amount: null, parsed_paid_to: null, parsed_payment_mode: null, category_id: null,
      })),
      ['Amount', 'Paid to', 'Payment mode', 'Category'])
  })

  test('an unknown payment mode counts as missing, not as a value', () => {
    assert.ok(draftMissingFields(draft({ parsed_payment_mode: 'bitcoin' })).includes('Payment mode'))
  })

  test('THE DATE IS NEVER MISSING, and neither is the remark', () => {
    const missing = draftMissingFields(draft({ parsed_remark: null }))
    assert.equal(missing.includes('Date'), false, 'a draft always has one')
    assert.equal(missing.includes('Remark'), false, 'it is optional on a finalized expense')
  })

  test('"nothing missing" is a real and common answer', () => {
    assert.deepEqual(draftMissingFields(draft({ category_id: 'cat-1' })), [])
    assert.equal(draftMissingSummary([]), 'Nothing missing — review and save it.')
  })

  test('the summary reads as a sentence', () => {
    assert.equal(draftMissingSummary(['Amount']), 'Missing: Amount')
    assert.equal(draftMissingSummary(['Amount', 'Category']), 'Missing: Amount and Category')
    assert.equal(draftMissingSummary(['Amount', 'Paid to', 'Category']),
      'Missing: Amount, Paid to and Category')
  })
})

// ── The inbox ────────────────────────────────────────────────────────────────

describe('the Needs Details inbox', () => {
  test('IT IS CALLED NEEDS DETAILS, NOT APPROVAL', () => {
    assert.equal(NEEDS_DETAILS_LABEL, 'Needs Details')
    const words = NEEDS_DETAILS_LABEL + NEEDS_DETAILS_BLURB + QUICK_CAPTURE_SAVED_MESSAGE
      + DISCARD_DRAFT_EXPLANATION
    assert.equal(/approv|reject|reviewer|pending approval/i.test(words), false,
      'nobody else looks at these: a capture waits for its own author')
  })

  test('the badge counts only what is waiting', () => {
    assert.equal(pendingDraftCount([]), 0)
    assert.equal(pendingDraftCount([draft(), draft({ id: 'b' })]), 2)
    assert.equal(pendingDraftCount([
      draft(),
      draft({ id: 'b', status: 'finalized' }),
      draft({ id: 'c', status: 'discarded' }),
    ]), 1, 'a finalized draft became an expense and a discarded one was not wanted')
  })

  test('a finalized capture leaves the inbox but stays in the table', () => {
    const done = draft({ status: 'finalized', expense_id: 'exp-9', finalized_at: '2026-09-20T12:00:00Z' })
    assert.equal(isDraftPending(done), false)
    assert.equal(done.raw_text, '500 cash to Ramesh for diesel',
      'the transcript survives for audit')
    assert.equal(done.expense_id, 'exp-9')
  })
})

// ── Completing one ───────────────────────────────────────────────────────────

describe('completing a capture opens the ordinary form, prefilled', () => {
  test('every recognised field is carried across', () => {
    assert.deepEqual(expenseFormFromDraft(draft(), TODAY), {
      expenseDate: TODAY,
      amount: '500',
      paymentMode: 'cash',
      paidTo: 'Ramesh',
      categoryId: '',
      remark: 'diesel',
    })
  })

  test('AN UNRECOGNISED FIELD OPENS EMPTY — it is not guessed on the way in either', () => {
    const form = expenseFormFromDraft(draft({
      parsed_amount: null, parsed_paid_to: null, parsed_remark: null,
    }), TODAY)
    assert.equal(form.amount, '')
    assert.equal(form.paidTo, '')
    assert.equal(form.remark, '')
  })

  test('an unknown stored mode falls back to the form default, and the draft keeps what was said', () => {
    const row = draft({ parsed_payment_mode: 'bitcoin' })
    assert.equal(expenseFormFromDraft(row, TODAY).paymentMode, 'cash')
    assert.equal(row.parsed_payment_mode, 'bitcoin', 'the row is not rewritten')
  })

  test('only a PENDING capture can be completed or discarded', () => {
    assert.equal(mayFinalizeDraft(draft()), true)
    assert.equal(mayFinalizeDraft(draft({ status: 'finalized' })), false)
    assert.equal(mayFinalizeDraft(draft({ status: 'discarded' })), false)
    assert.equal(mayDiscardDraft(draft()), true)
    assert.equal(mayDiscardDraft(draft({ status: 'finalized' })), false)
  })

  test('only its author, or a holder of the protected finance.manage, may act on it', () => {
    assert.equal(mayActOnDraft(draft(), { userId: 'author', canManageFinance: false }), true)
    assert.equal(mayActOnDraft(draft(), { userId: 'other', canManageFinance: true }), true)
    assert.equal(mayActOnDraft(draft(), { userId: 'other', canManageFinance: false }), false)
    assert.equal(mayActOnDraft(draft(), { userId: null, canManageFinance: false }), false)
  })
})

describe('the three statuses', () => {
  test('and only those three', () => {
    assert.deepEqual([...EXPENSE_DRAFT_STATUSES], ['pending', 'finalized', 'discarded'])
    assert.equal(isExpenseDraftStatus('pending'), true)
    assert.equal(isExpenseDraftStatus('approved'), false)
    assert.equal(isExpenseDraftStatus('deleted'), false)
    assert.equal(isExpenseDraftStatus(null), false)
  })
})

// ── The database ─────────────────────────────────────────────────────────────

describe('THE DRAFTS TABLE IS SEPARATE, AND PHASE 1 IS UNWEAKENED', () => {
  const sql = MIGRATION.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')

  test('NOT ONE CONSTRAINT ON public.expenses IS RELAXED', () => {
    // The whole reason drafts are a second table. Every NOT NULL and every
    // CHECK that protects a finalized expense is still exactly where Phase 1
    // put it, and this migration contains no statement that could move one.
    assert.equal(/alter table public\.expenses[\s\S]*?alter column/i.test(sql), false,
      'no column of public.expenses is made nullable')
    assert.equal(/drop constraint/i.test(sql), false, 'no constraint is dropped')
    for (const constraint of [
      'expenses_amount_valid', 'expenses_paid_to_trimmed',
      'expenses_remark_not_blank', 'expenses_payment_mode_known',
    ]) {
      assert.ok(PHASE_ONE.includes(constraint), `${constraint} is a Phase 1 constraint`)
      assert.equal(sql.includes(constraint), false,
        `${constraint} must not be touched by phase 2`)
    }
  })

  test('the draft columns are nullable BECAUSE THEY ARE MEANT TO BE', () => {
    assert.ok(MIGRATION.includes('parsed_amount numeric(14,2),'))
    assert.ok(MIGRATION.includes('parsed_paid_to text,'))
    assert.ok(MIGRATION.includes('parsed_payment_mode text,'))
    // Except the two that cannot be: the transcript, and the date.
    assert.ok(MIGRATION.includes('raw_text text not null'))
    assert.ok(MIGRATION.includes('parsed_date date not null default current_date'))
    assert.ok(MIGRATION.includes('created_by uuid not null references public.users(id)'))
  })

  test('a capture with no text cannot exist', () => {
    assert.ok(MIGRATION.includes('expense_drafts_raw_text_present'))
    assert.ok(MIGRATION.includes("raw_text = btrim(raw_text) and btrim(raw_text) <> ''"))
  })

  test('a parsed amount, if present, is as real as a finalized one', () => {
    assert.ok(MIGRATION.includes("parsed_amount <> 'NaN'::numeric and parsed_amount > 0"))
    assert.ok(MIGRATION.includes('parsed_amount = round(parsed_amount, 2)'))
  })

  test('THE STATUS AND ITS EVIDENCE CANNOT DISAGREE', () => {
    assert.ok(MIGRATION.includes('expense_drafts_state_consistent'))
    // finalized ⇒ an expense and a time; pending ⇒ neither; discarded ⇒ who and when.
    assert.ok(MIGRATION.includes("(status = 'finalized'\n      and expense_id is not null and finalized_at is not null"))
    assert.ok(MIGRATION.includes("(status = 'discarded'\n      and expense_id is null and finalized_at is null\n      and discarded_by is not null and discarded_at is not null"))
  })

  test('NO DELETE POLICY AND NO DELETE GRANT ON THE DRAFTS TABLE EITHER', () => {
    assert.equal(/create policy expense_drafts[\s\S]{0,120}for delete/i.test(MIGRATION), false)
    assert.ok(MIGRATION.includes('grant select, insert, update on public.expense_drafts to authenticated'))
    assert.ok(MIGRATION.includes('revoke delete on public.expense_drafts from anon, authenticated'))
  })

  test('the restrictive Finance gate applies to drafts as it does to expenses', () => {
    assert.ok(MIGRATION.includes('expense_drafts_module_entry_gate'))
    assert.ok(MIGRATION.includes("as restrictive for all to authenticated\n  using (public.module_entry_open('finance'))"))
  })

  test('DRAFT TEXT IS NOT READABLE BY EVERY AUTHENTICATED EMPLOYEE', () => {
    // Three SELECT policies, each conditional: admin, finance.view_all, own.
    assert.ok(MIGRATION.includes('expense_drafts_admin_select'))
    assert.ok(MIGRATION.includes('expense_drafts_view_all_select'))
    assert.ok(MIGRATION.includes('expense_drafts_own_select'))
    assert.equal(/create policy expense_drafts_[a-z_]*select[\s\S]{0,200}using \(true\)/.test(MIGRATION), false,
      'no unconditional SELECT')
    // And the migration asserts the same thing about itself.
    assert.ok(MIGRATION.includes('an unconditional SELECT policy exists on public.expense_drafts'))
  })

  test('capturing takes the same authority as recording an expense', () => {
    assert.ok(MIGRATION.includes("and public.actor_has_module_permission('finance', 'create')"))
    assert.ok(MIGRATION.includes("and status = 'pending'"))
    assert.ok(MIGRATION.includes('and expense_id is null'))
  })

  test('acting on somebody else\'s capture takes the protected finance.manage', () => {
    assert.ok(MIGRATION.includes("expense_drafts_manage_update"))
    assert.ok(MIGRATION.includes("public.actor_has_module_permission('finance', 'manage')"))
  })

  test('THE TRANSCRIPT AND ITS AUTHOR ARE FROZEN, for the service role too', () => {
    assert.ok(MIGRATION.includes('A capture cannot change who recorded it'))
    assert.ok(MIGRATION.includes('A capture cannot change what was said'))
  })
})

describe('A DRAFT CANNOT BE FINALIZED TWICE — three independent guards', () => {
  test('1. THE ROW LOCK makes concurrent calls sequential', () => {
    assert.ok(MIGRATION.includes('from public.expense_drafts\n  where id = p_draft_id\n  for update'))
  })

  test('2. A RETRY IS ANSWERED WITH THE FIRST CALL\'S EXPENSE, and writes nothing', () => {
    assert.ok(MIGRATION.includes("if v_draft.status = 'finalized' then"))
    assert.ok(MIGRATION.includes("'created', false"))
    assert.ok(MIGRATION.includes("'expense_id', v_draft.expense_id"))
  })

  test('3. THE UNIQUE INDEX makes two expenses for one draft unrepresentable', () => {
    assert.ok(MIGRATION.includes('create unique index if not exists expense_drafts_expense_id_key'))
    assert.ok(MIGRATION.includes('on public.expense_drafts (expense_id)\n  where expense_id is not null'))
  })

  test('and a terminal capture is frozen, so it cannot be reopened either', () => {
    assert.ok(MIGRATION.includes("if old.status <> 'pending' then"))
    assert.ok(MIGRATION.includes('This capture has already been %'))
  })
})

describe('the finalize door creates EXACTLY ONE expense, safely', () => {
  test('one transaction: the expense and the link, or neither', () => {
    assert.ok(MIGRATION.includes('insert into public.expenses ('))
    assert.ok(MIGRATION.includes('update public.expense_drafts\n  set status = \'finalized\''))
  })

  test('IT IS NOT AN EASIER DOOR — it re-derives every authority itself', () => {
    assert.ok(MIGRATION.includes("if not public.module_entry_open('finance') then"))
    assert.ok(MIGRATION.includes("if not public.actor_has_module_permission('finance', 'create') then"))
    assert.ok(MIGRATION.includes("and not public.actor_has_module_permission('finance', 'manage') then"))
    assert.ok(MIGRATION.includes('You must be signed in to complete a capture'))
  })

  test('created_by COMES FROM auth.uid() AND CANNOT BE FORGED', () => {
    assert.ok(MIGRATION.includes('v_actor uuid := auth.uid()'))
    // No p_created_by parameter exists to pass one in.
    assert.equal(/p_created_by/.test(MIGRATION), false)
  })

  test('the expense\'s own CHECK constraints are the only definition of valid', () => {
    // The function does not restate the amount rules: one definition, in the
    // table, whichever door writes.
    assert.equal(/p_amount <= 0|p_amount = round/.test(MIGRATION), false)
  })

  test('a discarded capture cannot be completed', () => {
    assert.ok(MIGRATION.includes('This capture was discarded and cannot be completed'))
  })

  test('only signed-in callers may execute it', () => {
    assert.ok(MIGRATION.includes('revoke all on function public.finalize_expense_draft'))
    assert.ok(MIGRATION.includes('grant execute on function public.finalize_expense_draft'))
    assert.ok(MIGRATION.includes('to authenticated;'))
  })

  test('AND anon CANNOT EXECUTE IT — the grant, not only the body, says so', () => {
    // 20261222000000 revoked `from public`, which removes the PSEUDO-ROLE's
    // grant and NOT the explicit one Supabase's default privileges hand to
    // anon when a function is created. The post-deployment schema dump caught
    // it: the function shipped granted to anon, unlike every comparable
    // Finance RPC. Nothing was at risk — an anon caller is refused by the
    // function's first line, by module_entry_open, by finance.create and by
    // RLS on both tables — but "unreachable" is a property of today's body and
    // "cannot execute" is a property of the database.
    assert.ok(GRANT_FIX.includes('from public, anon, authenticated'),
      'the revoke must name the roles the bootstrap actually granted')
    assert.ok(GRANT_FIX.includes("has_function_privilege('anon'"),
      'and the migration asserts the outcome rather than assuming it')
    assert.ok(GRANT_FIX.includes('anon can still execute finalize_expense_draft'))
    // It tightens a grant and nothing else: no CREATE FUNCTION, no DML.
    // Read with the comments stripped — the header explains at length that the
    // file contains no CREATE FUNCTION, and the words it uses to say so must
    // not be mistaken for the statement itself.
    const sql = GRANT_FIX.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
    assert.equal(/create (or replace )?function/i.test(sql), false,
      'the deployed body is not redefined')
    assert.equal(/\b(insert into|delete from|alter table|drop\s+\w)\b/i.test(sql), false,
      'no DML and no schema change')
  })
})

describe('A DRAFT IS NOT AN EXPENSE — structurally, not by convention', () => {
  test('nothing that reads expenses reads the drafts table', () => {
    // The one link runs the other way: expense_id, set once, after the fact.
    assert.ok(MIGRATION.includes('expense_drafts_expense_fk references public.expenses(id)'))
    assert.equal(/alter table public\.expenses[\s\S]{0,300}expense_drafts/.test(MIGRATION), false,
      'public.expenses gains no reference to a draft')
  })

  test('and nothing is seeded into it', () => {
    assert.ok(MIGRATION.includes('expected no seeded drafts, found %'))
  })
})
