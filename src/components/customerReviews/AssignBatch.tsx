'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, UserPlus } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { IMAGE_REVIEWS_PER_BATCH, REVIEWS_PER_BATCH } from '@/lib/customerReviews/reviewTypes'
import { StackSkeleton } from './ReviewSkeletons'

// ── Giving one batch to one employee ─────────────────────────────────────────
//
// A BATCH IS ASSIGNED WHOLE, and that is the workflow rather than a limitation
// of this control. Twelve reviews are what one employee is asked to do — eight
// text and four image — so "assign this batch" is one decision with one
// consequence, and there is no partial form of it to get wrong.
//
// WHAT THIS COMPONENT DECIDES: nothing. It draws a picker and calls
// assign_customer_review_batch(), which resolves `verify` for the caller from
// the permission engine, checks that the employee can actually use the module,
// LOCKS all twelve rows and rechecks that every one of them is an unassigned
// approved review before writing. A stale screen produces a refusal naming the
// review that moved, not a half-assigned batch.
//
// THE EMPLOYEE LIST COMES FROM THE DATABASE, not from a role filter here.
// customer_review_assignable_employees() asks the permission engine about each
// active employee and returns only those who resolve `use` — so the picker
// cannot offer somebody whose assignment would be invisible to them.

type Employee = { id: string; full_name: string | null }

export type AssignOutcome = {
  assigned: number
  image_reviews: number
  with_images: number
  awaiting_images: number
}

