'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Image as ImageIcon, Sparkles } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { fetchAllRows } from '@/lib/supabasePaging'
import { REVIEWS_PER_BATCH } from '@/lib/customerReviews/reviewTypes'
import { StackSkeleton, StatSkeleton } from '@/components/customerReviews/ReviewSkeletons'

// ── "What needs my attention?" ───────────────────────────────────────────────
//
// THE ONE QUESTION THIS PAGE ANSWERS, and the reason it is the verifier's
// landing page rather than a queue. It used to be that opening the module
// dropped you straight into the Available list with a generator, three
// foldaways and a five-tab strip stacked above it — everything at once, and
// therefore no answer to anything.
//
// NOT A DASHBOARD. Four counts and a short list of what to do about them. No
// charts, no percentages, no trends, no employee ranking. Every line is
// clickable and lands on the workspace that fixes it.
//
// ONE QUERY. Four narrow columns over the live cards — no review text, no
// joins, no signed URLs, no employee progress and no image thumbnails. This
// page must be cheap, because it is the page every visit starts on.

type Row = {
  status: string
  review_type: string
  assigned_to: string | null
  image_group_id: string | null
  batch_id: string | null
  deleted_at: string | null
}

type Attention = {
  pending: number
  toVerify: number
  waitingImages: number
  batchesReady: number
  /** Reviews assigned to the VIEWER. A verifier can hold a batch like anybody else. */
  mine: number
}

const EMPTY: Attention = { pending: 0, toVerify: 0, waitingImages: 0, batchesReady: 0, mine: 0 }

export function OverviewScreen() {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()

  const [counts, setCounts] = useState<Attention | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    const result = await fetchAllRows<Row>(
      (from, to) => supabase
        .from('customer_review_test_cards')
        .select('status, review_type, assigned_to, image_group_id, batch_id, deleted_at')
        .in('status', ['pending_approval', 'available', 'submitted'])
        .is('deleted_at', null)
        .range(from, to),
    )
    if (!result.ok) { setFailed(true); setCounts(EMPTY); return }

    const rows = result.rows
    // A BATCH IS READY TO ASSIGN when every one of its live reviews is approved
    // and unassigned, and there are twelve of them — the same rule
    // assign_customer_review_batch() enforces. Counted here so the line says
    // something the Batches page will actually let them do.
    const byBatch = new Map<string, { eligible: number; live: number }>()
    for (const r of rows) {
      if (!r.batch_id) continue
      const e = byBatch.get(r.batch_id) ?? { eligible: 0, live: 0 }
      e.live++
      if (r.status === 'available' && r.assigned_to === null) e.eligible++
      byBatch.set(r.batch_id, e)
    }

    setFailed(false)
    setCounts({
      pending: rows.filter(r => r.status === 'pending_approval').length,
      toVerify: rows.filter(r => r.status === 'submitted').length,
      waitingImages: rows.filter(r =>
        r.review_type === 'image' && r.status === 'available' && r.image_group_id === null).length,
      batchesReady: [...byBatch.values()].filter(v => v.eligible === REVIEWS_PER_BATCH).length,
      // Counted from the rows already in hand — no extra request.
      mine: profile ? rows.filter(r => r.assigned_to === profile.id).length : 0,
    })
  }, [supabase, profile])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  if (authLoading) return <LoadingScreen />

  const c = counts ?? EMPTY
  const items = [
    { n: c.pending, one: 'review pending approval', many: 'reviews pending approval', to: '/customer-reviews/reviews?tab=pending' },
    { n: c.toVerify, one: 'review waiting for verification', many: 'reviews waiting for verification', to: '/customer-reviews/reviews?tab=to_verify' },
    { n: c.waitingImages, one: 'image review waiting for project images', many: 'image reviews waiting for project images', to: '/customer-reviews/images' },
    { n: c.batchesReady, one: 'approved batch ready to assign', many: 'approved batches ready to assign', to: '/customer-reviews/batches' },
    // A VERIFIER'S OWN WORK. Shown only when they have some, because for most
    // verifiers it is always zero and a permanent line reading 0 is noise.
    { n: c.mine, one: 'review assigned to you', many: 'reviews assigned to you', to: '/customer-reviews/mine' },
  ].filter(i => i.n > 0)

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Overview"
      subtitle="What needs your attention"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px' }}>

        {failed && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>
            The summary could not be loaded. Refresh to try again.
          </p>
        )}

        {counts === null ? <StatSkeleton count={4} /> : (
        <div style={{
          display: 'grid', gap: '10px',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))',
        }}>
          <Stat label="Pending approval" value={counts ? c.pending : null} onClick={() => router.push('/customer-reviews/reviews?tab=pending')} />
          <Stat label="To verify" value={counts ? c.toVerify : null} onClick={() => router.push('/customer-reviews/reviews?tab=to_verify')} />
          <Stat label="Waiting for images" value={counts ? c.waitingImages : null} tone="#92400E" onClick={() => router.push('/customer-reviews/images')} />
          <Stat label="Batches ready to assign" value={counts ? c.batchesReady : null} onClick={() => router.push('/customer-reviews/batches')} />
        </div>
        )}

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => router.push('/customer-reviews/batches')}
            className="boe-btn boe-btn-primary"
            style={{ fontSize: '13px', padding: '11px 18px', minHeight: '44px' }}
          >
            <Sparkles size={14} strokeWidth={2} /> Generate batch
          </button>
          <button
            type="button"
            onClick={() => router.push('/customer-reviews/images')}
            className="boe-btn boe-btn-ghost"
            style={{ fontSize: '13px', padding: '11px 18px', minHeight: '44px' }}
          >
            <ImageIcon size={14} strokeWidth={2} /> Manage images
          </button>
        </div>

        <section style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
          <h2 style={{
            margin: 0, fontSize: '13px', fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: colors.primary,
          }}>
            Needs attention
          </h2>

          {counts === null ? (
            <StackSkeleton count={3} height={46} />
          ) : items.length === 0 ? (
            <p style={{
              margin: 0, padding: '18px', borderRadius: '9px', fontSize: '13px',
              border: `1px dashed ${colors.border}`, color: colors.muted,
            }}>
              Nothing needs attention right now.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {items.map(i => (
                <li key={i.to}>
                  <button
                    type="button"
                    onClick={() => router.push(i.to)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
                      padding: '12px 14px', minHeight: '46px', textAlign: 'left',
                      borderRadius: '9px', border: `1px solid ${colors.border}`,
                      background: '#FFFFFF', cursor: 'pointer',
                      fontSize: '13px', color: colors.primary, fontFamily: 'inherit',
                    }}
                  >
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{i.n}</strong>
                    <span>{i.n === 1 ? i.one : i.many}</span>
                    <ArrowRight size={14} style={{ marginLeft: 'auto', color: colors.muted, flexShrink: 0 }} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </CustomerReviewsLayout>
  )
}

function Stat({ label, value, tone, onClick }: {
  label: string
  value: number | null
  tone?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', gap: '3px', textAlign: 'left',
        padding: '13px 15px', borderRadius: '10px', minHeight: '72px',
        border: `1px solid ${colors.borderSoft}`, background: colors.base,
        cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <span style={{
        fontSize: '24px', fontWeight: 700, lineHeight: 1.1,
        color: value ? (tone ?? colors.primary) : colors.muted,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value ?? '—'}
      </span>
      <span style={{ fontSize: '11px', color: colors.secondary }}>{label}</span>
    </button>
  )
}
