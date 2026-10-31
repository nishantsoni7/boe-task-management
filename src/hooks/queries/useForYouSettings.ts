'use client'

import { useQuery } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import { useSignedInUserId } from '@/hooks/queries/usePermissionContext'
import { useDisplaySubject } from '@/hooks/queries/useDisplaySubject'
import { useUnclosedFunds } from '@/hooks/queries/useCashJourneys'
import { deriveFinanceCapabilities } from '@/lib/permissions/finance'
import { deriveOrdersCapabilities } from '@/lib/permissions/orders'
import {
  isItemOn,
  readForYouModes,
  readHiddenItems,
  type ForYouAccess,
  type ForYouItemKey,
  type ForYouMode,
  type ForYouModes,
} from '@/lib/modules/forYouCatalogue'

// What the For you column may show (20270513000000): the company's setting for
// each item, and the items this person turned off. Read under RLS, and neither
// grants anything. See src/lib/modules/forYouCatalogue.ts.
//
// A FAILED READ IS THE DEFAULTS, not an error on the launcher, which is the
// screen somebody lands on after signing in. So a database without these tables
// shows the column exactly as it was. The two screens that edit these settings
// check `failed` and refuse to save over something they could not read.

export const FOR_YOU_MODES_KEY = ['for-you', 'modes'] as const

export const forYouChoicesKey = (userId: string | null | undefined) =>
  ['for-you', 'choices', userId ?? null] as const

export type ModesRead = { modes: ForYouModes; failed: boolean }
export type ChoicesRead = { hidden: ForYouItemKey[]; failed: boolean }

/** The company's settings. Re-asked every minute, so a change reaches everyone. */
export function useForYouModes(enabled = true) {
  return useQuery<ModesRead>({
    queryKey: FOR_YOU_MODES_KEY,
    enabled,
    queryFn: async () => {
      const { data, error } = await createClient().from('for_you_item_settings').select('item_key, mode')
      return error ? { modes: {}, failed: true } : { modes: readForYouModes(data), failed: false }
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

/** What this person turned off. Only its owner changes it, so it is not polled. */
export function useForYouChoices(userId: string | null | undefined) {
  return useQuery<ChoicesRead>({
    queryKey: forYouChoicesKey(userId),
    enabled: isValidUUID(userId),
    queryFn: async () => {
      const { data, error } = await createClient()
        .from('user_for_you_preferences')
        .select('hidden_items')
        .eq('user_id', userId!)
        .maybeSingle()
      if (error) return { hidden: [], failed: true }
      return { hidden: readHiddenItems((data as { hidden_items?: unknown } | null)?.hidden_items), failed: false }
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  })
}

/** Which items can reach the person on screen. Grants nothing: the reads still decide. */
export function useForYouAccess(): { ready: boolean; viewMode: boolean; access: ForYouAccess } {
  const { ready, actorRole, subjectRole, subjectPermissionsByModule, viewMode } = useDisplaySubject()
  const funds = useUnclosedFunds()
  const finance = deriveFinanceCapabilities(subjectRole, subjectPermissionsByModule.get('finance') ?? [])
  const orders = deriveOrdersCapabilities(subjectRole, subjectPermissionsByModule.get('orders') ?? [])
  return {
    ready,
    viewMode,
    access: {
      admin: !viewMode && actorRole === 'admin',
      finance: finance.canAccessFinanceModule,
      orders: orders.canAccessOrdersModule,
      // `approve` decides a payment, and only view_all reads other people's.
      verifiesPayments: finance.canApprovePayment && finance.canViewAllFinance,
      decidesOwnPayments: finance.canDecideOwnPayment,
      approvesPis: orders.canApproveOrderSubmission,
      seesAllCash: funds.data?.scope === 'all',
    },
  }
}

/**
 * Whether the column shows an item, for the person signed in. Nothing shows until
 * both settings are known, so a person who turned something off never sees it
 * flash up, and no read runs for an item that is off.
 */
export function useForYouVisibility() {
  const { data: userId } = useSignedInUserId()
  const { ready: accessReady, viewMode, access } = useForYouAccess()
  const modesRead = useForYouModes(!!userId)
  const choicesRead = useForYouChoices(viewMode ? null : userId)
  const ready = accessReady && !!modesRead.data && (viewMode || !!choicesRead.data)
  const modes = modesRead.data?.modes ?? {}
  const hidden = choicesRead.data?.hidden ?? []
  return {
    access,
    on: (key: ForYouItemKey) => ready && isItemOn(key, modes, hidden),
  }
}

export type ForYouSave = { ok: true } | { ok: false; message: string }

/** Control Center: the one write to the company's settings, refused to non-admins by the database. */
export async function saveForYouMode(key: ForYouItemKey, mode: ForYouMode): Promise<ForYouSave> {
  const { error } = await createClient().rpc('set_for_you_item_mode', { p_item_key: key, p_mode: mode })
  return error ? { ok: false, message: error.message || 'Could not save that change.' } : { ok: true }
}

/** Replace this person's list of items turned off. RLS keeps it to their own row. */
export async function saveForYouChoices(userId: string, hidden: readonly ForYouItemKey[]): Promise<ForYouSave> {
  const { error } = await createClient()
    .from('user_for_you_preferences')
    .upsert(
      { user_id: userId, hidden_items: [...hidden], updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
  return error ? { ok: false, message: error.message || 'Could not save that change.' } : { ok: true }
}