export function AssignBatch({
  supabase, batchId, eligible, onAssigned,
}: {
  supabase: SupabaseClient
  batchId: string
  /**
   * How many reviews in this batch are approved and unassigned right now.
   *
   * A DISPLAY NUMBER, NOT A DECISION. The database chooses and locks the set
   * inside the transaction; this only decides whether to explain, before
   * somebody presses a button, that the batch is not in a state to be assigned.
   */
  eligible: number
  onAssigned: (outcome: AssignOutcome) => void
}) {
  const [people, setPeople] = useState<Employee[] | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  useEffect(() => {
    let active = true
    const startFetch = () => {
      void (async () => {
        const { data, error: rpcError } = await supabase.rpc('customer_review_assignable_employees')
        if (!active) return
        // A LIST THAT FAILED TO LOAD IS AN EMPTY LIST WITH A SENTENCE, not a
        // silent picker with nothing in it. The two look identical otherwise,
        // and one of them is a bug.
        if (rpcError) { setPeople([]); setError('The employee list could not be loaded. Refresh to try again.'); return }
        setPeople((data ?? []) as Employee[])
      })()
    }
    startFetch()
    return () => { active = false }
  }, [supabase])

  const assign = useCallback(async () => {
    if (inFlight.current || !choice) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { data, error: rpcError } = await supabase.rpc('assign_customer_review_batch', {
        p_batch_id: batchId,
        p_employee_id: choice,
      })
      if (rpcError) {
        // The database's own sentence, stripped of its machine prefix. Every
        // one of them is written to be read by the verifier who triggered it.
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That batch could not be assigned.')
        return
      }
      const outcome = (data ?? {}) as Partial<AssignOutcome>
      setChoice('')
      onAssigned({
        assigned:        outcome.assigned ?? 0,
        image_reviews:   outcome.image_reviews ?? 0,
        with_images:     outcome.with_images ?? 0,
        awaiting_images: outcome.awaiting_images ?? 0,
      })
    } catch {
      setError('That batch could not be assigned. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [supabase, batchId, choice, onAssigned])

  // NOT READY IS EXPLAINED RATHER THAN DISABLED SILENTLY. A verifier looking at
  // a batch they have only half approved needs to be told that is why, not
  // shown a grey rectangle.
  if (eligible !== REVIEWS_PER_BATCH) {
    return (
      <p style={{ fontSize: '12px', color: colors.secondary, margin: 0, lineHeight: 1.6 }}>
        A batch is assigned whole. Approve all {REVIEWS_PER_BATCH} reviews in this batch
        {eligible > 0 ? ` (${eligible} are ready)` : ''} before assigning it to an employee.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor={`assign-${batchId}`} style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
          Assign to
        </label>
        <select
          id={`assign-${batchId}`}
          value={choice}
          onChange={e => { setChoice(e.target.value); setError('') }}
          disabled={busy || people === null}
          className="boe-input"
          style={{ maxWidth: '240px', minHeight: '40px', fontSize: '13px' }}
        >
          <option value="">{people === null ? 'Loading…' : 'Choose an employee'}</option>
          {(people ?? []).map(p => (
            <option key={p.id} value={p.id}>{p.full_name ?? 'Unnamed employee'}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => { void assign() }}
          disabled={busy || !choice}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            padding: '9px 14px', borderRadius: '8px', minHeight: '40px',
            border: 'none', fontSize: '13px', fontWeight: 600,
            background: !choice || busy ? colors.borderSoft : colors.primary,
            color: !choice || busy ? colors.muted : '#FFFFFF',
            cursor: !choice || busy ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? <Loader2 size={14} className="boe-spin" /> : <UserPlus size={14} />}
          Assign all {REVIEWS_PER_BATCH}
        </button>
      </div>

      <p style={{ fontSize: '11px', color: colors.secondary, margin: 0, lineHeight: 1.6 }}>
        All {REVIEWS_PER_BATCH} go to one employee, and only they see them. The
        {' '}{IMAGE_REVIEWS_PER_BATCH} image reviews get different projects where enough are ready.
      </p>

      {people !== null && people.length === 0 && !error && (
        <p role="status" style={{ fontSize: '12px', color: '#92400E', margin: 0, lineHeight: 1.6 }}>
          No employee currently holds the permission to use the Review Workflow, so there is
          nobody to assign this batch to. Grant it in Control Center first.
        </p>
      )}

      {error && (
        <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0, lineHeight: 1.6 }}>{error}</p>
      )}
    </div>
  )
}

// ── Every batch that is approved and waiting to be given to somebody ─────────
//
// WHY THIS IS NOT PART OF PendingBatches. That workspace holds PENDING drafts,
// and a batch stops being pending the moment it is approved — which is exactly
// when it becomes assignable. Putting the control there would mean drawing it
// for rows that have just disappeared from the list it belongs to.
//
// A BATCH IS THE UNIT, so this reads batches rather than reviews: twelve rows
// grouped by batch_id, and a batch appears here only while every one of its
// live reviews is approved and unassigned. Once assigned it leaves this list,
// because a batch has one owner and there is nothing further to decide.

type BatchRow = {
  batchId: string
  eligible: number
  live: number
  generatedAt: string | null
  /** The composition of the reviews that are ready. Counted from rows already read. */
  text: number
  image: number
}

export function AssignBatchPanel({ supabase, onAssigned }: {
  supabase: SupabaseClient
  onAssigned: (outcome: AssignOutcome) => void
}) {
  const [rows, setRows] = useState<BatchRow[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    // THE COLUMNS ARE THE MINIMUM THAT ANSWERS THE QUESTION — a batch id, a
    // status and an assignee. No review text, so there is nothing here that
    // could be rendered as a review by a later edit.
    const { data, error: readError } = await supabase
      .from('customer_review_test_cards')
      .select('id, batch_id, status, assigned_to, review_type, created_at')
      .not('batch_id', 'is', null)
      .is('deleted_at', null)
      .in('status', ['pending_approval', 'available'])

    if (readError) {
      setError('The batch list could not be loaded. Refresh to try again.')
      setRows([])
      return
    }

    type Raw = {
      batch_id: string | null; status: string; assigned_to: string | null
      review_type: string; created_at: string
    }
    const byBatch = new Map<string, { eligible: number; live: number; at: string; text: number; image: number }>()
    for (const row of (data ?? []) as unknown as Raw[]) {
      if (!row.batch_id) continue
      const entry = byBatch.get(row.batch_id) ?? { eligible: 0, live: 0, at: row.created_at, text: 0, image: 0 }
      entry.live++
      // ELIGIBLE means approved AND unassigned. A batch part-way through
      // approval, or one already given to somebody, is not offered.
      if (row.status === 'available' && row.assigned_to === null) {
        entry.eligible++
        if (row.review_type === 'image') entry.image++
        else entry.text++
      }
      if (row.created_at < entry.at) entry.at = row.created_at
      byBatch.set(row.batch_id, entry)
    }

    setError('')
    setRows(
      [...byBatch.entries()]
        // A batch with nothing eligible has either been assigned already or has
        // not been approved at all; neither is something to act on here.
        .filter(([, v]) => v.eligible > 0)
        .map(([batchId, v]) => ({
          batchId, eligible: v.eligible, live: v.live, generatedAt: v.at,
          text: v.text, image: v.image,
        }))
        .sort((a, b) => (b.generatedAt ?? '').localeCompare(a.generatedAt ?? '')),
    )
  }, [supabase])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  if (error) {
    return <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{error}</p>
  }
  if (rows === null) {
    return <StackSkeleton count={2} height={104} />
  }
  if (rows.length === 0) {
    return (
      <p style={{
        margin: 0, padding: '18px', borderRadius: '8px', fontSize: '12px', lineHeight: 1.6,
        border: `1px dashed ${colors.border}`, color: colors.muted,
      }}>
        No batch is ready to assign. Approve all {REVIEWS_PER_BATCH} reviews above first.
      </p>
    )
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {rows.map(row => (
        <li key={row.batchId} style={{
          border: `1px solid ${colors.border}`, borderRadius: '8px',
          padding: '12px', background: '#FFFFFF',
          display: 'flex', flexDirection: 'column', gap: '8px',
        }}>
          {/*
            THE SAME FOUR FACTS THE APPROVAL SECTION SHOWS, so a batch reads
            the same way at both steps: how much is ready, what it is made of,
            which batch, and what happens next.
          */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>
              {row.eligible} of {REVIEWS_PER_BATCH} ready
            </span>
            <span style={{ fontSize: '11.5px', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
              {row.text} Text · {row.image} Image
            </span>
            <span style={{
              marginLeft: 'auto', fontFamily: 'var(--font-mono)',
              fontSize: '10.5px', color: colors.muted, whiteSpace: 'nowrap',
            }}>
              {row.batchId.slice(0, 8)}
            </span>
          </div>

          <AssignBatch
            supabase={supabase}
            batchId={row.batchId}
            eligible={row.eligible}
            onAssigned={outcome => { onAssigned(outcome); void load() }}
          />
        </li>
      ))}
    </ul>
  )
}

/** The sentence the list shows after an assignment. Says what actually happened. */
export function assignmentNotice(outcome: AssignOutcome): string {
  const base = `${outcome.assigned} review${outcome.assigned === 1 ? '' : 's'} assigned.`
  if (outcome.image_reviews === 0) return base
  if (outcome.awaiting_images === 0) {
    return `${base} All ${outcome.image_reviews} image reviews have their project images.`
  }
  // THE UNCOMFORTABLE NUMBER IS SAID FIRST-CLASS rather than left for the
  // candidate to discover. There were not enough ready project groups, and the
  // verifier is the person who can fix that.
  return `${base} ${outcome.awaiting_images} of ${outcome.image_reviews} image review${outcome.image_reviews === 1 ? '' : 's'} `
    + 'are waiting for project images — add a project group and attach it.'
}
