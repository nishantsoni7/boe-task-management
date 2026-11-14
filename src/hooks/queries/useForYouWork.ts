'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { useUnclosedFunds } from '@/hooks/queries/useCashJourneys'
import type { ForYouAccess, ForYouItemKey } from '@/lib/modules/forYouCatalogue'
import { itemApplies } from '@/lib/modules/forYouCatalogue'
import { readFlaggedPis, type FlaggedPi } from '@/lib/orders/flaggedPis'
import { isDashboardFunctionMissing } from '@/lib/orders/salespersonDashboard'
import {
  FOR_YOU_PAYMENT_SCAN_LIMIT,
  FOR_YOU_READ_LIMIT,
  changeRequestCard,
  flaggedCard,
  isOpenForOperations,
  operationsCard,
  paymentRequestCard,
  piApprovalCard,
  sentBackCard,
  verifyCardApplies,
  type ChangeRequestRow,
  type OperationsRow,
  type PaymentRequestRow,
  type PiApprovalRow,
  type SentBackRow,
  type WorkCard,
  type WorkItemKey,
} from '@/lib/modules/forYouWork'

// The records waiting on the viewer, for the For you column. One short read per
// item, each under the reader's own RLS, each running only while that item is on
// for this person: an item that is off costs no request. Not while previewing
// somebody else, like every other card in the column.

type WorkRead<T> = { rows: T[]; total: number }

type Answer = { data: unknown; count: number | null; error: { message?: string } | null }

async function read<T>(query: PromiseLike<Answer>): Promise<WorkRead<T>> {
  const { data, count, error } = await query
  if (error) throw new Error(error.message || 'Could not load this list.')
  const rows = (data ?? []) as T[]
  return { rows, total: count ?? rows.length }
}

