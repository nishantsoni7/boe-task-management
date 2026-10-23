'use client'

import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { notificationKeys } from '@/lib/notificationCache'
import {
  OPEN_HANDOVER_STATUSES,
  handoverErrorMessage,
  isHandoverFeatureMissing,
  readHandoverCandidates,
  readHandoverRecipients,
  readHandovers,
  readCashBalance,
  readCashBalances,
  type CashBalance,
  type CashBalanceRow,
  type CashOutKind,
  type Handover,
} from '@/lib/finance/handover'

// ── Cash handovers ───────────────────────────────────────────────────────────
//
// ONE READ DOOR: finance_handover_list (20270410000100). It returns the caller's
// own handovers (as giver or recipient) with the payment details the payment
// table's RLS would hide from a recipient, and — for an administrator or a
// finance.view_all holder — everybody's when p_only_mine is false.
//
// THE BANNER IS DRIVEN BY THIS QUERY, NOT BY NOTIFICATION COUNTS. A notification
// can be read and forgotten; an open handover is a fact that stays on screen
// until somebody resolves it. There is no realtime in this app, so the query
// re-asks every minute in the background. It does NOT refetch on tab focus:
// Finance deliberately never re-reads on focus (financeRefreshPolicy.test.ts),
// and a one-minute interval already keeps the banner current.

export const HANDOVERS_KEY = ['finance', 'handovers'] as const
export const OPEN_HANDOVERS_KEY = [...HANDOVERS_KEY, 'open'] as const

const REFETCH_MS = 60_000

export function useOpenHandovers() {
  const { data: userId } = useSignedInUserId()
  // While an administrator previews an employee, the RPC would still answer for
  // the administrator (writes and reads here are the actor's), so the banner
  // stays out of a preview rather than showing the wrong person's cash.
  const { viewMode } = useDisplaySubject()

  const query = useQuery<Handover[]>({
    queryKey: [...OPEN_HANDOVERS_KEY, userId ?? null],
    enabled: !!userId && !viewMode,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('finance_handover_list', {
        p_statuses: [...OPEN_HANDOVER_STATUSES],
        p_only_mine: false,
        p_limit: 100,
        p_offset: 0,
        p_id: null,
      })
      if (isHandoverFeatureMissing(error)) return []
      if (error) throw new Error(handoverErrorMessage(error))
      return readHandovers(data)
    },
    staleTime: 20_000,
    refetchInterval: REFETCH_MS,
  })

  const all = useMemo(() => query.data ?? [], [query.data])
  const mine = useMemo(
    () => all.filter(h => h.giverId === userId || h.recipientId === userId),
    [all, userId],
  )
  const others = useMemo(
    () => all.filter(h => h.giverId !== userId && h.recipientId !== userId),
    [all, userId],
  )

  return {
    viewerId: userId ?? null,
    /** Open handovers the viewer is part of: these get the loud banner. */
    mine,
    /** Open handovers between other people, visible to administrators / view_all. */
    others,
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    isError: query.isError,
    refetch: query.refetch,
  }
}

/** One handover (for /handover/[id]), any status. */
export function useHandover(id: string) {
  const { data: userId } = useSignedInUserId()
  return useQuery<Handover | null>({
    queryKey: [...HANDOVERS_KEY, 'one', id, userId ?? null],
    enabled: !!userId && !!id,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('finance_handover_list', {
        p_statuses: null, p_only_mine: false, p_limit: 1, p_offset: 0, p_id: id,
      })
      if (error) throw new Error(handoverErrorMessage(error))
      return readHandovers(data)[0] ?? null
    },
    staleTime: 10_000,
  })
}

/** The history page: every status, paged. */
export function useHandoverHistory(statuses: string[] | null, onlyMine: boolean, page: number, pageSize = 25) {
  const { data: userId } = useSignedInUserId()
  return useQuery<Handover[]>({
    queryKey: [...HANDOVERS_KEY, 'history', statuses, onlyMine, page, userId ?? null],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('finance_handover_list', {
        p_statuses: statuses, p_only_mine: onlyMine,
        p_limit: pageSize + 1, p_offset: page * pageSize, p_id: null,
      })
      if (error) throw new Error(handoverErrorMessage(error))
      return readHandovers(data)
    },
    staleTime: 15_000,
  })
}

/** The payments the viewer holds and may hand over, and the people they may hand them to. */
export function useHandoverFormData(enabled: boolean) {
  const { data: userId } = useSignedInUserId()
  return useQuery({
    queryKey: [...HANDOVERS_KEY, 'form', userId ?? null],
    enabled: enabled && !!userId,
    queryFn: async () => {
      const supabase = createClient()
      const [payments, people] = await Promise.all([
        supabase.rpc('finance_my_handoverable_payments'),
        supabase.rpc('finance_handover_recipients'),
      ])
      if (payments.error) throw new Error(handoverErrorMessage(payments.error))
      if (people.error) throw new Error(handoverErrorMessage(people.error))
      return {
        candidates: readHandoverCandidates(payments.data),
        recipients: readHandoverRecipients(people.data),
      }
    },
    staleTime: 0,
    gcTime: 0,
  })
}

