'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ClipboardList, Loader2, MessageCircle, Phone, RotateCcw, X } from 'lucide-react'
import { InventoryLayout } from '@/components/layout/InventoryLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { Toast, useToast } from '@/components/ui/toast'
import { useInventory } from '@/hooks/useInventory'
import { INVENTORY_KEY, bookingsKey, cancelBooking, decideBooking, fetchBookings } from '@/lib/inventory/api'
import type { Booking } from '@/lib/inventory/constants'
import { errorMessage } from '@/lib/inventory/errors'
import { formatPhone, formatPrice, shortDateTime } from '@/lib/inventory/format'
import { imageUrl } from '@/lib/inventory/images'
import { waLink } from '@/lib/inventory/whatsapp'
import { BookingBadge, Notice, Pic, QtyStepper, Sheet } from './parts'
import s from './inventory.module.css'

type Tab = 'pending' | 'confirmed' | 'closed'
type Action = { kind: 'confirm' | 'reject' | 'cancel' | 'reverse'; booking: Booking }

const TABS: { value: Tab; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'closed', label: 'Closed' },
]
const inTab = (b: Booking, t: Tab) =>
  t === 'pending' ? b.status === 'pending' : t === 'confirmed' ? b.status === 'confirmed' : b.status === 'rejected' || b.status === 'cancelled'

