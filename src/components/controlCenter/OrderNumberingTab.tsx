'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cc, CcSection } from '@/components/controlCenter/CcPrimitives'
import { orderNumberErrorMessage, parseOrderNumberInput, formatOrderNumber } from '@/lib/orderNumbering'

// ── Confirmed Order Number Cycle ─────────────────────────────────────────────
//
// The admin control for the next Confirmed Order number (migrations
// 20260703000000 and 20260704000000). It has its own sidebar entry under
// SYSTEM: a control an admin cannot find is a control that does not exist.
//
// Both values come from get_confirmed_order_number_cycle() rather than from the
// table: order_number_cycle has RLS enabled with no policies, so it is not
// client-readable at all. That RPC is admin-gated in the database, which means
// nothing on this page is what stands between a non-admin and the data.
//
// Client-side validation (parseOrderNumberInput) is a convenience that saves a
// round trip on an obvious typo. Every rule it applies is independently enforced
// by set_next_confirmed_order_number(), and when the two disagree the database
// wins and its message is what gets shown.

type OrderNumberCycle = {
  next_number: number | null
  next_number_display: string | null
  highest_existing_number: number
  highest_existing_display: string | null
  configured: boolean
  exhausted: boolean
}

export function OrderNumberCycleTab() {
  const supabase = useMemo(() => createClient(), [])

  const [cycle,    setCycle]    = useState<OrderNumberCycle | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [loadErr,  setLoadErr]  = useState('')
  const [input,    setInput]    = useState('')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [saved,    setSaved]    = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr('')
    const { data, error: rpcErr } = await supabase.rpc('get_confirmed_order_number_cycle')
    if (rpcErr) {
      // The card must survive this. Losing the whole section on a failed read
      // would put the admin back where they started: unable to find the control.
      setLoadErr(orderNumberErrorMessage(rpcErr.message, 'admin') ?? rpcErr.message)
      setCycle(null)
      setLoading(false)
      return
    }
    const res = data as OrderNumberCycle | null
    setCycle(res)
    setInput(res?.next_number != null ? String(res.next_number) : '')
    setLoading(false)
  }, [supabase])

  // A FETCH IS STARTED HERE. `load` raises the loading flag before its await,
  // and on mount that flag is already true, so React bails out of the update.
  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const parsed  = parseOrderNumberInput(input)
  const preview = parsed.ok ? formatOrderNumber(parsed.value) : null

  // Save is disabled when nothing changed. Compared numerically, so retyping
  // '0020' over a stored 20 correctly counts as unchanged.
  const unchanged = parsed.ok && cycle?.next_number != null && parsed.value === cycle.next_number
  const canSave   = !saving && !loading && parsed.ok && !unchanged

  const save = async () => {
    setError('')
    setSaved('')
    if (!parsed.ok) { setError(parsed.error); return }

    setSaving(true)
    const { error: rpcErr } = await supabase.rpc('set_next_confirmed_order_number', {
      p_next_number: parsed.value,
    })
    setSaving(false)

    if (rpcErr) {
      // The database is authoritative. Show what it actually said, in plain
      // language where there is a mapping, and never a generic fallback that
      // hides which rule was broken.
      setError(orderNumberErrorMessage(rpcErr.message, 'admin') ?? rpcErr.message)
      return
    }

    setSaved(`The next Confirmed Order will be ${formatOrderNumber(parsed.value)}.`)
    await load()
  }

  if (loading) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  if (loadErr) {
    return (
      <CcSection>
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>{loadErr}</div>
        <button className="boe-btn boe-btn-ghost" onClick={() => void load()}>Retry</button>
      </CcSection>
    )
  }

  return (
    <>
      <div className={cc.stats} style={{ maxWidth: 520 }}>
        <div className={cc.stat}>
          <div className={cc.statValue}>{cycle?.highest_existing_display ?? '—'}</div>
          <div className={cc.statLabel}>Highest existing Order</div>
        </div>
        <div className={cc.stat}>
          <div className={cc.statValue}>
            {cycle?.next_number_display ?? (cycle?.exhausted ? 'Exhausted' : 'Not set')}
          </div>
          <div className={cc.statLabel}>Next Confirmed Order</div>
        </div>
      </div>

      <CcSection title="Set the next number" description="Order Request numbers (ORD-REQ-…) are a separate scheme and are not affected.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className={cc.control}
            style={{ width: 130 }}
            value={input}
            onChange={e => { setInput(e.target.value); setError(''); setSaved('') }}
            onKeyDown={e => { if (e.key === 'Enter' && canSave) void save() }}
            inputMode="numeric"
            placeholder="e.g. 25"
            aria-label="Next Confirmed Order number"
          />
          {/* The live four-digit preview: it is what the admin is actually
              choosing, so it is shown at the moment of choosing rather than
              only after a save. */}
          <div className={cc.muted} style={{ fontSize: 12.5 }}>
            {preview
              ? <>will be saved as <strong style={{ color: '#303536', fontSize: 15 }}>{preview}</strong></>
              : input.trim() ? <span style={{ color: '#B42332' }}>{parsed.ok ? '' : parsed.error}</span> : null}
          </div>
          <button className="boe-btn boe-btn-primary" onClick={save} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {error && <div className={cc.error}>{error}</div>}
        {saved && <div className={cc.success} style={{ marginTop: 10 }}>{saved}</div>}

        <div className={cc.note} style={{ marginTop: 18 }}>
          This changes the number assigned to the next future Confirmed Order.
          Existing Orders are not renumbered.
          <br />
          Order numbers are always four digits, 0001 to 9999, and the next number must be
          higher than the highest Order that already exists.
        </div>
      </CcSection>
    </>
  )
}