// ── Cash in hand (20270412000000) ────────────────────────────────────────────
// Under HANDOVERS_KEY on purpose: every handover write invalidates that prefix,
// and an accept or a cancel changes balances, so they refresh together.
export const CASH_BALANCE_KEY = [...HANDOVERS_KEY, 'cash-balance'] as const

/** The viewer's own cash in hand: balance, reserved in open handovers, available, recent entries. */
export function useMyCashBalance(enabled = true) {
  const { data: userId } = useSignedInUserId()
  return useQuery<CashBalance | null>({
    queryKey: [...CASH_BALANCE_KEY, 'mine', userId ?? null],
    enabled: enabled && !!userId,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('finance_my_cash_balance')
      if (isHandoverFeatureMissing(error)) return null
      if (error) throw new Error(handoverErrorMessage(error))
      return readCashBalance(data)
    },
    staleTime: 15_000,
  })
}

/** Everyone's cash in hand, for administrators and finance.view_all holders. */
export function useCashBalances(enabled = true) {
  const { data: userId } = useSignedInUserId()
  return useQuery<{ allowed: boolean; canAdjust: boolean; rows: CashBalanceRow[] }>({
    queryKey: [...CASH_BALANCE_KEY, 'all', userId ?? null],
    enabled: enabled && !!userId,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('finance_cash_balances')
      if (isHandoverFeatureMissing(error)) return { allowed: false, canAdjust: false, rows: [] }
      if (error) throw new Error(handoverErrorMessage(error))
      return readCashBalances(data)
    },
    staleTime: 15_000,
  })
}

export type CreateHandoverInput = {
  recipientId: string
  paymentIds: string[]
  handedAtIso: string | null
  note: string
  /** Typed cash from the giver's cash in hand, in rupees (0 when none). */
  cashFromHand: number
  /** Typed cash not recorded before, in rupees (0 when none), and where it came from. */
  cashNew: number
  cashNewSource: string
  /** Minted once per open form, so a double click or a retry writes one handover. */
  idempotencyKey: string
}

/**
 * The writes. Each one throws an Error whose message is the server's own
 * sentence, and each refreshes every handover and cash-in-hand query plus the
 * Finance notification count when it succeeds.
 */
export function useHandoverActions() {
  const queryClient = useQueryClient()

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: HANDOVERS_KEY }),
      queryClient.invalidateQueries({ queryKey: notificationKeys.count('finance') }),
    ])
  }, [queryClient])

  const run = useCallback(async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await createClient().rpc(fn, args)
    if (error) throw new Error(handoverErrorMessage(error))
    await refresh()
    return data
  }, [refresh])

  const create = useMutation({
    mutationFn: (input: CreateHandoverInput) => run('create_cash_handover', {
      p_recipient: input.recipientId,
      p_payment_ids: input.paymentIds,
      p_handed_at: input.handedAtIso,
      p_note: input.note.trim() || null,
      p_idempotency_key: input.idempotencyKey,
      p_cash_from_hand: input.cashFromHand,
      p_cash_new: input.cashNew,
      p_cash_new_source: input.cashNew > 0 ? input.cashNewSource.trim() : null,
    }),
  })
  const accept = useMutation({
    mutationFn: (id: string) => run('accept_cash_handover', { p_handover_id: id }),
  })
  const dispute = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      run('dispute_cash_handover', { p_handover_id: v.id, p_reason: v.reason.trim() }),
  })
  const cancel = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      run('cancel_cash_handover', { p_handover_id: v.id, p_reason: v.reason.trim() || null }),
  })
  const remind = useMutation({
    mutationFn: (id: string) => run('remind_cash_handover', { p_handover_id: id }),
  })

  const recordCashOut = useMutation({
    mutationFn: (v: { amount: number; kind: CashOutKind; note: string; idempotencyKey: string }) =>
      run('record_cash_out', {
        p_amount: v.amount, p_kind: v.kind, p_note: v.note.trim(), p_idempotency_key: v.idempotencyKey,
      }),
  })
  const adjustBalance = useMutation({
    mutationFn: (v: { userId: string; delta: number; reason: string; idempotencyKey: string }) =>
      run('adjust_cash_balance', {
        p_user: v.userId, p_delta: v.delta, p_reason: v.reason.trim(), p_idempotency_key: v.idempotencyKey,
      }),
  })

  return { create, accept, dispute, cancel, remind, recordCashOut, adjustBalance, refresh }
}
