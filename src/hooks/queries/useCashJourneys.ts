'use client'

import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { HANDOVERS_KEY } from '@/hooks/queries/useHandovers'
import { notificationKeys } from '@/lib/notificationCache'
import { handoverErrorMessage, isHandoverFeatureMissing } from '@/lib/finance/handover'
import { readOrderCashCheck, type OrderCashCheck } from '@/lib/orders/orderCashCheck'
import {
  TRACKED_PAYMENT_MODES,
  readCashPayments,
  readJourney,
  readUnclosedFunds,
  type CashPayment,
  type PaymentJourney,
  type UnclosedFunds,
} from '@/lib/finance/cashJourney'
import {
  TRACKED_RECORDS_LIMIT,
  readTrackedPaymentRecords,
  type TrackedPaymentRecord,
} from '@/lib/finance/cashJourneyBoard'

// ── Cash journeys (20270413000000) ───────────────────────────────────────────
//
// Under HANDOVERS_KEY on purpose: every handover write (create, accept,
// dispute, cancel) already invalidates that prefix, and each one changes where
// money is — so the unclosed list, the order-page chips and the journeys
// refresh together with the banner. Like the banner, these re-ask every minute
// and never on tab focus (financeRefreshPolicy.test.ts).

export const CASH_JOURNEYS_KEY = [...HANDOVERS_KEY, 'journeys'] as const

const EMPTY: UnclosedFunds = { scope: 'none', viewerIsCustodian: false, custodians: [], payments: [] }

/** Every tracked payment not yet with the company that the viewer may see. */
export function useUnclosedFunds(enabled = true) {
  const { data: userId } = useSignedInUserId()
  const { viewMode } = useDisplaySubject()
  return useQuery<UnclosedFunds>({
    queryKey: [...CASH_JOURNEYS_KEY, 'unclosed', userId ?? null],
    enabled: enabled && !!userId && !viewMode,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('finance_unclosed_funds')
      if (isHandoverFeatureMissing(error)) return EMPTY
      if (error) throw new Error(handoverErrorMessage(error))
      return readUnclosedFunds(data)
    },
    staleTime: 20_000,
    refetchInterval: 60_000,
  })
}

/**
 * The payment records behind the journeys (the Cash journeys board): who
 * recorded each tracked payment, whether Finance verified it, and the Order it
 * names. Read under the reader's own RLS, so an administrator sees every
 * tracked payment and everybody else sees their own. Newest first, bounded;
 * the board says so when the bound is reached.
 */
export function useTrackedPaymentRecords(enabled = true) {
  const { data: userId } = useSignedInUserId()
  const { viewMode } = useDisplaySubject()
  return useQuery<TrackedPaymentRecord[]>({
    queryKey: [...CASH_JOURNEYS_KEY, 'records', userId ?? null],
    enabled: enabled && !!userId && !viewMode,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('finance_payment_requests')
        .select('id, human_payment_id, client_name, amount, payment_mode, payment_date, status, created_at, order_number, submitted_by_user:users!submitted_by(full_name)')
        .is('deleted_at', null)
        .neq('status', 'rejected')
        .in('payment_mode', [...TRACKED_PAYMENT_MODES])
        .order('created_at', { ascending: false })
        .limit(TRACKED_RECORDS_LIMIT)
      if (error) throw new Error(error.message)
      return readTrackedPaymentRecords(data)
    },
    staleTime: 30_000,
  })
}

/** Cash state of specific payments (order and PI pages). Untracked or unreadable ones are absent. */
export function usePaymentCustodyStatus(paymentIds: readonly string[]) {
  const { data: userId } = useSignedInUserId()
  const ids = [...new Set(paymentIds)].sort()
  return useQuery<Map<string, CashPayment>>({
    queryKey: [...CASH_JOURNEYS_KEY, 'status', ids.join(','), userId ?? null],
    enabled: !!userId && ids.length > 0,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('finance_payment_custody_status', { p_payment_ids: ids })
      if (isHandoverFeatureMissing(error)) return new Map()
      if (error) throw new Error(handoverErrorMessage(error))
      return new Map(readCashPayments(data).map(p => [p.paymentId, p]))
    },
    staleTime: 20_000,
  })
}

/** One payment's whole journey. */
export function usePaymentJourney(paymentId: string | null) {
  const { data: userId } = useSignedInUserId()
  return useQuery<PaymentJourney | null>({
    queryKey: [...CASH_JOURNEYS_KEY, 'journey', paymentId, userId ?? null],
    enabled: !!userId && !!paymentId,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('finance_payment_journey', { p_payment_id: paymentId })
      if (isHandoverFeatureMissing(error)) return null
      if (error) throw new Error(handoverErrorMessage(error))
      return readJourney(data)
    },
    staleTime: 10_000,
  })
}

/** Custodian and admin writes. Each throws the server's own sentence. */
export function useCashJourneyActions() {
  const queryClient = useQueryClient()
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: HANDOVERS_KEY }),
      queryClient.invalidateQueries({ queryKey: notificationKeys.count('finance') }),
    ])
  }, [queryClient])

  const receive = useMutation({
    mutationFn: async (v: { paymentIds: string[]; note: string }) => {
      const { error } = await createClient().rpc('receive_cash_directly', {
        p_payment_ids: v.paymentIds, p_note: v.note.trim() || null,
      })
      if (error) throw new Error(handoverErrorMessage(error))
      await refresh()
    },
  })

  const setCustodians = useMutation({
    mutationFn: async (userIds: string[]) => {
      const { error } = await createClient().rpc('set_finance_cash_custodians', { p_user_ids: userIds })
      if (error) throw new Error(handoverErrorMessage(error))
      await refresh()
    },
  })

  return { receive, setCustodians }
}

/**
 * Verified cash on one PI that has not reached the company, and any exception
 * already recorded (20270414000000) — for the Approve dialog. Asked only while
 * the dialog that creates an Order is open.
 */
export function useOrderCashCheck(submissionId: string | null, enabled: boolean) {
  const { data: userId } = useSignedInUserId()
  return useQuery<OrderCashCheck | null>({
    queryKey: [...CASH_JOURNEYS_KEY, 'order-check', submissionId, userId ?? null],
    enabled: enabled && !!userId && !!submissionId,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('order_submission_cash_check', { p_submission_id: submissionId })
      if (isHandoverFeatureMissing(error)) return null
      if (error) throw new Error(handoverErrorMessage(error))
      return readOrderCashCheck(data)
    },
    staleTime: 0,
  })
}