function useWorkRead<T>(item: WorkItemKey, userId: string | null | undefined, enabled: boolean, ask: () => PromiseLike<Answer>) {
  return useQuery<WorkRead<T>>({
    queryKey: ['for-you', 'work', item, userId ?? null],
    enabled,
    queryFn: () => read<T>(ask()),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

const NAMES = 'submitted_by_user:users!submitted_by(full_name)'

export type WorkGroup = {
  item: WorkItemKey
  /** Every card read, for Clear all to filter. */
  cards: WorkCard[]
  /** Records beyond the ones read. */
  unread: number
  moreHref: string
  moreLabel: (n: number) => string
  failed: boolean
  failedLabel: string
}

export function useForYouWork(on: (key: ForYouItemKey) => boolean, access: ForYouAccess): WorkGroup[] {
  const { data: userId } = useSignedInUserId()
  const { viewMode } = useDisplaySubject()
  const wanted = (key: WorkItemKey) => !!userId && !viewMode && on(key) && itemApplies(key, access)

  // Newest first: a new request must show, whatever is still waiting. Read wider
  // than the cards shown: each is then kept only if the viewer can act on it
  // (verifyCardApplies), which needs the cash still on its way (the same read
  // as the panel's cash cards, shared by its key).
  // shortcut: pending payments beyond the scan limit are counted, never judged; raise the limit if that many ever wait.
  const unclosed = useUnclosedFunds()
  const payments = useWorkRead<PaymentRequestRow>('payment_request', userId, wanted('payment_request'), () => {
    const pending = createClient()
      .from('finance_payment_requests')
      .select(`id, client_name, amount, payment_mode, created_at, updated_at, submitted_by, ${NAMES}`, { count: 'exact' })
      .eq('status', 'pending_approval')
    return (access.decidesOwnPayments ? pending : pending.neq('submitted_by', userId!))
      .order('created_at', { ascending: false })
      .limit(FOR_YOU_PAYMENT_SCAN_LIMIT) as unknown as PromiseLike<Answer>
  })
  // Only an everyone's-cash read lists every payment on its way: any other
  // answer cannot say a cash-route payment has arrived.
  const inTransit = unclosed.data?.scope === 'all' ? new Set(unclosed.data.payments.map(p => p.paymentId)) : null
  const verifiable = (payments.data?.rows ?? []).filter(row => verifyCardApplies(row, {
    userId: userId ?? '',
    decidesOwnPayments: access.decidesOwnPayments,
    viewerIsCustodian: unclosed.data?.viewerIsCustodian ?? false,
    inTransit,
  }))

  const sentBack = useWorkRead<SentBackRow>('payment_sent_back', userId, wanted('payment_sent_back'), () => createClient()
    .from('finance_payment_requests')
    .select('id, human_payment_id, request_number, client_name, amount, clarification_requested_at, updated_at', { count: 'exact' })
    .eq('status', 'needs_clarification')
    .eq('submitted_by', userId!)
    .order('updated_at', { ascending: false })
    .limit(FOR_YOU_READ_LIMIT) as unknown as PromiseLike<Answer>)

  // Longest waiting first, like the approver's dashboard.
  const piApprovals = useWorkRead<PiApprovalRow>('pi_waiting_approval', userId, wanted('pi_waiting_approval'), () => createClient()
    .from('order_submissions')
    .select(`id, client_name, bill_to_name, draft_reference, submitted_at, created_at, ${NAMES}`, { count: 'exact' })
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: true })
    .limit(FOR_YOU_READ_LIMIT) as unknown as PromiseLike<Answer>)

  const changes = useWorkRead<ChangeRequestRow>('order_change_request', userId, wanted('order_change_request'), () => createClient()
    .from('order_change_requests')
    .select(`
      id, order_id, order_number_snapshot, request_type, created_at,
      order:orders!order_id(client_name),
      requested_by_user:users!requested_by(full_name)
    `, { count: 'exact' })
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(FOR_YOU_READ_LIMIT) as unknown as PromiseLike<Answer>)

  const operations = useWorkRead<OperationsRow>('pi_waiting_operations', userId, wanted('pi_waiting_operations'), () => createClient()
    .from('order_operations_handoffs')
    .select(`
      id, order_id, version_number, approved_at, created_at,
      order:orders!order_id(client_name, display_number, status)
    `, { count: 'exact' })
    .eq('status', 'awaiting')
    .eq('assigned_to', userId!)
    .is('superseded_at', null)
    .order('approved_at', { ascending: true })
    .limit(FOR_YOU_READ_LIMIT) as unknown as PromiseLike<Answer>)

  // The ONE definition of who must answer a flagged PI is the database's (my_flagged_pis, 20270611000000); a
  // database without it answers nothing. Oldest first: the longest-held Order leads.
  const flagged = useWorkRead<FlaggedPi>('pi_flagged_by_operations', userId, wanted('pi_flagged_by_operations'), () => createClient()
    .rpc('my_flagged_pis')
    .then(({ data, error }: { data: unknown; error: { code?: string; message?: string } | null }) => (isDashboardFunctionMissing(error)
      ? { data: [], count: 0, error: null }
      : { data: error ? null : readFlaggedPis(data), count: null, error })) as unknown as PromiseLike<Answer>)

  const unread = (read: WorkRead<unknown> | undefined) => Math.max(0, (read?.total ?? 0) - (read?.rows.length ?? 0))

  const groups: WorkGroup[] = [
    {
      item: 'payment_request',
      cards: verifiable.map(paymentRequestCard),
      unread: unread(payments.data),
      moreHref: '/finance?tab=pending',
      moreLabel: n => `${n} more payment ${n === 1 ? 'request' : 'requests'} →`,
      // A failed cash read hides every cash-route payment, so it says so too.
      failed: payments.isError || unclosed.isError,
      failedLabel: 'Payment requests',
    },
    {
      item: 'payment_sent_back',
      cards: (sentBack.data?.rows ?? []).map(sentBackCard),
      unread: unread(sentBack.data),
      moreHref: '/finance?tab=clarification',
      moreLabel: n => `${n} more sent back →`,
      failed: sentBack.isError,
      failedLabel: 'Payments sent back to you',
    },
    {
      item: 'pi_waiting_approval',
      cards: (piApprovals.data?.rows ?? []).map(piApprovalCard),
      unread: unread(piApprovals.data),
      moreHref: '/orders',
      moreLabel: n => `${n} more ${n === 1 ? 'PI' : 'PIs'} waiting →`,
      failed: piApprovals.isError,
      failedLabel: 'PIs waiting for approval',
    },
    {
      item: 'pi_flagged_by_operations',
      // Only what waits on this reader; an approver's watch rows (Sales holds them) are on the Orders dashboard.
      cards: (flagged.data?.rows ?? []).filter(r => r.mine).map(flaggedCard),
      unread: 0,
      moreHref: '/orders',
      moreLabel: n => `${n} more flagged →`,
      failed: flagged.isError,
      failedLabel: 'PIs flagged by Operations',
    },
    {
      item: 'order_change_request',
      cards: (changes.data?.rows ?? []).map(changeRequestCard),
      unread: unread(changes.data),
      moreHref: '/admin/control-center/action-queue',
      moreLabel: n => `${n} more ${n === 1 ? 'request' : 'requests'} →`,
      failed: changes.isError,
      failedLabel: 'Order change requests',
    },
    {
      item: 'pi_waiting_operations',
      cards: (operations.data?.rows ?? []).filter(isOpenForOperations).map(operationsCard),
      unread: unread(operations.data),
      moreHref: '/orders',
      moreLabel: n => `${n} more waiting →`,
      failed: operations.isError,
      failedLabel: 'PIs waiting for Operations',
    },
  ]

  // A list left over from when the item was on is not shown.
  return groups.filter(group => wanted(group.item))
}
