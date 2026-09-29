'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { OrdersRouteFallback } from '@/components/layout/ModuleRouteFallback'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { getEffectivePermissions } from '@/lib/permissions/resolver'
import {
  deriveOrdersCapabilities,
  NO_ORDERS_CAPABILITIES,
  type OrdersCapabilities,
} from '@/lib/permissions/orders'
import {
  NEW_ORDER_ACTION,
  NO_ORDER_DASHBOARD_COUNTS,
  ORDER_DASHBOARD_SUBTITLE,
  orderDashboardCards,
  type OrderDashboardCounts,
} from '@/lib/orders/orderDashboard'
import {
  DASHBOARD_ERROR_BODY,
  DASHBOARD_ERROR_HEADING,
  DASHBOARD_LOADING_LABEL,
  DASHBOARD_RETRY_LABEL,
  FOCUS_ADD_LABEL,
  listsNote,
  parseDashboardSummary,
  type DashboardSummary,
} from '@/lib/orders/orderDashboardSummary'
import { PI_DRAFT_LIST_STATUSES } from '@/lib/orders/draftsView'
import { DocumentActionQueue } from '@/components/orders/DocumentActionQueue'
import { FactoryFocusSection, FocusRemovedNotices } from '@/components/orders/dashboard/FactoryFocusSection'
import { AdvanceSection, AlignmentSection, FabricFinishSection } from '@/components/orders/dashboard/AttentionSections'
import { ModulePageSkeleton } from '@/components/layout/ModulePageSkeleton'
import { RevenueSection } from '@/components/orders/dashboard/RevenueSection'
import { useViewAs } from '@/contexts/ViewAsContext'

// ── What the summary read is in ───────────────────────────────────────────────

type SummaryState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; summary: DashboardSummary }

