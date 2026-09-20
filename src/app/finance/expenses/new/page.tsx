'use client'

// ── /finance/expenses/new — THE QUICK-ENTRY ROUTE ────────────────────────────
//
// The URL somebody saves to a phone's home screen, and the target of the
// Add Expense manifest shortcut and the launcher's Quick Add Expense action.
// It opens STRAIGHT INTO THE FORM: no list read, no counts, no navigation
// through Finance first. The only things it waits for are the session, the
// person's Finance capabilities and the category list the picker needs.
//
// IT IS NOT A SECOND FORM. It mounts the same ExpenseForm the list's Add modal
// does, with the same rules, the same validation and the same voice entry, so
// the two can never drift.
//
// IT IS NOT A SECOND DOOR EITHER. It sits inside src/app/finance/layout.tsx, so
// ModuleGuard decides Finance entry before it mounts — typing this URL without
// Finance access lands on /coming-soon, exactly as /finance does — and every
// write is re-authorized by RLS in the database.

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
import { ExpenseForm, type ExpenseSaveOutcome } from '../ExpenseForm'

export default function QuickAddExpensePage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [caps, setCaps] = useState(NO_FINANCE_CAPABILITIES)
  const [categories, setCategories] = useState<ExpenseCategory[]>([])

  /** The last save, held so the confirmation can name it. */
  const [saved, setSaved] = useState<ExpenseSaveOutcome | null>(null)
  /** Remounts the form for "Add another", so every field starts clean. */
  const [formKey, setFormKey] = useState(0)

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

  if (loading) return <FinanceRouteFallback />

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
        ) : saved ? (
          // ── The confirmation, with both onward moves ──
          // "Add another" is the primary: somebody who opened this URL from a
          // home screen is usually entering more than one.
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
          <div className="boe-card" style={{ padding: '18px' }}>
            {userId && (
              <ExpenseForm
                key={formKey}
                supabase={supabase}
                userId={userId}
                mode="add"
                categories={categories}
                onCategoryCreated={c => setCategories(prev => [...prev, c])}
                onSaved={outcome => setSaved(outcome)}
                // Cancel on the quick route leaves for the list rather than
                // closing a modal there is none of.
                onCancel={() => router.push('/finance/expenses')}
              />
            )}
          </div>
        )}
      </div>
    </FinanceLayout>
  )
}
