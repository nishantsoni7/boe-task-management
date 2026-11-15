'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cc, CcSection, ActiveBadge } from '@/components/controlCenter/CcPrimitives'
import {
  ORDER_UPDATE_RECIPIENT_DESCRIPTION, ORDER_UPDATE_RECIPIENT_LABEL, ORDER_UPDATE_RECIPIENT_ROLES,
  readRecipientConfig, type OrderUpdateRecipientRole,
} from '@/lib/orders/orderUpdateNotifications'

// ── Order Update Notifications ───────────────────────────────────────────────
//
// WHO HEARS ABOUT AN ORDER THAT MOVED. Four switches, one per associated
// category (20261202000000). This is MANAGEMENT CONFIGURATION for the whole
// business, not a personal preference: there is no user_id anywhere near the
// table, and an employee has no control that corresponds to it.
//
// IT IS A SWITCHBOARD, NOT A PERMISSION. Turning a category on can only send a
// notification to somebody who is already an administrator or is already named
// on the Order; it grants nothing and reveals nothing, because a recipient
// still opens the Order under their own RLS exactly as before. Turning one OFF
// is the only thing here that changes what anybody receives, and that is the
// point of the control.
//
// READ AND WRITTEN DIRECTLY, under the admin-only RLS policies the migration
// installed — the same shape the Order Numbering control above uses for its
// RPCs. There is no route to add, because there is no rule the database is not
// already enforcing.

type RecipientRow = { recipient_role: OrderUpdateRecipientRole; enabled: boolean }

export function OrderNotificationRecipientsTab() {
  const supabase = useMemo(() => createClient(), [])

  const [config,  setConfig]  = useState<Record<OrderUpdateRecipientRole, boolean> | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [saving,  setSaving]  = useState<OrderUpdateRecipientRole | null>(null)
  const [error,   setError]   = useState('')
  const [saved,   setSaved]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr('')
    const { data, error: readErr } = await supabase
      .from('order_notification_recipients')
      .select('recipient_role, enabled')
    if (readErr) {
      setLoadErr(readErr.message)
      setConfig(null)
      setLoading(false)
      return
    }
    setConfig(readRecipientConfig(data as RecipientRow[] | null))
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const toggle = async (role: OrderUpdateRecipientRole, next: boolean) => {
    setError('')
    setSaved('')
    setSaving(role)
    // OPTIMISTIC, then corrected by the re-read below. A switch that does not
    // move until a round trip completes reads as broken.
    setConfig(c => (c ? { ...c, [role]: next } : c))
    const { error: writeErr } = await supabase
      .from('order_notification_recipients')
      .update({ enabled: next, updated_at: new Date().toISOString() })
      .eq('recipient_role', role)
    setSaving(null)
    if (writeErr) {
      setError(writeErr.message)
      await load()
      return
    }
    setSaved(
      `${ORDER_UPDATE_RECIPIENT_LABEL[role]} will ${next ? 'now receive' : 'no longer receive'} Order update notifications.`,
    )
    await load()
  }

  if (loading) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  if (loadErr || !config) {
    return (
      <CcSection>
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>
          {loadErr || 'This configuration could not be read.'}
        </div>
        <button className="boe-btn boe-btn-ghost" onClick={() => void load()}>Retry</button>
      </CcSection>
    )
  }

  return (
    <CcSection
      title="Who is notified when an Order changes"
      description="Applies to every Confirmed Order. A person is notified if they fall into any switched-on category."
    >
      <div className={cc.list}>
        {ORDER_UPDATE_RECIPIENT_ROLES.map(role => (
          <div key={role} className={cc.listRow}>
            <div className={cc.listMain}>
              <div>{ORDER_UPDATE_RECIPIENT_LABEL[role]}</div>
              <div className={cc.listDetail}>{ORDER_UPDATE_RECIPIENT_DESCRIPTION[role]}</div>
            </div>
            <div className={cc.rowActions}>
              <ActiveBadge active={config[role]} />
              <button
                className="boe-btn boe-btn-ghost"
                disabled={saving !== null}
                onClick={() => void toggle(role, !config[role])}
              >
                {saving === role ? 'Saving…' : config[role] ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && <div className={cc.error}>{error}</div>}
      {saved && <div className={cc.success} style={{ marginTop: 10 }}>{saved}</div>}

      <div className={cc.note} style={{ marginTop: 18 }}>
        <div className={cc.noteTitle}>Why BDM Department starts off</div>
        An Order does not record a BDM, so this category cannot mean &ldquo;the BDM
        on this Order&rdquo; — it means every active member of the BDM Department.
        Switched on, all of them are notified about every Order. It is available
        if that is what you want; it starts off so nobody turns it on by
        assuming it works like the salesperson switch above.
      </div>

      <div className={cc.note} style={{ marginTop: 12 }}>
        <div className={cc.noteTitle}>The rule no switch can change</div>
        Whoever makes a change is never notified about their own action, whatever
        is switched on here. They were looking at the screen when they made it.
        <br />
        <br />
        Only meaningful changes are announced — a status change, an amendment, a
        production alignment, and a payment verified or rejected against the
        Order. Timestamps, background corrections and read-state changes are not
        events and raise nothing.
      </div>
    </CcSection>
  )
}
