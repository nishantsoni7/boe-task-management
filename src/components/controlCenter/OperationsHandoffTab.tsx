'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { cc, CcSection, ActiveBadge } from '@/components/controlCenter/CcPrimitives'
import {
  OPERATIONS_REVIEWER_CLEAR_OPTION, OPERATIONS_REVIEWER_NOBODY, OPERATIONS_REVIEWER_NOBODY_HINT,
  OPERATIONS_REVIEWER_SAVE_LABEL, OPERATIONS_REVIEWER_ELIGIBILITY, OPERATIONS_REVIEWER_SECTION_DESCRIPTION,
  OPERATIONS_REVIEWER_SECTION_TITLE, describeReviewerAssignmentFailure, describeReviewerSaved,
  eligibleOperationsReviewers,
} from '@/lib/orders/operationsHandoff'

// ── Operations Handoff: the one reviewer (20261229000000) ────────────────────
//
// ONE PERSON, CHOSEN BY AN ADMINISTRATOR, HELD AS A USER ID. Never a display
// name, never a guessed id: the list is the live employee directory this page
// already loads, and the database re-checks under set_order_operations_reviewer
// that the choice is an active account that can open Orders. Clearing the
// choice is allowed and visible — new handoffs then wait unassigned rather than
// falling to an administrator.

type ReviewerRow = { user_id: string | null; assigned_by: string | null; assigned_at: string | null }

export function OperationsReviewerTab({ members }: { members: UserProfile[] }) {
  const supabase = useMemo(() => createClient(), [])

  const [current, setCurrent] = useState<ReviewerRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [choice,  setChoice]  = useState('')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [saved,   setSaved]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr('')
    const { data, error: readErr } = await supabase
      .from('order_operations_reviewers')
      .select('user_id, assigned_by, assigned_at')
      .eq('duty', 'pi_handoff')
      .maybeSingle()
    if (readErr) {
      setLoadErr(readErr.message)
      setCurrent(null)
      setLoading(false)
      return
    }
    const row = (data as ReviewerRow | null) ?? { user_id: null, assigned_by: null, assigned_at: null }
    setCurrent(row)
    setChoice(row.user_id ?? '')
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const eligible = eligibleOperationsReviewers(members)
  const nameOf = (id: string | null) => (id ? members.find(m => m.id === id)?.full_name ?? null : null)
  const currentMember = current?.user_id ? members.find(m => m.id === current.user_id) ?? null : null
  const currentInactive = !!current?.user_id && (!currentMember || currentMember.is_active === false)

  const save = async () => {
    setError('')
    setSaved('')
    setSaving(true)
    const { data, error: writeErr } = await supabase.rpc('set_order_operations_reviewer', {
      p_user_id: choice || null,
    })
    setSaving(false)
    if (writeErr) {
      setError(describeReviewerAssignmentFailure(writeErr))
      return
    }
    const result = (data ?? {}) as { reassigned_handoffs?: number; unassigned_handoffs?: number }
    setSaved(describeReviewerSaved({
      name: nameOf(choice || null),
      reassigned: result.reassigned_handoffs ?? 0,
      unassigned: result.unassigned_handoffs ?? 0,
    }))
    await load()
  }

  if (loading) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  if (loadErr || !current) {
    return (
      <CcSection>
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>
          {loadErr || 'This setting could not be read.'}
        </div>
        <button className="boe-btn boe-btn-ghost" onClick={() => void load()}>Retry</button>
      </CcSection>
    )
  }

  return (
    <CcSection
      title={OPERATIONS_REVIEWER_SECTION_TITLE}
      description={OPERATIONS_REVIEWER_SECTION_DESCRIPTION}
    >
      <div className={cc.list}>
        <div className={cc.listRow}>
          <div className={cc.listMain}>
            <div>Current operations reviewer</div>
            <div className={cc.listDetail}>
              {current.user_id
                ? `${nameOf(current.user_id) ?? 'An account that is no longer listed'}${currentInactive ? ' (inactive — new handoffs are recorded unassigned)' : ''}`
                : OPERATIONS_REVIEWER_NOBODY}
              {current.assigned_at && ` · set ${new Date(current.assigned_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`}
              {current.assigned_by && nameOf(current.assigned_by) && ` by ${nameOf(current.assigned_by)}`}
            </div>
          </div>
          <div className={cc.rowActions}>
            <ActiveBadge active={!!current.user_id && !currentInactive} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
        <select
          aria-label="Operations reviewer"
          className="boe-input boe-p4-cc-select"
          value={choice}
          disabled={saving}
          onChange={e => { setChoice(e.target.value); setSaved(''); setError('') }}
          style={{ minWidth: 260, padding: '6px 10px', fontSize: 13 }}
        >
          <option value="">{OPERATIONS_REVIEWER_CLEAR_OPTION}</option>
          {eligible.map(m => (
            <option key={m.id} value={m.id}>{m.full_name}{m.role === 'admin' ? ' (admin)' : ''}</option>
          ))}
        </select>
        <button
          className="boe-btn boe-btn-primary"
          disabled={saving || choice === (current.user_id ?? '')}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : OPERATIONS_REVIEWER_SAVE_LABEL}
        </button>
      </div>

      {error && <div className={cc.error} style={{ marginTop: 10 }}>{error}</div>}
      {saved && <div className={cc.success} style={{ marginTop: 10 }}>{saved}</div>}

      <div className={cc.note} style={{ marginTop: 14 }}>
        <div className={cc.noteTitle}>Who can be chosen</div>
        {OPERATIONS_REVIEWER_ELIGIBILITY}
      </div>

      <div className={cc.note} style={{ marginTop: 12 }}>
        <div className={cc.noteTitle}>What the reviewer does</div>
        When an administrator approves a PI, or approves a revised PI, the reviewer is notified and
        the Order shows that exact version as awaiting operations review. They open the
        Order, look at the version and what changed, and choose <b>Accept for production</b> or
        <b> Cannot accept</b> with a reason. Accepting says operations has reviewed the version
        and can work from it. It does not say any manufacturing work is done, and it does not
        change production alignment.
      </div>

      <div className={cc.note} style={{ marginTop: 12 }}>
        <div className={cc.noteTitle}>When nobody is assigned</div>
        {OPERATIONS_REVIEWER_NOBODY_HINT} Being an administrator does not make anybody the
        reviewer, and an administrator is never counted as having accepted in the reviewer&rsquo;s place.
      </div>
    </CcSection>
  )
}
