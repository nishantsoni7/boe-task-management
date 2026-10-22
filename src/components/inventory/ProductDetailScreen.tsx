'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ClipboardList, MessageCircle, Pencil, Search as ZoomIcon, ShoppingBag } from 'lucide-react'
import { InventoryLayout } from '@/components/layout/InventoryLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { Toast, useToast } from '@/components/ui/toast'
import { useInventory } from '@/hooks/useInventory'
import { bookingsKey, fetchBookings, fetchHistory, fetchItem, itemKey, INVENTORY_KEY, itemsKey } from '@/lib/inventory/api'
import type { HistoryEntry, InventoryItem } from '@/lib/inventory/constants'
import { formatPhone, formatPrice, shortDateTime, sortedImages, stockState } from '@/lib/inventory/format'
import { imageUrl } from '@/lib/inventory/images'
import { BookingBadge, ConditionBadge, Lightbox, Notice, Pic, StageBadge, StageTracker, StockBadge } from './parts'
import { BookingSheet, ShareSheet } from './sheets'
import s from './inventory.module.css'
import { useQueryClient } from '@tanstack/react-query'

function describe(h: HistoryEntry): { title: string; sub: string } {
  const d = h.detail as { qty?: number; qty_total?: number; customer?: string; fields?: string[]; note?: string | null; requested_qty?: number }
  switch (h.action) {
    case 'created': return { title: 'Product added', sub: d.qty_total != null ? `${d.qty_total} in stock` : '' }
    case 'updated': return { title: 'Updated', sub: Array.isArray(d.fields) ? d.fields.join(', ') : '' }
    case 'deleted': return { title: 'Product deleted', sub: '' }
    case 'requested': return { title: `Booking requested: ${d.qty} unit${d.qty === 1 ? '' : 's'}`, sub: d.customer ?? '' }
    case 'confirmed': return { title: `Sale confirmed: ${d.qty} unit${d.qty === 1 ? '' : 's'}`, sub: [d.customer, d.requested_qty && d.requested_qty !== d.qty ? `asked for ${d.requested_qty}` : '', d.note].filter(Boolean).join(' · ') }
    case 'rejected': return { title: `Request rejected: ${d.qty} unit${d.qty === 1 ? '' : 's'}`, sub: d.note ?? '' }
    case 'cancelled': return { title: `Request cancelled: ${d.qty} unit${d.qty === 1 ? '' : 's'}`, sub: d.note ?? '' }
    case 'reversed': return { title: `Sale reversed: ${d.qty} unit${d.qty === 1 ? '' : 's'} back in stock`, sub: d.note ?? '' }
  }
}

