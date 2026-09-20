'use client'

// ── THE ONE EXPENSE FORM ─────────────────────────────────────────────────────
//
// Mounted by both surfaces, so Add and Edit, desktop and phone, quick-entry URL
// and list modal are all literally the same fields with the same rules:
//
//   /finance/expenses          the list's Add / Edit modal
//   /finance/expenses/new      the quick-entry route, saved to a phone's home
//                              screen, which opens straight into this
//
// IT HOLDS NO RULE OF ITS OWN. Validation, the write payload, the payment-mode
// list and the category matching are all in src/lib/finance/expenses.ts; voice
// parsing is in expenseVoice.ts. Everything here is wiring, so the rules can be
// read and tested without a browser, and so the two surfaces cannot drift.
//
// AND IT DECIDES NO AUTHORITY. Whether this form may be opened at all is
// ModuleGuard's answer (finance entry) and the pages'; whether a write lands is
// RLS's, which re-derives finance.create and finance.manage in the database
// (20261220000000). A disabled button here is a courtesy, never a boundary.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mic, Plus } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { AmountInput } from '@/app/finance/components/AmountInput'
import { FinanceModal, useModalScrollLock, useDialogFocus } from '@/app/finance/components/FinanceModalShell'
import { localTodayIso } from '@/lib/finance/piPaymentView'
import type { createClient } from '@/lib/supabase/client'
import {
  EXPENSE_PAYMENT_MODES,
  categoryNameProblem,
  emptyExpenseForm,
  expenseFormFromRow,
  expenseWritePayload,
  findCategoryByName,
  normalizeCategoryName,
  selectableCategories,
  validateExpenseForm,
  type ExpenseCategory,
  type ExpenseFormErrors,
  type ExpenseFormState,
  type ExpenseRow,
} from '@/lib/finance/expenses'
import type { ExpenseHistoryEntry } from '@/lib/finance/expenseCategoryMatch'
import { type ExpenseDraftRow, expenseFormFromDraft } from '@/lib/finance/expenseDrafts'
import { isExpenseDeleted } from '@/lib/finance/expenseDeletion'
import { SmartCategorySuggestions } from './SmartCategorySuggestions'
import {
  VOICE_EXAMPLE_PHRASE,
  VOICE_UNSUPPORTED_MESSAGE,
  parseExpenseSpeech,
  resolveVoiceParse,
} from '@/lib/finance/expenseVoice'
import { useExpenseSpeech } from './useExpenseSpeech'

type Supabase = ReturnType<typeof createClient>

/**
 * THREE MODES, ONE FORM.
 *
 *   add       a fresh expense, written straight to public.expenses.
 *   edit      an existing one, corrected. Never a deleted one — see below.
 *   complete  a Quick Capture being finished. The SAME fields, the same rules
 *             and the same final review; only the write differs, and it differs
 *             because it has to: finalizing goes through
 *             finalize_expense_draft, which creates the expense and marks the
 *             draft in ONE transaction under a row lock.
 */
export type ExpenseFormMode = 'add' | 'edit' | 'complete'

export type ExpenseSaveOutcome = {
  mode: ExpenseFormMode
  /** For the confirmation line: "₹850 to Ramesh". */
  amount: string
  paidTo: string
  /** Set by 'complete': the draft that has just left the Needs Details inbox. */
  draftId?: string
}

