'use client'

// ── /finance/expenses/new — THE QUICK-ENTRY ROUTE ────────────────────────────
//
// The URL somebody saves to a phone's home screen, and the target of the
// Add Expense manifest shortcut and the launcher's Quick Add Expense action.
// It opens STRAIGHT INTO AN ENTRY SURFACE: no list read, no counts, no
// navigation through Finance first. The only things it waits for are the
// session, the person's Finance capabilities and the category list the picker
// needs.
//
// ── THE CHOICE IS THE FIRST THING ON THE SCREEN, AND IT COSTS NO TAP ───────
//
// Two ways in, both visible at once:
//
//   Quick Capture        one box and a microphone. Say what was paid, tap Save
//                        for later, done — three actions from the home screen,
//                        which is the whole point of the shortcut.
//   Full Expense Entry   every field, the Smart suggestion and a final review,
//                        for when the details are actually known.
//
// QUICK CAPTURE IS SELECTED ON ARRIVAL, deliberately. A chooser screen would
// make the fast path FOUR taps instead of three and would be the one screen
// somebody hits every single time while standing next to a running tempo. The
// alternative is right there beside it, one tap away, and the segmented control
// makes both visible rather than hiding either.
//
// ── IT IS NOT A SECOND FORM ────────────────────────────────────────────────
//
// Full Expense Entry mounts the same ExpenseForm the list's Add modal does, with
// the same rules, the same validation and the same voice entry, so the two can
// never drift. Quick Capture mounts the same QuickCapture the list's tab does.
//
// ── IT IS NOT A SECOND DOOR EITHER ─────────────────────────────────────────
//
// It sits inside src/app/finance/layout.tsx, so ModuleGuard decides Finance
// entry before it mounts — typing this URL without Finance access lands on
// /coming-soon, exactly as /finance does — and every write is re-authorized by
// RLS in the database.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { colors } from '@/lib/tokens'
import { createClient } from '@/lib/supabase/client'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import { FinanceRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import { deriveFinanceCapabilities, NO_FINANCE_CAPABILITIES } from '@/lib/permissions/finance'
import { formatMoney } from '@/lib/finance/piPaymentView'
import type { UserProfile } from '@/lib/types'
import type { ExpenseCategory } from '@/lib/finance/expenses'
import type { ExpenseHistoryEntry } from '@/lib/finance/expenseCategoryMatch'
import {
  QUICK_CAPTURE_LABEL,
  QUICK_CAPTURE_SAVED_MESSAGE,
  draftMissingFields,
  draftMissingSummary,
  type ExpenseDraftRow,
} from '@/lib/finance/expenseDrafts'
import { ExpenseForm, type ExpenseSaveOutcome } from '../ExpenseForm'
import { QuickCapture } from '../QuickCapture'

export const FULL_ENTRY_LABEL = 'Full Expense Entry'
export const CAPTURE_ANOTHER_LABEL = 'Capture another'
export const COMPLETE_NOW_LABEL = 'Complete now'

type EntryMode = 'capture' | 'full'

export default function QuickAddExpensePage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [caps, setCaps] = useState(NO_FINANCE_CAPABILITIES)
  const [categories, setCategories] = useState<ExpenseCategory[]>([])

  /** The fast path by default — see the header. */
  const [entryMode, setEntryMode] = useState<EntryMode>('capture')

  /** The last full-form save, held so the confirmation can name it. */
  const [saved, setSaved] = useState<ExpenseSaveOutcome | null>(null)
  /** The last capture, held so it can be completed without leaving the page. */
  const [captured, setCaptured] = useState<ExpenseDraftRow | null>(null)
  /** The capture being completed right now, in the ordinary form. */
  const [completing, setCompleting] = useState<ExpenseDraftRow | null>(null)
  /** Remounts the form for "Add another", so every field starts clean. */
  const [formKey, setFormKey] = useState(0)

  /**
   * THE SMART SUGGESTION'S TRAINING SET, READ AFTER THE SCREEN IS UP.
   *
   * Deliberately NOT part of the bootstrap below and deliberately not awaited:
   * this route's promise to somebody's home screen is that it opens instantly,
   * and a suggestion that arrives a moment later is worth nothing if the form
   * arrives a moment later too. Until it lands, `history` is empty and the
   * suggestion panel simply does not appear — never a wrong suggestion, just a
   * slightly later one.
   */
  const [history, setHistory] = useState<ExpenseHistoryEntry[]>([])

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }, [supabase, router])

  useEffect(() => {
    let active = true
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      if (!active) return
      setUserId(session.user.id)

      const [{ data: me }, perms, { data: cats }] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        getEffectivePermissions(supabase, session.user.id, 'finance').catch(() => []),
        supabase.from('expense_categories').select('id, name, is_active').order('name'),
      ])
      if (!active) return
      setProfile(me as UserProfile)
      setCaps(deriveFinanceCapabilities((me as UserProfile | null)?.role, perms))
      setCategories((cats ?? []) as ExpenseCategory[])
      setLoading(false)
    }
    void init()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // AFTER THE SCREEN IS UP, never before it. Nothing waits on this.
  useEffect(() => {
    if (loading) return
    let active = true
    void (async () => {
      const { data, error } = await supabase
        .from('expenses')
        .select('category_id, paid_to, remark, deleted_at')
        // A deleted expense teaches nothing — asked of the database, and the
        // matcher re-applies the same rule over whatever it is handed.
        .is('deleted_at', null)
        .order('expense_date', { ascending: false })
        .limit(400)
      if (!active) return
      // A failed read means no suggestions, never wrong ones.
      setHistory(error ? [] : ((data ?? []) as ExpenseHistoryEntry[]))
    })()
    return () => { active = false }
  }, [loading, supabase])

  if (loading) return <FinanceRouteFallback />

  const missing = captured ? draftMissingFields(captured) : []

  return (
    <FinanceLayout
      profile={profile}
      title="Add Expense"
      subtitle="Quick entry"
      onSignOut={handleSignOut}
      actions={
        <button onClick={() => router.push('/finance/expenses')} className="boe-btn boe-btn-ghost">
          All expenses
        </button>
      }
    >
      {/* Narrow on a desktop, full width on a phone: this is one column of
          fields and nothing else, and stretching it to 1400px would put the
          Save button a screen away from the last field. */}
      <div style={{ maxWidth: '560px' }}>
        {!caps.canCreatePaymentRecord ? (
          <div className="boe-card" style={{ padding: '22px', fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
            You do not have permission to record an expense. Ask an administrator
            for Finance access.
          </div>
        ) : completing && userId ? (
          // ── "Complete now", in place. The ordinary form, prefilled. ──
          <div className="boe-card" style={{ padding: '18px' }}>
            <ExpenseForm
              supabase={supabase}
              userId={userId}
              mode="complete"
              draft={completing}
              categories={categories}
              history={history}
              onCategoryCreated={c => setCategories(prev => [...prev, c])}
              onSaved={outcome => { setCompleting(null); setCaptured(null); setSaved(outcome) }}
              onCancel={() => setCompleting(null)}
            />
          </div>
        ) : captured ? (
          // ── AFTER A CAPTURE: where it went, and both onward moves ──
          <div className="boe-card" style={{ padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#16A34A' }}>
                {QUICK_CAPTURE_SAVED_MESSAGE}
              </div>
              <div style={{ fontSize: '12.5px', color: colors.secondary, marginTop: '6px', lineHeight: 1.6 }}>
                &ldquo;{captured.raw_text}&rdquo;
              </div>
              <div style={{ fontSize: '11.5px', color: missing.length > 0 ? '#8A5A00' : colors.muted, marginTop: '6px', lineHeight: 1.6 }}>
                {draftMissingSummary(missing)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {/* "Capture another" leads: somebody who opened this from a home
                  screen is usually recording more than one thing. */}
              <button
                onClick={() => { setCaptured(null); setEntryMode('capture') }}
                className="boe-btn boe-btn-primary"
                style={{ minHeight: '46px', fontSize: '13px' }}
              >
                {CAPTURE_ANOTHER_LABEL}
              </button>
              <button
                onClick={() => setCompleting(captured)}
                className="boe-btn boe-btn-ghost"
                style={{ minHeight: '46px', fontSize: '13px' }}
              >
                {COMPLETE_NOW_LABEL}
              </button>
            </div>
          </div>
        ) : saved ? (
          // ── The confirmation after a full entry, with both onward moves ──
          <div className="boe-card" style={{ padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#16A34A' }}>
                Expense saved
              </div>
              <div style={{ fontSize: '13px', color: colors.secondary, marginTop: '5px', lineHeight: 1.6 }}>
                {formatMoney(saved.amount)} paid to {saved.paidTo}.
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                onClick={() => { setSaved(null); setFormKey(k => k + 1) }}
                className="boe-btn boe-btn-primary"
                style={{ minHeight: '44px', fontSize: '13px' }}
              >
                Add another expense
              </button>
              <button
                onClick={() => router.push('/finance/expenses')}
                className="boe-btn boe-btn-ghost"
                style={{ minHeight: '44px', fontSize: '13px' }}
              >
                View expenses
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>

            {/* ── THE CHOICE, FIRST AND WITHOUT A SCREEN OF ITS OWN ── */}
            <div
              role="group"
              aria-label="How to enter this expense"
              data-testid="entry-mode-choice"
              style={{ display: 'flex', gap: '8px' }}
            >
              <ModeButton
                label={QUICK_CAPTURE_LABEL}
                hint="Say it now, finish later"
                active={entryMode === 'capture'}
                onClick={() => setEntryMode('capture')}
              />
              <ModeButton
                label={FULL_ENTRY_LABEL}
                hint="Every field, saved as an expense"
                active={entryMode === 'full'}
                onClick={() => setEntryMode('full')}
              />
            </div>

            <div className="boe-card" style={{ padding: '18px' }}>
              {userId && entryMode === 'capture' && (
                <QuickCapture
                  supabase={supabase}
                  userId={userId}
                  autoFocus
                  onSaved={draft => setCaptured(draft)}
                />
              )}
              {userId && entryMode === 'full' && (
                <ExpenseForm
                  key={formKey}
                  supabase={supabase}
                  userId={userId}
                  mode="add"
                  categories={categories}
                  history={history}
                  onCategoryCreated={c => setCategories(prev => [...prev, c])}
                  onSaved={outcome => setSaved(outcome)}
                  // Cancel on the quick route leaves for the list rather than
                  // closing a modal there is none of.
                  onCancel={() => router.push('/finance/expenses')}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  )
}

// ── One of the two ways in ───────────────────────────────────────────────────
//
// FULL WIDTH EACH, SIDE BY SIDE, 44px MINIMUM. At 360px the pair is about
// 168px apiece, which is a comfortable thumb target with the label and its one
// line of explanation both readable — no truncation, no horizontal scroll.

function ModeButton({ label, hint, active, onClick }: {
  label: string
  hint: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="boe-btn"
      style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px',
        minHeight: '56px', padding: '9px 12px', textAlign: 'left',
        background: active ? colors.base : 'transparent',
        border: `1px solid ${active ? colors.borderSoft : colors.border}`,
      }}
    >
      <span style={{ fontSize: '13px', fontWeight: active ? 700 : 600, color: active ? colors.primary : colors.secondary }}>
        {label}
      </span>
      <span style={{ fontSize: '10.5px', color: colors.muted, lineHeight: 1.35 }}>
        {hint}
      </span>
    </button>
  )
}
