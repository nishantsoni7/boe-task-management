'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { CcBadge, CcField, CcSection, cc } from './CcPrimitives'
import { errorText, fetchPriceSettings, savePriceSettings } from '@/lib/quotations/api'
import { DEFAULT_DISCOUNT_LIMIT, DEFAULT_PRICE_LIMIT, approvalIsOn, readLimit } from '@/lib/quotations/priceApprovalSwitch'

// Control Center › Sales › Quotation price approval (owner, 15 Nov 2026). One switch for the price-approval card on
// a quotation, plus the two limits that trigger it (they used to be edited on the Quotations list).
//
// Off, no quotation is held: the card disappears and the client link and Confirm → PI never wait. Nothing is
// deleted: the old requests and answers stay in the log. The write is quotation_price_settings_set, which refuses
// anyone but an administrator; this screen only draws the setting as it is SAVED. See lib/quotations/priceApprovalSwitch.ts
// for why "off" is "both limits empty".

const KEY = ['quotations', 'price-settings'] as const

export function QuotationPriceApprovalSetting() {
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: KEY, queryFn: () => fetchPriceSettings(supabase), retry: false })
  const [form, setForm] = useState<{ d: string; p: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const v = query.data
  if (query.isError) return <div className={cc.error} role="alert">The setting could not be read: {errorText(query.error)}</div>
  if (!v) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  const on = approvalIsOn(v)
  // Off, the two limits are always offered, filled with the starting ones; on, they appear after "Change limits".
  const f = form ?? (on ? null : { d: DEFAULT_DISCOUNT_LIMIT, p: DEFAULT_PRICE_LIMIT })
  const limit = (x: number | null, unit: string) => (x === null ? 'not checked' : `${Number(x)}${unit}`)

  const save = async (d: string | null, p: string | null, done: string) => {
    setError('')
    setSaved('')
    setSaving(true)
    try {
      await savePriceSettings(supabase, d === null ? null : readLimit(d), p === null ? null : readLimit(p))
      setForm(null)
      setSaved(done)
      await queryClient.invalidateQueries({ queryKey: ['quotations'] })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const bothEmpty = !!f && f.d.trim() === '' && f.p.trim() === ''

  return (
    <CcSection
      title="Quotation price approval"
      description="Whether a quotation with a large discount or a low price must be approved by the pricing desk before it can go to the client or be confirmed."
    >
      <div className={cc.list}>
        <div className={cc.listRow}>
          <div className={cc.listMain}>
            <div>Price approval on quotations</div>
            <div className={cc.listDetail}>
              {on
                ? `Asked for when the discount is above ${limit(v.max_discount_pct, '%')}, or a product is priced below ${limit(v.min_price_pct, '%')} of its last ordered price.`
                : 'Off. No quotation is held for price approval: the card is gone, and the client link and Confirm → PI do not wait.'}
            </div>
          </div>
          <div className={cc.rowActions}>
            <CcBadge tone={on ? 'green' : 'gray'}>{on ? 'On' : 'Off'}</CcBadge>
            {on && (
              <>
                <button className="boe-btn boe-btn-ghost" disabled={saving || !v.may_change || !!form} onClick={() => setForm({ d: v.max_discount_pct === null ? '' : String(Number(v.max_discount_pct)), p: v.min_price_pct === null ? '' : String(Number(v.min_price_pct)) })}>
                  Change limits
                </button>
                <button className="boe-btn boe-btn-ghost" disabled={saving || !v.may_change} onClick={() => void save(null, null, 'Price approval is switched off.')}>
                  {saving ? 'Saving…' : 'Switch off'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {f && (
        <div style={{ marginTop: 16, maxWidth: 360 }}>
          <CcField label="Discount above (%)" hint="Approval is asked for when a quotation's discount is above this. Empty: the discount is not checked.">
            <input className={cc.fieldControl} inputMode="decimal" value={f.d} onChange={e => setForm({ ...f, d: e.target.value })} placeholder="not checked" />
          </CcField>
          <CcField label="Price below (% of last ordered)" hint="Approval is asked for when a product is priced below this share of what it last sold for. Empty: prices are not checked.">
            <input className={cc.fieldControl} inputMode="decimal" value={f.p} onChange={e => setForm({ ...f, p: e.target.value })} placeholder="not checked" />
          </CcField>
          <div className={cc.rowActions}>
            <button
              className="boe-btn boe-btn-primary"
              disabled={saving || !v.may_change || bothEmpty}
              onClick={() => void save(f.d, f.p, on ? 'The limits are saved.' : 'Price approval is switched on.')}
            >
              {saving ? 'Saving…' : on ? 'Save limits' : 'Switch on'}
            </button>
            {on && <button className="boe-btn boe-btn-ghost" disabled={saving} onClick={() => setForm(null)}>Cancel</button>}
          </div>
          {bothEmpty && <div className={cc.fieldHint} style={{ marginTop: 8 }}>Leave at least one limit, or use Switch off.</div>}
        </div>
      )}

      {error && <div className={cc.error} role="alert">{error}</div>}
      {saved && <div className={cc.success} style={{ marginTop: 10 }}>{saved}</div>}
      {!v.may_change && <div className={cc.error}>Only an administrator can change this.</div>}

      <div className={cc.note} style={{ marginTop: 18 }}>
        <div className={cc.noteTitle}>What this changes</div>
        Only whether approval is asked for. Suggested prices and the Why? popup stay as they are. Switching off forgets the limits (they start again
        at 5% and 90% when you switch on). A quotation already waiting for approval stops waiting; earlier requests and answers stay in its history.
      </div>
    </CcSection>
  )
}