export default function ProductDetailScreen() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const qc = useQueryClient()
  const { supabase, profile, loading, signOut, access, pending } = useInventory()
  const { toast, show, dismiss } = useToast()

  const itemQ = useQuery({
    queryKey: itemKey(id), queryFn: () => fetchItem(supabase, id), enabled: !loading, staleTime: 15_000,
    initialData: () => qc.getQueryData<InventoryItem[]>(itemsKey)?.find(i => i.id === id),
    initialDataUpdatedAt: () => qc.getQueryState(itemsKey)?.dataUpdatedAt,
  })
  const item = itemQ.data ?? null

  const mineQ = useQuery({
    queryKey: bookingsKey(access.approve ? 'all-pending' : 'mine', id),
    queryFn: () => access.approve
      ? fetchBookings(supabase, 'all', { itemId: id, statuses: ['pending'] })
      : fetchBookings(supabase, 'mine', { itemId: id, statuses: ['pending', 'confirmed'] }),
    enabled: !loading && !!item, staleTime: 15_000,
  })
  const historyQ = useQuery({
    queryKey: [...INVENTORY_KEY, 'history', id], queryFn: () => fetchHistory(supabase, id),
    enabled: !loading && !!item && (access.approve || access.edit), staleTime: 15_000,
  })

  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(false)
  const [booking, setBooking] = useState(false)
  const [sharing, setSharing] = useState(false)

  const toUrl = useCallback((p: string) => imageUrl(supabase, p), [supabase])
  const urls = useMemo(() => (item ? sortedImages(item).map(i => toUrl(i.path)) : []), [item, toUrl])

  // "Saved" arrives as ?saved=created|updated from the form; show it once, then tidy the address.
  const savedFlag = search.get('saved')
  useEffect(() => {
    if (!savedFlag) return
    show(savedFlag === 'created' ? 'Product added' : 'Changes saved')
    router.replace(pathname, { scroll: false })
  }, [savedFlag, show, router, pathname])

  if (loading || (itemQ.isLoading && !item)) return <LoadingScreen />

  const layoutProps = { profile, access, pending, onSignOut: signOut }

  if (!item) {
    return (
      <InventoryLayout {...layoutProps} title="Product">
        <div className={s.wrapNarrow}>
          <Link href="/inventory" className={s.back}><ChevronLeft size={18} /> Back to stock</Link>
          <div className={s.empty}>
            <div className={s.emptyTitle}>Product not found</div>
            <div className={s.emptyText}>It may have been deleted, or you do not have access to it.</div>
            <Link href="/inventory" className={`${s.btn} ${s.btnDark}`}>Back to stock</Link>
          </div>
        </div>
      </InventoryLayout>
    )
  }

  const soldOut = item.qty_available <= 0
  const pct = (n: number) => (item.qty_total > 0 ? (n / item.qty_total) * 100 : 0)
  const st = stockState(item)
  const bookingButton = (
    <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setBooking(true)} disabled={soldOut}>
      <ShoppingBag size={18} /> {soldOut ? 'Sold out' : access.approve ? 'Book / sell' : 'Request to book'}
    </button>
  )
  const shareButton = (
    <button type="button" className={`${s.btn} ${s.btnWa}`} onClick={() => setSharing(true)}>
      <MessageCircle size={18} /> Share on WhatsApp
    </button>
  )

  return (
    <InventoryLayout {...layoutProps} title={item.name} subtitle={item.product_code}
      actions={access.edit ? <Link href={`/inventory/${item.id}/edit`} className={`${s.btn} ${s.btnSm}`}><Pencil size={15} /> Edit</Link> : undefined}>
      <div className={`${s.wrap} ${s.detailPad}`}>
        <Link href="/inventory" className={s.back}><ChevronLeft size={18} /> Back to stock</Link>

        <div className={s.detail}>
          <div className={s.gallery}>
            <button type="button" className={s.mainImg} onClick={() => urls.length && setZoom(true)} aria-label={`Open pictures of ${item.name}`}>
              <Pic src={urls[index] ?? null} alt={item.name} eager />
              {urls.length > 0 && <span className={s.mainHint}><ZoomIcon size={14} /> {urls.length > 1 ? `${index + 1} / ${urls.length}` : 'View'}</span>}
            </button>
            {urls.length > 1 && (
              <div className={s.thumbs} role="tablist" aria-label="Pictures">
                {urls.map((u, i) => (
                  <button key={u} type="button" role="tab" aria-selected={i === index} className={`${s.thumb}${i === index ? ` ${s.thumbOn}` : ''}`} onClick={() => setIndex(i)} aria-label={`Picture ${i + 1}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={s.info}>
            <div className={s.panel}>
              <div className={s.codeLine}><span className={s.code}>{item.product_code}</span>{item.category && <span className={s.hint}>{item.category}</span>}</div>
              <h2 className={s.title}>{item.name}</h2>
              <div className={s.codeLine}><StageBadge stage={item.stage} /><ConditionBadge condition={item.condition} /><StockBadge item={item} /></div>
              <div>
                <div className={s.priceRows}>
                  <div className={s.priceRow}>
                    <span className={s.priceLabel}>Retail price</span>
                    <span className={s.bigPrice}>{formatPrice(item.retail_price)}</span>
                    <span className={s.bigPriceNote}>per piece · includes taxes, transportation and packaging</span>
                  </div>
                  <div className={s.priceRow}>
                    <span className={s.priceLabel}>Standard price</span>
                    <span className={s.stdPrice}>{formatPrice(item.price)}</span>
                    <span className={s.bigPriceNote}>per piece · product with basic packaging</span>
                  </div>
                </div>
                {item.qty_available > 1 && <div className={s.bigPriceNote}>{formatPrice(Number(item.retail_price) * item.qty_available)} retail for all {item.qty_available} available</div>}
              </div>
              <div className={`${s.actions} ${s.actionsDesktop}`}>{bookingButton}{shareButton}</div>
            </div>

            <div className={s.panel}>
              <div className={s.panelTitle}>Availability</div>
              <div className={s.avail}>
                <div className={s.availNums}>
                  <div className={`${s.availNum} ${st === 'out' ? s.availOut : s.availGood}`}><span className={s.availNumVal}>{item.qty_available}</span><span className={s.availNumLbl}>Available</span></div>
                  <div className={s.availNum}><span className={s.availNumVal}>{item.qty_reserved}</span><span className={s.availNumLbl}>Reserved</span></div>
                  <div className={s.availNum}><span className={s.availNumVal}>{item.qty_sold}</span><span className={s.availNumLbl}>Sold</span></div>
                  <div className={s.availNum}><span className={s.availNumVal}>{item.qty_total}</span><span className={s.availNumLbl}>Total</span></div>
                </div>
                <div className={s.bar} role="img" aria-label={`${item.qty_sold} sold, ${item.qty_reserved} reserved, ${item.qty_available} available of ${item.qty_total}`}>
                  <div className={s.barSold} style={{ width: `${pct(item.qty_sold)}%` }} />
                  <div className={s.barRes} style={{ width: `${pct(item.qty_reserved)}%` }} />
                  <div className={s.barFree} style={{ width: `${pct(item.qty_available)}%` }} />
                </div>
                <div className={s.barLegend}>
                  <span><i className={s.legendDot} style={{ background: '#303536' }} />Sold</span>
                  <span><i className={s.legendDot} style={{ background: '#F5A524' }} />Reserved (waiting)</span>
                  <span><i className={s.legendDot} style={{ background: '#276247' }} />Available</span>
                </div>
              </div>
            </div>

            <div className={s.panel}>
              <div className={s.panelTitle}>Where it stands</div>
              <StageTracker item={item} />
            </div>

            <div className={s.panel}>
              <div className={s.panelTitle}>Details</div>
              <dl className={s.specs}>
                <div className={s.spec}><dt>Size</dt><dd>{item.size_text}</dd></div>
                <div className={s.spec}><dt>Material</dt><dd>{item.material}</dd></div>
                <div className={s.spec}><dt>Condition</dt><dd>{<ConditionBadge condition={item.condition} />}</dd></div>
                {item.category && <div className={s.spec}><dt>Category</dt><dd>{item.category}</dd></div>}
              </dl>
              {item.description && <div className={s.notes}>{item.description}</div>}
            </div>

            {(mineQ.data?.length ?? 0) > 0 && (
              <div className={s.panel}>
                <div className={s.panelTitle}>{access.approve ? 'Waiting for a decision' : 'Your requests for this product'}</div>
                <ul className={s.history}>
                  {mineQ.data!.map(b => (
                    <li key={b.id} className={s.historyRow}>
                      <span className={s.historyDot} style={{ background: b.status === 'confirmed' ? '#276247' : '#F5A524' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className={s.historyMain}>{b.qty} × for {b.customer_name} {b.customer_phone ? `· ${formatPhone(b.customer_phone)}` : ''}</div>
                        <div className={s.historySub}>{access.approve ? `${b.requester_name} · ` : ''}{shortDateTime(b.requested_at)}</div>
                      </div>
                      <BookingBadge status={b.status} />
                    </li>
                  ))}
                </ul>
                <Link href="/inventory/requests" className={`${s.btn} ${s.btnSm}`} style={{ alignSelf: 'flex-start' }}><ClipboardList size={15} /> {access.approve ? 'Review requests' : 'My requests'}</Link>
              </div>
            )}

            {(access.approve || access.edit) && (
              <div className={s.panel}>
                <div className={s.panelTitle}>History</div>
                {historyQ.isLoading ? <div className={s.hint}>Loading…</div>
                  : (historyQ.data?.length ?? 0) === 0 ? <div className={s.hint}>No changes recorded yet.</div>
                  : (
                    <ul className={s.history}>
                      {historyQ.data!.map(h => {
                        const d = describe(h)
                        return (
                          <li key={h.id} className={s.historyRow}>
                            <span className={s.historyDot} />
                            <div style={{ minWidth: 0 }}>
                              <div className={s.historyMain}>{d.title}</div>
                              <div className={s.historySub}>{[d.sub, `${h.actor ?? 'Someone'} · ${shortDateTime(h.at)}`].filter(Boolean).join(' · ')}</div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
              </div>
            )}

            {itemQ.isError && <Notice kind="err">This page could not be refreshed. What you see may be out of date.</Notice>}
          </div>
        </div>
      </div>

      <div className={s.stickyActions}>{bookingButton}{shareButton}</div>

      {zoom && urls.length > 0 && <Lightbox urls={urls} index={index} alt={item.name} onClose={() => setZoom(false)} onIndex={setIndex} />}
      {booking && <BookingSheet item={item} supabase={supabase} canConfirmNow={access.approve} onClose={() => setBooking(false)} />}
      {sharing && <ShareSheet item={item} supabase={supabase} onClose={() => setSharing(false)} />}
      <Toast toast={toast} onDismiss={dismiss} />
    </InventoryLayout>
  )
}