export function ExpenseForm({
  supabase,
  userId,
  mode,
  expense,
  draft,
  categories,
  history = [],
  onCategoryCreated,
  onSaved,
  onCancel,
  /** Offered on the list modal, where "add another" is the natural next act. */
  showSaveAndAddAnother = false,
  autoFocus = false,
}: {
  supabase: Supabase
  userId: string
  mode: ExpenseFormMode
  /** The row being corrected. Required when mode is 'edit'. */
  expense?: ExpenseRow | null
  /** The capture being completed. Required when mode is 'complete'. */
  draft?: ExpenseDraftRow | null
  categories: readonly ExpenseCategory[]
  /**
   * Earlier FINALIZED, NON-DELETED expenses, for the Smart suggestion.
   *
   * Defaults to none, so a surface that has no history to give simply gets no
   * suggestions rather than wrong ones. The matcher re-applies the deleted
   * filter itself, and drafts cannot appear here at all — they are a different
   * table and this type does not describe them.
   */
  history?: readonly ExpenseHistoryEntry[]
  onCategoryCreated: (category: ExpenseCategory) => void
  onSaved: (outcome: ExpenseSaveOutcome, andAnother: boolean) => void
  onCancel: () => void
  showSaveAndAddAnother?: boolean
  autoFocus?: boolean
}) {
  // The reader's OWN date, not UTC's — between midnight and 05:30 IST the two
  // differ, and a form that opened on yesterday every morning would be worse
  // than useless for a workflow whose whole point is entering things as they
  // happen. Captured once per mount so the field cannot shift under a typist.
  const todayIso = useMemo(() => localTodayIso(), [])

  // A CAPTURE OPENS THE ORDINARY FORM, PREFILLED. Not a special screen, not a
  // reduced one: every recognised field is filled in and every field — filled
  // or not — remains editable, because a parse that got the payee wrong must be
  // as easy to fix as an empty box is to fill.
  const [form, setForm] = useState<ExpenseFormState>(() =>
    expense ? expenseFormFromRow(expense)
      : draft ? expenseFormFromDraft(draft, todayIso)
        : emptyExpenseForm(todayIso))

  // Validation appears on the first Save attempt, not while somebody is still
  // typing the first character of a field they have just reached.
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [categoryPrefill, setCategoryPrefill] = useState('')

  const errors: ExpenseFormErrors = validateExpenseForm(form, todayIso)
  const shown: ExpenseFormErrors = submitted ? errors : {}
  const valid = Object.keys(errors).length === 0

  const set = <K extends keyof ExpenseFormState>(key: K) => (value: ExpenseFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setSaveError(null)
  }

  const options = useMemo(
    () => selectableCategories(categories, form.categoryId || null),
    [categories, form.categoryId],
  )

  // ── Voice ──────────────────────────────────────────────────────────────────

  const [transcript, setTranscript] = useState<string | null>(null)
  const [voiceNotes, setVoiceNotes] = useState<string[]>([])
  const [suggestedCategory, setSuggestedCategory] = useState<string | null>(null)

  // THE FORM AS IT IS RIGHT NOW, for a callback created when the microphone was
  // pressed and invoked seconds later. A ref rather than a dependency, so a
  // patch merges over what the person is actually looking at — including
  // anything they typed while it was listening — instead of over the snapshot
  // the closure captured.
  const formRef = useRef(form)
  useEffect(() => { formRef.current = form }, [form])
  const categoriesRef = useRef(categories)
  useEffect(() => { categoriesRef.current = categories }, [categories])

  const applyTranscript = useCallback((heard: string) => {
    // Computed OUTSIDE any state updater: React may call an updater twice, and
    // an updater that also sets other state is not a pure function of its input.
    const parsed = parseExpenseSpeech(heard, todayIso)
    const resolved = resolveVoiceParse(parsed, categoriesRef.current, formRef.current)
    setTranscript(heard)
    setVoiceNotes(resolved.needsAttention)
    setSuggestedCategory(resolved.suggestedCategory)
    setForm(prev => ({ ...prev, ...resolved.patch }))
    // The person now reads the filled form and presses Save themselves. There is
    // deliberately no code path from here to a write: financial data is
    // confirmed by a human being, every time.
    setSubmitted(false)
    setSaveError(null)
  }, [todayIso])

  // THE MICROPHONE, from the shared hook — the same feature detection, the same
  // language and the same refusal messages Quick Capture uses. Two copies of
  // this would drift, and the copy that drifted would be the one that quietly
  // gained an auto-submit.
  const voice = useExpenseSpeech(applyTranscript)

  const startListening = () => {
    // Clearing the previous result BEFORE listening, so the transcript on screen
    // always belongs to the press that is happening now.
    if (!voice.listening) {
      setTranscript(null)
      setVoiceNotes([])
      setSuggestedCategory(null)
    }
    voice.toggle()
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  //
  // DOUBLE SUBMISSION IS IMPOSSIBLE, not merely discouraged. The button is
  // disabled while `saving`, and the handler returns immediately on a ref that
  // is set SYNCHRONOUSLY — two taps inside one frame both see the state update
  // that has not rendered yet, and the ref is what actually stops the second.
  const inFlight = useRef(false)

  const submit = async (andAnother: boolean) => {
    setSubmitted(true)
    if (inFlight.current) return
    if (Object.keys(validateExpenseForm(form, todayIso)).length > 0) return

    inFlight.current = true
    setSaving(true)
    setSaveError(null)

    const payload = expenseWritePayload(form)
    const outcome: ExpenseSaveOutcome = {
      mode, amount: payload.amount, paidTo: payload.paid_to, draftId: draft?.id,
    }

    try {
      let error: WriteError | null = null

      if (mode === 'complete') {
        // ── ONE SAFE TRANSACTION ──
        // The expense and the draft's link are written together, or neither is.
        // Two browser writes could not be made one, and every failure between
        // them leaves the worse outcome: a capture still sitting in the inbox
        // beside the expense it already became, waiting to be completed a second
        // time.
        //
        // A RETRY IS HARMLESS. The function locks the draft row; a second call
        // finds it finalized and returns the FIRST call's expense id, writing
        // nothing. Neither a double tap nor a resent request can produce two
        // expenses for one payment.
        const { error: rpcError } = await supabase.rpc('finalize_expense_draft', {
          p_draft_id: draft!.id,
          p_expense_date: payload.expense_date,
          p_amount: payload.amount,
          p_payment_mode: payload.payment_mode,
          p_paid_to: payload.paid_to,
          p_category_id: payload.category_id,
          p_remark: payload.remark,
        })
        error = rpcError
      } else if (mode === 'add') {
        const { error: insertError } = await supabase
          .from('expenses').insert({ ...payload, created_by: userId })
        error = insertError
      } else {
        // updated_by is sent on EVERY correction because the database's WITH
        // CHECK requires it to be the caller — a correction always names its
        // author. created_by is never sent: a trigger refuses to change it.
        //
        // `.is('deleted_at', null)` IS NOT DECORATION. A deleted expense is not
        // editable, and the database's guard trigger refuses this anyway; the
        // predicate means a stale list that still shows an Edit button updates
        // nothing rather than raising an error somebody has to interpret.
        //
        // AND THE ROW IT CHANGED IS READ BACK, because a filtered UPDATE that
        // matches NOTHING is not an error in PostgREST — it succeeds, changes
        // nothing, and would have reported "Expense corrected" over an expense
        // somebody else had just deleted. Asking for the id turns that silent
        // no-op into the one sentence the person needs.
        const { data: updated, error: updateError } = await supabase.from('expenses')
          .update({ ...payload, updated_by: userId })
          .eq('id', expense!.id)
          .is('deleted_at', null)
          .select('id')
        error = updateError
        if (!updateError && (updated?.length ?? 0) === 0) {
          setSaveError(
            'This expense could not be updated — it may have been deleted since this '
            + 'form was opened. Close and refresh the list.')
          return
        }
      }

      if (error) {
        // The values stay EXACTLY as entered — nothing is cleared on a failure,
        // which is the whole reason this sets an error instead of closing.
        setSaveError(friendlyWriteError(error))
        return
      }
      onSaved(outcome, andAnother)
      if (andAnother) {
        setForm(emptyExpenseForm(todayIso))
        setSubmitted(false)
        setTranscript(null)
        setVoiceNotes([])
        setSuggestedCategory(null)
      }
    } catch {
      setSaveError('The expense could not be saved. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  // ── Inline category creation ───────────────────────────────────────────────

  const openAddCategory = (prefill = '') => {
    setCategoryPrefill(prefill)
    setAddingCategory(true)
  }

  const handleCategorySaved = (category: ExpenseCategory) => {
    onCategoryCreated(category)
    // AUTOMATICALLY SELECTED, which is the point of creating it from here.
    setForm(prev => ({ ...prev, categoryId: category.id }))
    setSuggestedCategory(null)
    setVoiceNotes(notes => notes.filter(n => !n.includes('category')))
    setAddingCategory(false)
  }

  // ── A DELETED EXPENSE IS NOT EDITABLE, AND THIS IS THE SECOND OF THREE
  // PLACES THAT SAY SO. The list draws no Edit control on one (mayEditExpense),
  // this refuses to render the fields even if a stale list did, and the
  // database's guard trigger refuses the UPDATE whatever reaches it. Each layer
  // catches a different mistake; none of them is the boundary on its own.
  if (mode === 'edit' && isExpenseDeleted(expense)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div role="alert" style={{
          padding: '12px 14px', borderRadius: '8px',
          border: `1px solid ${colors.border}`, background: colors.raised,
          fontSize: '12.5px', color: colors.secondary, lineHeight: 1.6,
        }}>
          This expense has been deleted, so it can no longer be changed.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} className="boe-btn boe-btn-ghost" style={{ minHeight: '44px', fontSize: '13px' }}>
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* ── WHAT WAS CAPTURED, VERBATIM, WHILE IT IS BEING COMPLETED ──
          The parse in the fields below is a reading of this sentence, and the
          person checking those fields needs the sentence beside them to check
          against. */}
      {mode === 'complete' && draft && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '10px',
          background: colors.raised, padding: '10px 12px',
          fontSize: '12px', color: colors.secondary, lineHeight: 1.5,
        }}>
          <span style={{ color: colors.muted }}>Captured: </span>&ldquo;{draft.raw_text}&rdquo;
        </div>
      )}

      {/* ── Voice ── Drawn only where the browser can actually run it, so a
          phone that cannot is not shown a control that does nothing. */}
      {voice.supported && (
        <div style={{
          border: `1px solid ${colors.border}`, borderRadius: '10px',
          background: colors.raised, padding: '10px 12px',
          display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              onClick={startListening}
              disabled={saving}
              aria-pressed={voice.listening}
              aria-label={voice.listening ? 'Stop listening' : 'Fill this form by voice'}
              className="boe-btn"
              style={{
                display: 'flex', alignItems: 'center', gap: '7px', flexShrink: 0,
                minHeight: '44px', padding: '8px 14px', fontSize: '13px', fontWeight: 600,
                background: voice.listening ? 'rgba(217,79,79,0.10)' : colors.base,
                color: voice.listening ? '#C13030' : colors.primary,
                border: `1px solid ${voice.listening ? 'rgba(217,79,79,0.35)' : colors.borderSoft}`,
              }}
            >
              <Mic size={16} strokeWidth={1.9} />
              {voice.listening ? 'Listening…' : 'Speak'}
            </button>
            <div style={{ fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.45, minWidth: 0 }}>
              {voice.listening
                ? 'Say the expense, then stop.'
                : <>Try: <span style={{ color: colors.secondary }}>&ldquo;{VOICE_EXAMPLE_PHRASE}&rdquo;</span></>}
            </div>
          </div>

          {/* WHAT WAS HEARD, VERBATIM. Shown beside the filled fields so the
              person can see why a field says what it says, and correct it. */}
          {transcript && (
            <div role="status" style={{
              fontSize: '12px', color: colors.secondary, lineHeight: 1.5,
              background: colors.base, border: `1px solid ${colors.border}`,
              borderRadius: '8px', padding: '7px 10px',
            }}>
              <span style={{ color: colors.muted }}>Heard: </span>&ldquo;{transcript}&rdquo;
            </div>
          )}

          {/* WHAT COULD NOT BE IDENTIFIED — highlighted rather than guessed. */}
          {voiceNotes.length > 0 && (
            <ul style={{
              margin: 0, paddingLeft: '18px', fontSize: '11.5px',
              color: '#8A5A00', lineHeight: 1.6,
            }}>
              {voiceNotes.map(note => <li key={note}>{note}</li>)}
            </ul>
          )}

          {/* A SPOKEN CATEGORY THAT DOES NOT EXIST IS A SUGGESTION. It is never
              created, and never selected, until this button is pressed. */}
          {suggestedCategory && (
            <button
              type="button"
              onClick={() => openAddCategory(suggestedCategory)}
              className="boe-btn boe-btn-ghost"
              style={{ alignSelf: 'flex-start', minHeight: '40px', fontSize: '12.5px' }}
            >
              <Plus size={14} strokeWidth={2} style={{ marginRight: '5px', verticalAlign: '-2px' }} />
              Add &ldquo;{suggestedCategory}&rdquo; as a category
            </button>
          )}

          {voice.message && (
            <div role="status" style={{ fontSize: '11.5px', color: colors.tertiary, lineHeight: 1.5 }}>
              {voice.message}
            </div>
          )}
        </div>
      )}

      {/* When the browser has no speech recognition at all, one quiet line — the
          form below is complete and unchanged. */}
      {!voice.supported && (
        <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
          {VOICE_UNSUPPORTED_MESSAGE}
        </div>
      )}

      {/* ── Date and amount, side by side on anything wider than a small phone ── */}
      <div className="expense-form-row">
        <FormField label="Date" htmlFor="expense-date" required error={shown.expenseDate}>
          <input
            id="expense-date"
            className="boe-input"
            type="date"
            value={form.expenseDate}
            max={todayIso}
            disabled={saving}
            aria-invalid={shown.expenseDate ? true : undefined}
            onChange={e => set('expenseDate')(e.target.value)}
            style={{ width: '100%' }}
          />
        </FormField>

        {/* `wrap`: AmountInput draws its own input and takes no id, so the label
            associates with it by containing it. See FormField. */}
        <FormField label="Amount (₹)" wrap required error={shown.amount}>
          {/* The SHARED Finance amount input: Indian grouping on blur, a numeric
              keypad on a phone, and an over-precise figure kept exactly as typed
              and refused rather than rounded. */}
          <AmountInput value={form.amount} onChange={set('amount')} />
        </FormField>
      </div>

      <FormField label="Paid to" htmlFor="expense-paid-to" required error={shown.paidTo}>
        <input
          id="expense-paid-to"
          className="boe-input"
          value={form.paidTo}
          disabled={saving}
          autoFocus={autoFocus}
          maxLength={200}
          autoComplete="off"
          placeholder="Who was paid"
          aria-invalid={shown.paidTo ? true : undefined}
          onChange={e => set('paidTo')(e.target.value)}
          style={{ width: '100%' }}
        />
      </FormField>

      {/* ── PURPOSE, MOVED ABOVE THE CATEGORY ──
          It used to sit last, as an afterthought. It now sits here because it
          is the strongest input the Smart suggestion has: what the money was
          FOR is the question a category answers, and who took it is a weaker
          clue. Somebody who writes "diesel" is handed Fuel before they ever
          reach the picker. The field, its id, its optionality and its 500
          character ceiling are all unchanged — only its position is. */}
      <FormField label="Purpose / remark" htmlFor="expense-remark" error={shown.remark} hint="Optional — helps suggest a category">
        <input
          id="expense-remark"
          className="boe-input"
          value={form.remark}
          disabled={saving}
          maxLength={600}
          autoComplete="off"
          placeholder="What it was for — e.g. diesel for the tempo"
          aria-invalid={shown.remark ? true : undefined}
          onChange={e => set('remark')(e.target.value)}
          style={{ width: '100%' }}
        />
      </FormField>

      {/* ── SMART SUGGESTION ──
          Sits ABOVE the picker, because it is a shortcut to an answer the
          picker below still offers in full. It reads the payee and the remark
          this person has typed, weighs the remark higher, and suggests only
          categories that already exist — unless nothing existing fits, in which
          case it proposes one broad new name and still creates nothing. */}
      <SmartCategorySuggestions
        paidTo={form.paidTo}
        purpose={form.remark}
        categories={categories}
        history={history}
        selectedCategoryId={form.categoryId}
        disabled={saving}
        onPick={id => set('categoryId')(id)}
        onProposeNew={name => openAddCategory(name)}
      />

      <div className="expense-form-row">
        <FormField label="Category" htmlFor="expense-category" required error={shown.categoryId}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
            <select
              id="expense-category"
              className="boe-input"
              value={form.categoryId}
              disabled={saving}
              aria-invalid={shown.categoryId ? true : undefined}
              onChange={e => set('categoryId')(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            >
              <option value="">Choose…</option>
              {options.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => openAddCategory('')}
              disabled={saving}
              className="boe-btn boe-btn-ghost"
              aria-label="Add category"
              style={{ flexShrink: 0, minHeight: '44px', padding: '0 12px', fontSize: '12.5px', whiteSpace: 'nowrap' }}
            >
              <Plus size={14} strokeWidth={2} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
              Add
            </button>
          </div>
        </FormField>

        <FormField label="Payment mode" htmlFor="expense-mode" required error={shown.paymentMode}>
          <select
            id="expense-mode"
            className="boe-input"
            value={form.paymentMode}
            disabled={saving}
            aria-invalid={shown.paymentMode ? true : undefined}
            onChange={e => set('paymentMode')(e.target.value)}
            style={{ width: '100%' }}
          >
            {EXPENSE_PAYMENT_MODES.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </FormField>
      </div>

      {saveError && (
        <div role="alert" style={{
          padding: '10px 12px', borderRadius: '8px',
          background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5,
        }}>
          {saveError}
        </div>
      )}

      {/* A summary the moment Save is refused, so a field scrolled out of view
          is not the reason somebody presses the button twice. */}
      {submitted && !valid && !saveError && (
        <div role="alert" style={{ fontSize: '12px', color: '#C13030', lineHeight: 1.5 }}>
          Check the highlighted fields above.
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="boe-btn boe-btn-ghost"
          style={{ minHeight: '44px', fontSize: '13px' }}
        >
          Cancel
        </button>
        {showSaveAndAddAnother && mode === 'add' && (
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={saving}
            className="boe-btn boe-btn-ghost"
            style={{ minHeight: '44px', fontSize: '13px' }}
          >
            Save &amp; add another
          </button>
        )}
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={saving}
          className="boe-btn boe-btn-primary"
          style={{ minHeight: '44px', fontSize: '13px', minWidth: '120px' }}
        >
          {/* 'complete' says "Save expense" like 'add' does, and deliberately:
              completing a capture RECORDS AN EXPENSE, and a different word
              would suggest something less final than it is. */}
          {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Save expense'}
        </button>
      </div>

      {addingCategory && (
        <AddCategoryModal
          supabase={supabase}
          userId={userId}
          categories={categories}
          initialName={categoryPrefill}
          onClose={() => setAddingCategory(false)}
          onSaved={handleCategorySaved}
        />
      )}
    </div>
  )
}

// ── One field ────────────────────────────────────────────────────────────────

/**
 * One labelled field.
 *
 * TWO WAYS TO ASSOCIATE THE LABEL, and the second is not a shortcut.
 * `htmlFor` is the ordinary case, where this component knows the control's id.
 * `wrap` is for the AMOUNT: the shared Finance AmountInput draws its own
 * <input> and takes no id, so the only correct association is an IMPLICIT one —
 * the control nested inside its <label>. That is valid HTML and every screen
 * reader honours it, and it is far better than a `for` pointing at an id that
 * does not exist, which is what a careless version of this would have shipped.
 */
function FormField({
  label, htmlFor, wrap, required, error, hint, children,
}: {
  label: string
  htmlFor?: string
  /** Render the whole field AS the label, associating the control implicitly. */
  wrap?: boolean
  required?: boolean
  error?: string
  hint?: string
  children: React.ReactNode
}) {
  const Container = wrap ? 'label' : 'div'
  const labelText = (
    <>
      {label}
      {required && <span style={{ color: colors.red, marginLeft: '2px' }} aria-hidden="true">*</span>}
      {hint && <span style={{ textTransform: 'none', letterSpacing: 0, marginLeft: '6px', fontWeight: 500 }}>{hint}</span>}
    </>
  )
  const labelStyle: React.CSSProperties = {
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  return (
    <Container style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      {wrap
        ? <span style={labelStyle}>{labelText}</span>
        : <label htmlFor={htmlFor} style={labelStyle}>{labelText}</label>}
      {children}
      {error && (
        <div role="alert" style={{ fontSize: '12px', color: '#C13030', lineHeight: 1.4 }}>
          {error}
        </div>
      )}
    </Container>
  )
}

// ── Inline category creation ─────────────────────────────────────────────────
//
// A NAME THAT ALREADY EXISTS IS SELECTED, NOT DUPLICATED. The check runs here
// against the list in hand, and again in the database through the unique index
// on lower(name) — so two people creating "Diesel" at the same moment produce
// one row, and the loser of that race is handed the existing one rather than an
// error nobody can read.

function AddCategoryModal({
  supabase, userId, categories, initialName, onClose, onSaved,
}: {
  supabase: Supabase
  userId: string
  categories: readonly ExpenseCategory[]
  initialName: string
  onClose: () => void
  onSaved: (category: ExpenseCategory) => void
}) {
  const [name, setName] = useState(initialName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inFlight = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const save = async () => {
    if (inFlight.current) return
    const problem = categoryNameProblem(name)
    if (problem) { setError(problem); return }

    const clean = normalizeCategoryName(name)

    // Already here, whatever its case — pick it rather than making a second one.
    const existing = findCategoryByName(categories, clean)
    if (existing) {
      setNotice(`"${existing.name}" already exists — selected.`)
      onSaved(existing)
      return
    }

    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const { data, error: dbError } = await supabase
        .from('expense_categories')
        .insert({ name: clean, created_by: userId })
        .select('id, name, is_active')
        .single()

      if (dbError) {
        // 23505 is the unique index on lower(name): somebody else created this
        // name between the check above and the insert. Read it back and select
        // it — the person asked for a category with this name and now there is
        // one, which is the outcome they wanted.
        if (dbError.code === '23505') {
          const { data: found } = await supabase
            .from('expense_categories')
            .select('id, name, is_active')
            .ilike('name', clean)
            .limit(1)
            .maybeSingle()
          if (found) { onSaved(found as ExpenseCategory); return }
          setError('A category with this name already exists.')
          return
        }
        setError(writeCategoryError(dbError))
        return
      }
      onSaved(data as ExpenseCategory)
    } catch {
      setError('The category could not be saved. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <FinanceModal title="Add category" onClose={onClose} width="380px" closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <label htmlFor="new-category-name" className="boe-input-label">Category name</label>
        <input
          id="new-category-name"
          ref={inputRef}
          className="boe-input"
          value={name}
          disabled={saving}
          maxLength={80}
          autoComplete="off"
          placeholder="e.g. Diesel"
          aria-invalid={error ? true : undefined}
          onChange={e => { setName(e.target.value); setError(null) }}
          onKeyDown={e => { if (e.key === 'Enter' && !saving) { e.preventDefault(); void save() } }}
        />
        {error && (
          <div role="alert" style={{ fontSize: '12px', color: '#C13030', lineHeight: 1.4 }}>{error}</div>
        )}
        {notice && (
          <div role="status" style={{ fontSize: '12px', color: colors.tertiary, lineHeight: 1.4 }}>{notice}</div>
        )}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            type="button" onClick={onClose} disabled={saving}
            className="boe-btn boe-btn-ghost" style={{ minHeight: '44px', fontSize: '13px' }}
          >
            Cancel
          </button>
          <button
            type="button" onClick={() => void save()} disabled={saving}
            className="boe-btn boe-btn-primary" style={{ minHeight: '44px', fontSize: '13px' }}
          >
            {saving ? 'Saving…' : 'Save category'}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}

// ── Database errors, in words a person can act on ────────────────────────────

type WriteError = { code?: string; message?: string }

/**
 * The two failures worth naming are the ones a person can do something about:
 * RLS refused the write, and a CHECK refused the values. Everything else is
 * reported as itself rather than paraphrased into a guess.
 */
export function friendlyWriteError(error: WriteError): string {
  if (error.code === '42501') {
    return 'You do not have permission to record or correct an expense. Ask an administrator for Finance access.'
  }
  if (error.code === '23514') {
    return 'The database refused these values. Check the amount, the payee and the date.'
  }
  if (error.code === '23503') {
    return 'That category no longer exists. Choose another one.'
  }
  return error.message || 'The expense could not be saved. Try again.'
}

function writeCategoryError(error: WriteError): string {
  if (error.code === '42501') {
    return 'You do not have permission to add a category.'
  }
  if (error.code === '23514') {
    return 'That name cannot be used. Use up to 60 characters.'
  }
  return error.message || 'The category could not be saved. Try again.'
}

// Re-exported so the quick-entry page can lock the background scroll with the
// same hook every Finance modal uses, without importing the shell directly.
export { useModalScrollLock, useDialogFocus }
