'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ClipboardList, Copy, Loader2, MessageCircle, Send } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { INVENTORY_KEY, requestBooking } from '@/lib/inventory/api'
import type { InventoryItem } from '@/lib/inventory/constants'
import { formatPrice, sortedImages } from '@/lib/inventory/format'
import { errorMessage } from '@/lib/inventory/errors'
import { imageUrl } from '@/lib/inventory/images'
import { buildShareMessage, sharePhotoAndText, waLink } from '@/lib/inventory/whatsapp'
import { Notice, QtyStepper, Sheet } from './parts'
import s from './inventory.module.css'

type Supabase = ReturnType<typeof createClient>

// ── Request to book ──────────────────────────────────────────────────────

export function BookingSheet({
  item, supabase, canConfirmNow, onClose,
}: { item: InventoryItem; supabase: Supabase; canConfirmNow: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const requestId = useRef<string>(crypto.randomUUID())
  const [qty, setQty] = useState(1)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [confirmNow, setConfirmNow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [done, setDone] = useState<null | 'pending' | 'confirmed'>(null)

  const max = Math.max(item.qty_available, 1)
  const nameErr = tried && !name.trim() ? 'Enter the customer name' : null
  const phoneErr = tried && phone.trim() && !/^\+?[\d\s().-]{8,18}$/.test(phone.trim()) ? 'That phone number does not look right' : null

  const submit = async () => {
    setTried(true)
    if (!name.trim() || (phone.trim() && !/^\+?[\d\s().-]{8,18}$/.test(phone.trim()))) return
    setBusy(true)
    setError(null)
    try {
      const r = await requestBooking(supabase, {
        requestId: requestId.current, itemId: item.id, qty, customerName: name.trim(),
        customerPhone: phone.trim(), note: note.trim(), confirmNow: canConfirmNow && confirmNow,
      })
      await qc.invalidateQueries({ queryKey: INVENTORY_KEY })
      setDone(r.status === 'confirmed' ? 'confirmed' : 'pending')
    } catch (e) {
      setError(errorMessage(e))
      void qc.invalidateQueries({ queryKey: INVENTORY_KEY }) // the numbers may have moved: show the truth
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Sheet title={done === 'confirmed' ? 'Sale recorded' : 'Request sent'} onClose={onClose}
        footer={<>
          <button type="button" className={s.btn} onClick={onClose}>Done</button>
          <Link href="/inventory/requests" className={`${s.btn} ${s.btnDark}`}><ClipboardList size={17} /> View requests</Link>
        </>}>
        <div className={s.success}>
          <div className={s.successIcon}><Check size={34} strokeWidth={3} /></div>
          <div className={s.successTitle}>{qty} × {item.name}</div>
          <div className={s.successText}>
            {done === 'confirmed'
              ? `Confirmed for ${name.trim()}. The stock has been updated.`
              : `${qty} unit${qty === 1 ? ' is' : 's are'} held for ${name.trim()} until the manager confirms. You will see the answer under My Requests.`}
          </div>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet title="Request to book" subtitle={`${item.product_code} · ${item.name}`} busy={busy} onClose={onClose}
      footer={<>
        <button type="button" className={s.btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => void submit()} disabled={busy}>
          {busy ? <><Loader2 size={18} className={s.spin} /> Sending…</> : <><Send size={17} /> {canConfirmNow && confirmNow ? 'Confirm sale' : 'Send request'}</>}
        </button>
      </>}>
      <div className={s.field}>
        <span className={s.label} id="b-qty-l">How many?</span>
        <QtyStepper value={qty} onChange={setQty} min={1} max={max} label="Quantity to book" />
        <div className={s.hint}>{item.qty_available} available · total {formatPrice(Number(item.price) * qty)} at {formatPrice(item.price)} each</div>
      </div>
      <div className={s.field}>
        <label className={s.label} htmlFor="b-name">Customer name <span className={s.req}>*</span></label>
        <input id="b-name" className={`${s.input}${nameErr ? ` ${s.invalid}` : ''}`} value={name} onChange={e => setName(e.target.value)} maxLength={120}
          autoComplete="off" placeholder="e.g. Mr. Rao, Hotel Sai Palace" aria-invalid={!!nameErr} />
        {nameErr && <div className={s.err} role="alert">{nameErr}</div>}
      </div>
      <div className={s.field}>
        <label className={s.label} htmlFor="b-phone">Customer phone</label>
        <input id="b-phone" className={`${s.input}${phoneErr ? ` ${s.invalid}` : ''}`} value={phone} onChange={e => setPhone(e.target.value)} type="tel" inputMode="tel"
          autoComplete="off" placeholder="98765 43210" aria-invalid={!!phoneErr} />
        {phoneErr ? <div className={s.err} role="alert">{phoneErr}</div> : <div className={s.hint}>Optional. Lets the manager call or WhatsApp the customer.</div>}
      </div>
      <div className={s.field}>
        <label className={s.label} htmlFor="b-note">Note for the manager</label>
        <textarea id="b-note" className={s.textarea} value={note} onChange={e => setNote(e.target.value)} maxLength={500}
          placeholder="Delivery city, when they need it, finish changes…" style={{ minHeight: 72 }} />
      </div>
      {canConfirmNow && (
        <label className={s.checkRow}>
          <input type="checkbox" checked={confirmNow} onChange={e => setConfirmNow(e.target.checked)} />
          <span>Confirm the sale right now<br /><span className={s.hint}>Skips the approval step and moves the units straight to sold.</span></span>
        </label>
      )}
      {!canConfirmNow && <Notice kind="info">The units are held for you as soon as you send this, so nobody else can book them while the manager checks.</Notice>}
      {error && <Notice kind="err">{error}</Notice>}
    </Sheet>
  )
}

// ── Share on WhatsApp ────────────────────────────────────────────────────

export function ShareSheet({ item, supabase, onClose }: { item: InventoryItem; supabase: Supabase; onClose: () => void }) {
  const [includePrice, setIncludePrice] = useState(true)
  const [phone, setPhone] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Sharing a file is a phone feature; a desktop gets the link version only. The sheet only ever mounts in the browser.
  const [canShareFiles] = useState(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function')

  const urls = useMemo(() => sortedImages(item).map(i => imageUrl(supabase, i.path)), [item, supabase])
  const text = useMemo(() => buildShareMessage(item, { imageUrls: urls, includePrice }), [item, urls, includePrice])

  const openWa = () => { window.open(waLink(text, phone), '_blank', 'noopener,noreferrer') }

  const sendPhoto = async () => {
    setBusy(true)
    setNote(null)
    // The text for a photo message leaves the picture links out: the picture itself is attached.
    const caption = buildShareMessage(item, { imageUrls: [], includePrice })
    const ok = await sharePhotoAndText(caption, urls[0] ?? null, item.product_code)
    setBusy(false)
    if (!ok) { setNote('Your browser cannot attach the photo, so WhatsApp is opening with the picture link instead.'); openWa() }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setNote('Copy is blocked in this browser. Press and hold the message to copy it.') }
  }

  return (
    <Sheet title="Share on WhatsApp" subtitle={`${item.product_code} · ${item.name}`} onClose={onClose}
      footer={canShareFiles ? (
        <>
          <button type="button" className={s.btn} onClick={openWa}><MessageCircle size={17} /> With photo links</button>
          <button type="button" className={`${s.btn} ${s.btnWa}`} onClick={() => void sendPhoto()} disabled={busy}>
            {busy ? <Loader2 size={18} className={s.spin} /> : <MessageCircle size={18} />} Send photo + details
          </button>
        </>
      ) : (
        <button type="button" className={`${s.btn} ${s.btnWa}`} onClick={openWa}><MessageCircle size={18} /> Open WhatsApp</button>
      )}>
      {urls[0] && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={s.previewImg} src={urls[0]} alt={`Main picture of ${item.name}`} />
      )}
      <pre className={s.preview} aria-label="Message preview">{text}</pre>
      <label className={s.checkRow}>
        <input type="checkbox" checked={includePrice} onChange={e => setIncludePrice(e.target.checked)} />
        <span>Include the price<br /><span className={s.hint}>Turn off to send a catalogue message without it.</span></span>
      </label>
      <div className={s.field}>
        <label className={s.label} htmlFor="w-phone">Customer WhatsApp number</label>
        <input id="w-phone" className={s.input} type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Optional, opens their chat directly" autoComplete="off" />
      </div>
      <button type="button" className={`${s.btn} ${s.btnSm}`} style={{ alignSelf: 'flex-start' }} onClick={() => void copy()}>
        {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy message'}
      </button>
      {note && <Notice kind="info">{note}</Notice>}
    </Sheet>
  )
}
