'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { CcSection, cc } from './CcPrimitives'
import { errorText, fetchPaymentSettings, savePaymentSettings, type PaymentSettings } from '@/lib/quotations/api'

// Control Center › Sales › Quotation price approval: the bank account and the UPI QR printed on every quotation (owner,
// 18 Nov 2026). quotation_payment_set refuses anyone but an administrator. The Customer ID is kept here and never printed.

const KEY = ['quotations', 'payment-settings'] as const
const FIELDS: [keyof Omit<PaymentSettings, 'qr_image' | 'updated_at'>, string][] = [
  ['account_holder', 'Account holder'], ['bank', 'Bank'], ['account_no', 'Account number'], ['ifsc', 'IFSC code'],
  ['branch', 'Branch'], ['upi_id', 'UPI ID'], ['customer_id', 'Customer ID (kept here, not printed)'],
]

/** Shrinks a picked QR image to at most 600 px and returns a PNG data URL (the database keeps it in the row, 400 KB at most). */
async function qrDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, 600 / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k)
  c.height = Math.round(bmp.height * k)
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  return c.toDataURL('image/png')
}

export function QuotationPaymentSetting() {
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: KEY, queryFn: () => fetchPaymentSettings(supabase), retry: false })
  const [edits, setEdits] = useState<Record<string, string>>({}) // only what was typed; the rest shows the saved value
  const [qr, setQr] = useState<string | null | undefined>(undefined) // undefined = unchanged
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  if (query.isError) return <div className={cc.error} role="alert">The payment details could not be read: {errorText(query.error)}</div>
  if (!query.data) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>
  const shownQr = qr === undefined ? query.data.qr_image : qr

  const pick = async (f: File | undefined) => {
    setError('')
    if (!f) return
    try { setQr(await qrDataUrl(f)) } catch { setError('That file could not be read as a picture. Use a PNG or JPG of the QR code.') }
  }
  const save = async () => {
    setError('')
    setSaved('')
    setSaving(true)
    try {
      await savePaymentSettings(supabase, { ...edits, ...(qr === undefined ? {} : { qr_image: qr ?? '' }) })
      setQr(undefined)
      setEdits({})
      setSaved('Saved. New quotations and the client links show these details.')
      await queryClient.invalidateQueries({ queryKey: ['quotations'] })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CcSection
      title="Payment details on quotations"
      description="The bank account and UPI QR printed on the terms page of every quotation, the client link and the Excel. Nothing prints until an account number or a UPI ID is filled in."
    >
      <div style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
        {FIELDS.map(([k, label]) => (
          <label key={k} style={{ display: 'grid', gap: 3, fontSize: 13 }}>
            {label}
            <input className="boe-input" value={edits[k] ?? query.data![k] ?? ''} onChange={e => setEdits(p => ({ ...p, [k]: e.target.value }))} disabled={saving} />
          </label>
        ))}
        <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          UPI QR code
          {shownQr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shownQr} alt="UPI QR code" width={140} height={140} style={{ objectFit: 'contain', border: '1px solid #ddd' }} />
          ) : <span className={cc.muted}>No QR uploaded yet.</span>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input type="file" accept="image/png,image/jpeg" onChange={e => void pick(e.target.files?.[0])} disabled={saving} aria-label="Upload the UPI QR image" />
            {shownQr && <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setQr(null)} disabled={saving}>Remove QR</button>}
          </div>
        </div>
        <div><button type="button" className="boe-btn boe-btn-primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save payment details'}</button></div>
      </div>
      {error && <div className={cc.error} role="alert">{error}</div>}
      {saved && <div className={cc.muted} role="status" style={{ fontSize: 12.5 }}>{saved}</div>}
    </CcSection>
  )
}