export default function RequestsScreen() {
  const { supabase, profile, loading, signOut, access, pending } = useInventory()
  const qc = useQueryClient()
  const { toast, show, dismiss } = useToast()
  // A notification links here with ?request=<booking id>: open the tab that booking is in, scroll to it once,
  // and flash it. The id grants nothing: the list is whatever the database lets this person see.
  const target = useSearchParams().get('request')
  const [tabPick, setTab] = useState<Tab | null>(null)
  const scrolled = useRef(false)
  const [action, setAction] = useState<Action | null>(null)

  const scope = access.approve ? 'all' : 'mine'
  const listQ = useQuery({
    queryKey: bookingsKey(scope), queryFn: () => fetchBookings(supabase, scope), enabled: !loading,
    staleTime: 10_000, refetchOnWindowFocus: true,
  })
  const toUrl = useCallback((p: string) => imageUrl(supabase, p), [supabase])
  const all = useMemo(() => listQ.data ?? [], [listQ.data])
  const counts = useMemo(() => ({
    pending: all.filter(b => inTab(b, 'pending')).length,
    confirmed: all.filter(b => inTab(b, 'confirmed')).length,
    closed: all.filter(b => inTab(b, 'closed')).length,
  }), [all])
  const targetBooking = target ? all.find(b => b.id === target) : undefined
  const tab: Tab = tabPick ?? (targetBooking ? (['pending', 'confirmed'] as const).find(t => inTab(targetBooking, t)) ?? 'closed' : 'pending')
  const shown = useMemo(() => all.filter(b => inTab(b, tab)), [all, tab])

  if (loading) return <LoadingScreen />

  const mine = (b: Booking) => b.requested_by === profile?.id
  const done = async (message: string) => {
    setAction(null)
    show(message)
    await qc.invalidateQueries({ queryKey: INVENTORY_KEY })
  }

  return (
    <InventoryLayout profile={profile} access={access} pending={pending} onSignOut={signOut}
      title={access.approve ? 'Booking Requests' : 'My Requests'}
      subtitle={access.approve ? 'Confirm or reject what the sales team asks for' : 'What you have asked the manager to book'}>
      <div className={s.wrap}>
        <div className={s.seg} role="tablist" aria-label="Request status">
          {TABS.map(t => (
            <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={`${s.segBtn}${tab === t.value ? ` ${s.segOn}` : ''}`} onClick={() => setTab(t.value)}>
              {t.label}
              {counts[t.value] > 0 && (t.value === 'pending' ? <span className={s.segCount}>{counts[t.value]}</span> : <span className={s.chipCount}>{counts[t.value]}</span>)}
            </button>
          ))}
        </div>

        {listQ.isError && <Notice kind="err">{errorMessage(listQ.error)} <button type="button" className={s.linkBtn} onClick={() => listQ.refetch()}>Try again</button></Notice>}

        {listQ.isLoading ? (
          <div className={s.reqList} aria-busy="true">{[0, 1, 2].map(i => <div key={i} className={s.skel} style={{ height: 150, borderRadius: 12 }} />)}</div>
        ) : shown.length === 0 ? (
          <div className={s.empty}>
            <div className={s.emptyIcon}><ClipboardList size={26} /></div>
            <div className={s.emptyTitle}>{tab === 'pending' ? 'Nothing waiting' : tab === 'confirmed' ? 'No confirmed bookings yet' : 'Nothing closed'}</div>
            <div className={s.emptyText}>
              {tab === 'pending'
                ? access.approve ? 'New booking requests from the sales team show up here the moment they are sent.' : 'When you request a product from its page, it waits here for the manager.'
                : tab === 'confirmed' ? 'Confirmed sales appear here.' : 'Rejected and cancelled requests appear here.'}
            </div>
            <Link href="/inventory" className={`${s.btn} ${s.btnDark}`}>Browse stock</Link>
          </div>
        ) : (
          <div className={s.reqList}>
            {shown.map(b => (
              <article key={b.id} id={`req-${b.id}`} className={`${s.reqCard}${b.id === target ? ` ${s.reqFlash}` : ''}`}
                ref={el => { if (el && b.id === target && !scrolled.current) { scrolled.current = true; el.scrollIntoView({ block: 'center' }) } }} aria-label={`${b.qty} × ${b.item_name} for ${b.customer_name}`}>
                <div className={s.reqTop}>
                  <Link href={`/inventory/${b.item_id}`} className={s.reqThumb} aria-label={`Open ${b.item_name}`}>
                    <Pic src={b.thumb_path ? toUrl(b.thumb_path) : null} alt={b.item_name} />
                  </Link>
                  <div className={s.reqMain}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                      <Link href={`/inventory/${b.item_id}`} className={s.reqName}>{b.item_name}</Link>
                      <BookingBadge status={b.status} />
                    </div>
                    <span className={s.cardCode}>{b.product_code}</span>
                    <span className={s.reqQty}>{b.qty} × {formatPrice(b.price)} = <strong>{formatPrice(Number(b.price) * b.qty)}</strong></span>
                  </div>
                </div>

                <div className={s.reqCust}>
                  <span className={s.reqCustName}>{b.customer_name}</span>
                  {b.customer_phone && (
                    <div className={s.reqLinks}>
                      <a className={s.reqLink} href={`tel:${b.customer_phone}`}><Phone size={14} /> {formatPhone(b.customer_phone)}</a>
                      <a className={s.reqLink} href={waLink(b.status === 'confirmed' ? `Hello ${b.customer_name}, your booking of ${b.qty} × ${b.item_name} (${b.product_code}) is confirmed.` : '', b.customer_phone)} target="_blank" rel="noopener noreferrer"><MessageCircle size={14} /> WhatsApp</a>
                    </div>
                  )}
                  {b.note && <div className={s.reqNote}>{b.note}</div>}
                </div>

                <div className={s.reqMeta}>
                  Requested by {mine(b) ? 'you' : b.requester_name} · {shortDateTime(b.requested_at)}
                  {b.decided_at && b.status !== 'pending' && <><br />{b.status === 'confirmed' ? 'Confirmed' : b.status === 'rejected' ? 'Rejected' : 'Cancelled'} by {b.decided_by === profile?.id ? 'you' : b.decider_name ?? 'someone'} · {shortDateTime(b.decided_at)}</>}
                  {b.decision_note && <><br />“{b.decision_note}”</>}
                </div>

                {b.status === 'pending' && access.approve && (
                  <div className={s.reqActions}>
                    <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setAction({ kind: 'confirm', booking: b })}><Check size={18} /> Confirm</button>
                    <button type="button" className={s.btn} onClick={() => setAction({ kind: 'reject', booking: b })}><X size={18} /> Reject</button>
                  </div>
                )}
                {b.status === 'pending' && !access.approve && mine(b) && (
                  <div className={s.reqActions}><button type="button" className={s.btn} onClick={() => setAction({ kind: 'cancel', booking: b })}>Cancel request</button></div>
                )}
                {b.status === 'confirmed' && access.approve && (
                  <div className={s.reqActions}><button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => setAction({ kind: 'reverse', booking: b })}><RotateCcw size={15} /> Reverse sale</button></div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      {action && <ActionSheet action={action} supabase={supabase} onClose={() => setAction(null)} onDone={done} />}
      <Toast toast={toast} onDismiss={dismiss} />
    </InventoryLayout>
  )
}

function ActionSheet({
  action, supabase, onClose, onDone,
}: { action: Action; supabase: ReturnType<typeof useInventory>['supabase']; onClose: () => void; onDone: (message: string) => Promise<void> }) {
  const { kind, booking: b } = action
  const [qty, setQty] = useState(b.qty)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The units this request already holds, plus whatever is free, is the most it can become.
  const max = b.qty + Math.max(b.item_available, 0)

  const run = useMutation({
    mutationFn: async () => {
      if (kind === 'confirm') return decideBooking(supabase, b.id, 'confirm', { qty, note })
      if (kind === 'reject') return decideBooking(supabase, b.id, 'reject', { note })
      return cancelBooking(supabase, b.id, note)
    },
    onSuccess: () => onDone(
      kind === 'confirm' ? `Confirmed: ${qty} × ${b.item_name} sold` : kind === 'reject' ? 'Request rejected, units released'
        : kind === 'cancel' ? 'Request cancelled' : 'Sale reversed, units back in stock'),
    onError: e => setError(errorMessage(e)),
  })

  const needNote = kind === 'reverse'
  const noteMissing = needNote && !note.trim()
  const titles = { confirm: 'Confirm this booking', reject: 'Reject this request', cancel: 'Cancel your request', reverse: 'Reverse this sale' }
  const cta = { confirm: 'Confirm sale', reject: 'Reject request', cancel: 'Cancel request', reverse: 'Reverse sale' }

  return (
    <Sheet title={titles[kind]} subtitle={`${b.product_code} · ${b.item_name} · ${b.customer_name}`} busy={run.isPending} onClose={onClose}
      footer={<>
        <button type="button" className={s.btn} onClick={onClose} disabled={run.isPending}>Back</button>
        <button type="button" className={`${s.btn} ${kind === 'confirm' ? s.btnPrimary : kind === 'reverse' || kind === 'reject' ? s.btnDanger : s.btnDark}`}
          onClick={() => { setError(null); run.mutate() }} disabled={run.isPending || noteMissing}>
          {run.isPending && <Loader2 size={17} className={s.spin} />} {cta[kind]}
        </button>
      </>}>
      {kind === 'confirm' && (
        <div className={s.field}>
          <span className={s.label}>Units to sell</span>
          <QtyStepper value={qty} onChange={setQty} min={1} max={max} label="Units to sell" />
          <div className={s.hint}>
            {qty === b.qty ? `${b.customer_name} asked for ${b.qty}. You can change it.`
              : qty < b.qty ? `${b.qty - qty} unit${b.qty - qty === 1 ? '' : 's'} will go back to available.`
              : `${qty - b.qty} more than requested, taken from available stock.`}
          </div>
        </div>
      )}
      {kind === 'reverse' && <Notice kind="warn">{b.qty} unit{b.qty === 1 ? '' : 's'} will go back to available stock and the booking is marked cancelled.</Notice>}
      {kind === 'reject' && <Notice kind="info">The {b.qty} reserved unit{b.qty === 1 ? '' : 's'} go back to available.</Notice>}
      <div className={s.field}>
        <label className={s.label} htmlFor="a-note">{needNote ? 'Reason' : 'Note'}{needNote && <span className={s.req}> *</span>}</label>
        <textarea id="a-note" className={s.textarea} value={note} onChange={e => setNote(e.target.value)} maxLength={500} style={{ minHeight: 72 }}
          placeholder={kind === 'reject' ? 'Why? e.g. already promised to another customer' : kind === 'reverse' ? 'Why is the sale being reversed?' : 'Optional'} />
      </div>
      {error && <Notice kind="err">{error}</Notice>}
    </Sheet>
  )
}