export default function OrdersDashboardPage() {
  const [pageLoading, setPageLoading] = useState(true)
  const [profile,     setProfile]     = useState<UserProfile | null>(null)
  // Drives the Upload PI entry point. Starts empty so
  // it cannot flash for somebody who is not allowed it; /orders/import and
  // the review controls each enforce their own grant server-side, because hiding
  // a control is not access control.
  const [ordersCaps, setOrdersCaps] = useState<OrdersCapabilities>(NO_ORDERS_CAPABILITIES)
  const [summary,     setSummary]     = useState<SummaryState>({ kind: 'loading' })
  const [counts,      setCounts]      = useState<OrderDashboardCounts>(NO_ORDER_DASHBOARD_COUNTS)
  // The owner's "Select an order" control opens the Factory Focus form.
  const [focusFormOpen, setFocusFormOpen] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId } = useViewAs()
  // A read that has been overtaken by a newer one must not overwrite it.
  const latest = useRef(0)

  /**
   * THE DASHBOARD'S DATA — ONE SUMMARY READ, and the few queue counts beside it.
   *
   * public.orders_dashboard_summary() (20270221000000) returns Factory Focus, the
   * action groups and revenue in one round trip, computed by the database over the
   * Orders THIS reader may open — including any visibility scope the owner set for
   * them in Control Center. Revenue arrives only for a reader who sees every Order;
   * for anybody else it is null, so nothing is fetched and hidden — it is never sent.
   * Factory Focus arrives for everybody with Orders entry, with detail only for the
   * Orders they may open.
   *
   * ALL OF IT TOGETHER, and none of it depends on another's answer.
   *
   * A FAILED OR UNREADABLE SUMMARY IS AN ERROR STATE, NEVER ZEROS. The lists
   * drawn from it are what tells somebody an order needs them.
   */
  const loadData = async (viewerId: string) => {
    const ticket = ++latest.current
    setSummary(prev => (prev.kind === 'ready' ? prev : { kind: 'loading' }))

    const [
      summaryRes,
      { count: draftCount },
      opsMineRes,
      opsUnassignedRes,
      opsFlaggedRes,
    ] = await Promise.all([
      supabase.rpc('orders_dashboard_summary'),

      // PI Drafts, in exactly the statuses /orders/drafts lists — the same
      // constant, so the link and the page it opens can never describe
      // different sets.
      supabase.from('order_submissions').select('*', { count: 'exact', head: true })
        .in('status', PI_DRAFT_LIST_STATUSES as unknown as string[]),

      // THE OPERATIONS HANDOFF (20261229000000): live, undecided handoffs
      // addressed to THIS reader, to nobody, and the ones flagged for
      // clarification. RLS scopes all three to Orders the reader may open.
      supabase.from('order_operations_handoffs').select('id', { count: 'exact', head: true })
        .eq('status', 'awaiting').is('superseded_at', null).eq('assigned_to', viewerId),
      supabase.from('order_operations_handoffs').select('id', { count: 'exact', head: true })
        .eq('status', 'awaiting').is('superseded_at', null).is('assigned_to', null),
      supabase.from('order_operations_handoffs').select('id', { count: 'exact', head: true })
        .eq('status', 'clarification_needed').is('superseded_at', null),
    ])

    if (ticket !== latest.current) return

    if (summaryRes.error) {
      setSummary({ kind: 'error' })
    } else {
      const parsed = parseDashboardSummary(summaryRes.data)
      setSummary(parsed.ok ? { kind: 'ready', summary: parsed.summary } : { kind: 'error' })
    }

    setCounts({
      ...NO_ORDER_DASHBOARD_COUNTS,
      piDrafts:             draftCount    ?? undefined,
      // THE OPERATIONS HANDOFF DEGRADES TO ABSENT. The table arrives with
      // 20261229000000; against a database without it the filter is refused,
      // and an absent count draws no card rather than a false "nothing waits".
      operationsReview:     opsMineRes.error ? undefined : (opsMineRes.count ?? 0),
      operationsUnassigned: opsUnassignedRes.error ? undefined : (opsUnassignedRes.count ?? 0),
      operationsFlagged:    opsFlaggedRes.error ? undefined : (opsFlaggedRes.count ?? 0),
    })
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      // ONE ROUND TRIP, NOT THREE. The profile, the Orders permission resolver
      // and the dashboard's own data each need only the session's user id, so
      // they run together. The capabilities are still resolved by
      // resolve_effective_permissions in the database and applied before any
      // control renders — pageLoading is not cleared until all have landed.
      const [{ data: me }, ordersPerms] = await Promise.all([
        supabase
          .from('users')
          .select(USER_PROFILE_COLUMNS)
          .eq('id', session.user.id)
          .single(),
        getEffectivePermissions(supabase, session.user.id, 'orders').catch(() => []),
        loadData(session.user.id),
      ])

      setProfile(me as UserProfile)
      setOrdersCaps(deriveOrdersCapabilities(me?.role, ordersPerms))
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (pageLoading) return <OrdersRouteFallback />

  const reload = () => loadData(profile?.id ?? '00000000-0000-0000-0000-000000000000')

  // The queue links: only what somebody is asked to WORK, and only where the
  // reader is offered it. One decision, made in one place
  // (src/lib/orders/orderDashboard.ts).
  const queues = orderDashboardCards({ counts, orders: ordersCaps })

  const ready = summary.kind === 'ready' ? summary.summary : null

  return (
    <OrdersLayout
      profile={profile}
      title="Orders"
      subtitle={ORDER_DASHBOARD_SUBTITLE}
      onSignOut={handleSignOut}
      onRefresh={reload}
      actions={
        <>
          {
            // ── THE ONE WAY A NEW ORDER BEGINS ──
            //
            // "Upload PI", not "New Order": what this control does is upload one
            // document. The Order comes into existence at approval, with a number.
            //
            // /orders/import enforces the same `create` grant in its own right,
            // because hiding a button is not access control.
            ordersCaps.canCreateOrder ? (
              <button
                className="boe-btn boe-btn-primary"
                onClick={() => router.push(NEW_ORDER_ACTION.href)}
                title={NEW_ORDER_ACTION.title}
              >
                <Upload size={13} strokeWidth={2.2} />
                {NEW_ORDER_ACTION.label}
              </button>
            ) : null
          }
          {/* ── FACTORY FOCUS, FOR THE OWNER ── opens the selection form. The database
              refuses anybody else, so this is only a courtesy. */}
          {ready?.viewer.canManageFocus && !viewAsUserId ? (
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setFocusFormOpen(true)}>
              {FOCUS_ADD_LABEL}
            </button>
          ) : null}
        </>
      }
    >
      <div className="od-stack">
        {summary.kind === 'ready' ? (
          <>
            {/* ── FACTORY FOCUS ── directly under the title. Draws nothing when there are
                no active selections (the owner's header control opens the form), and only
                the removal reason for the salesperson it concerns. */}
            <FocusRemovedNotices focus={summary.summary.focus} />
            <FactoryFocusSection
              focus={summary.summary.focus}
              supabase={supabase}
              readOnlyReason={viewAsUserId ? 'View As is read-only' : null}
              addOpen={focusFormOpen}
              onCloseAdd={() => setFocusFormOpen(false)}
              onChanged={reload}
            />
          </>
        ) : null}

        {/* ── WHAT NEEDS INTERVENTION ── */}
        {summary.kind === 'loading' ? (
          <div aria-busy="true" aria-label={DASHBOARD_LOADING_LABEL}>
            <ModulePageSkeleton variant="orders-dashboard" label={DASHBOARD_LOADING_LABEL} />
          </div>
        ) : summary.kind === 'error' ? (
          <div className="od-error" role="alert">
            <h2 className="od-error-title">{DASHBOARD_ERROR_HEADING}</h2>
            <p>{DASHBOARD_ERROR_BODY}</p>
            <button type="button" className="boe-btn boe-btn-primary" onClick={reload}>
              {DASHBOARD_RETRY_LABEL}
            </button>
          </div>
        ) : (
          <>
            {/* Waiting for manufacturing alignment: prominent, straight after Factory Focus. */}
            <AlignmentSection summary={summary.summary} />
            <p className="od-note">{listsNote(summary.summary.viewer.seesAllOrders)}</p>
            <div className="od-pair">
              <AdvanceSection summary={summary.summary} />
              <FabricFinishSection summary={summary.summary} />
            </div>
          </>
        )}

        {/* ── Needs your action: Design Files and Client PO submissions
            (20270112000000), filtered to this reader's role. Draws nothing when
            nothing waits. ── */}
        <DocumentActionQueue
          supabase={supabase}
          viewerId={profile?.id ?? null}
          // The admin decision on documents and revised PIs is orders.approve_order
          // (Control Center), not users.role — the RPCs ask the same (20270120000000).
          isAdmin={ordersCaps.canApproveOrderSubmission}
          viewingAs={!!viewAsUserId}
          formatWhen={iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        />

        {/* ── Other queues ── small links to the pages that resolve them. */}
        {queues.length > 0 ? (
          <nav className="od-queues" aria-label="Other queues">
            {queues.map(q => (
              <Link key={q.key} href={q.href} className="od-queue-link" data-tone={q.tone}>
                <span className="od-queue-label">{q.label}</span>
                <span className="od-queue-count">{q.value === null ? '—' : q.value}</span>
                <span className="od-queue-sub">{q.sub}</span>
              </Link>
            ))}
          </nav>
        ) : null}

        {/* ── REVENUE ── quieter, below the urgent work. Only when the read
            returned it: the database sends it to a reader who sees every Order. */}
        {ready ? <RevenueSection revenue={ready.revenue} /> : null}
      </div>
    </OrdersLayout>
  )
}
