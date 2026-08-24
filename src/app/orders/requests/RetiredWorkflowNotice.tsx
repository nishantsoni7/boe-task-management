'use client'

// ── The retired Order Request workflow, explained once ────────────────────────
//
// WHY A PAGE AND NOT A 404. Order Requests were a real workflow for months:
// there are bookmarks, notification deep links (`order_submitted`,
// `order_assigned`, `order_clarification`, …, all of which carry a request id),
// and links in other people's messages. A 404 tells somebody their link is
// broken; a blank redirect tells them nothing happened. Neither says the thing
// that is actually true — the workflow was retired, and here is what replaced
// it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It offers no way back in. There is no
// "create", no list, no status filter, no conversion and no per-request detail:
// those are the retired workflow, and a screen that still drew them would be an
// invitation to start something the database now refuses to finish
// (20261007000000). The single action is the one that replaces it.
//
// THE ONE EXCEPTION IS PROVENANCE, and it is a READ. A request that was
// converted before the retirement became a Confirmed Order that still exists and
// still opens. Where the caller can see that Order, this offers it — quietly,
// as a second action — so an old deep link lands on the record it is actually
// about rather than on a dead end. The lookup runs under the reader's own RLS
// and names nothing they may not open.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Archive } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

/** Where the retired workflow's users are sent instead. */
export const PI_DRAFTS_PATH = '/orders/drafts'

/** The one action this page offers. Named once so the tests read the product's word. */
export const OPEN_PI_DRAFTS_LABEL = 'Open PI Drafts'

export const RETIRED_HEADING = 'Order Requests are retired'

export const RETIRED_EXPLANATION =
  'Orders no longer start from a request. Upload the PI instead: it is saved as '
  + 'a PI Draft, submitted for review, settled with Finance, and becomes a '
  + 'Confirmed Order once it is approved. Anything not yet approved stays under '
  + 'PI Drafts.'

/**
 * The Confirmed Order a retired request became, when there is one and the reader
 * may open it.
 *
 * `converted_order_id` is read from `order_requests` under the reader's own RLS,
 * and the Order's number from `orders` under its own — so a reader who may see
 * neither simply gets nothing, and this can name no record they could not
 * already open. It is never an error: a request that was never converted, was
 * deleted, or belongs to somebody else all resolve to null, and the page then
 * shows only its single action.
 */
async function resolveConvertedOrder(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
): Promise<{ id: string; number: string | null } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return null

  const { data: request } = await supabase
    .from('order_requests')
    .select('converted_order_id')
    .eq('id', requestId)
    .maybeSingle()

  const orderId = (request as { converted_order_id: string | null } | null)?.converted_order_id
  if (!orderId) return null

  const { data: order } = await supabase
    .from('orders')
    .select('id, display_number')
    .eq('id', orderId)
    .maybeSingle()

  const row = order as { id: string; display_number: string | null } | null
  return row ? { id: row.id, number: row.display_number } : null
}

export function RetiredWorkflowNotice({ requestId }: { requestId?: string }) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [converted, setConverted] = useState<{ id: string; number: string | null } | null>(null)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      // Both reads in one group: the provenance lookup needs nothing from the
      // profile, and neither blocks the other.
      const [{ data: me }, order] = await Promise.all([
        supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single(),
        requestId ? resolveConvertedOrder(supabase, requestId).catch(() => null) : Promise.resolve(null),
      ])

      setProfile(me as UserProfile)
      setConverted(order)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  return (
    <OrdersLayout
      profile={profile}
      title="Order Requests"
      subtitle="This workflow has been retired."
      onSignOut={handleSignOut}
      showRefresh={false}
    >
      <div
        className="boe-card"
        style={{
          maxWidth: '560px',
          margin: '0 auto',
          padding: '28px 24px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '14px',
          textAlign: 'center',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 40, height: 40, borderRadius: '10px',
          background: colors.raised, border: `1px solid ${colors.border}`,
          color: colors.muted, flexShrink: 0,
        }}>
          <Archive size={18} strokeWidth={1.8} />
        </div>

        <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>
          {RETIRED_HEADING}
        </div>

        <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.65, maxWidth: '440px' }}>
          {RETIRED_EXPLANATION}
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '4px' }}>
          <button
            className="boe-btn boe-btn-primary"
            onClick={() => router.replace(PI_DRAFTS_PATH)}
            style={{ padding: '8px 16px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <FileText size={13} strokeWidth={2.2} />
            {OPEN_PI_DRAFTS_LABEL}
          </button>

          {/* Provenance, quietly. Shown only when this reader can already open
              that Order — the two lookups above run under their own RLS — so it
              names nothing they were not already entitled to see. */}
          {converted && (
            <button
              className="boe-btn boe-btn-ghost"
              onClick={() => router.replace(`/orders/${converted.id}`)}
              style={{ padding: '8px 16px', fontSize: '13px' }}
            >
              {converted.number ? `Open Order ${converted.number}` : 'Open the Confirmed Order'}
            </button>
          )}
        </div>

        {converted && (
          <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.6 }}>
            This request was converted before the workflow was retired. Its Confirmed
            Order is unaffected.
          </div>
        )}
      </div>
    </OrdersLayout>
  )
}
