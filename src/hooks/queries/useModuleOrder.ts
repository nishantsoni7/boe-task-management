'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { isValidUUID } from '@/lib/ui'
import {
  NO_MODULE_PREFERENCE,
  normalizeStoredBigModules,
  normalizeStoredModuleOrder,
  PERSONAL_MODULE_ORDER_TABLE,
  toModulePreference,
  type ModulePreference,
} from '@/lib/modules/moduleOrder'

/**
 * THE PERSONAL LAUNCHER ORDER, read and written for ONE account.
 *
 * Keyed by the SIGNED-IN user, and by nothing else. A preference belongs to an
 * account rather than to a browser, so it follows somebody to their phone; and
 * because the key carries the user id, signing in as somebody else cannot show
 * the previous person's arrangement out of cache — the same rule the notification
 * counts on this page already follow.
 *
 * RLS DOES THE ENFORCING, NOT THIS FILE. public.user_module_order carries
 * `auth.uid() = user_id` on select, insert and update
 * (supabase/migrations/20261228000000_personal_module_order.sql), so a caller
 * who asked for somebody else's row would be answered with no rows and a caller
 * who tried to write one would be refused. The `.eq('user_id', …)` below is how
 * the query names what it wants, not what stops it getting more.
 *
 * AND A STORED KEY IS NOT ACCESS. What comes back is a list of strings that the
 * launcher uses to SORT the cards the permission engine already decided on. See
 * src/lib/modules/moduleOrder.ts.
 */

/** The cache entry, so the page and the save can agree on one key. */
export const moduleOrderKey = (userId: string | null | undefined) =>
  ['module-order', userId ?? null] as const

/**
 * This person's launcher preference: the saved card order and the big blocks they
 * chose. Each is null when they never set it — the ordinary answer, meaning
 * "canonical order" and "the default big blocks".
 *
 * A FAILED READ IS NO PREFERENCE. The launcher is the screen somebody lands on
 * after signing in, and it must render. Losing a preference to a failed request
 * costs the defaults for one visit; failing the screen because a preference could
 * not be read would cost the whole launcher.
 *
 * ONE ROW, ONE READ: both lists live on the same row. If the read with the
 * big-block column fails (the column is added by 20270821000000, and a deploy
 * must not make the personal ORDER unreadable if it ever ran before that), the
 * order alone is read again, so the worst case is the default big blocks.
 *
 * The cache holds a ModulePreference. `select` accepts the bare list of keys that
 * an earlier visit may have saved on the device (see toModulePreference).
 */
export function useModuleOrder(userId: string | null | undefined) {
  return useQuery<ModulePreference, Error, ModulePreference>({
    queryKey: moduleOrderKey(userId),
    enabled: isValidUUID(userId),
    select: toModulePreference,
    queryFn: async () => {
      if (!isValidUUID(userId)) return NO_MODULE_PREFERENCE
      const supabase = createClient()
      const row = (columns: string) => supabase
        .from(PERSONAL_MODULE_ORDER_TABLE)
        .select(columns)
        .eq('user_id', userId)
        .maybeSingle()

      let { data, error } = await row('module_keys, big_module_keys')
      if (error) ({ data, error } = await row('module_keys'))
      if (error) return NO_MODULE_PREFERENCE
      // Validated rather than trusted. A row is data from outside the program
      // even when this program is the only thing that writes it, and the
      // normalisers drop anything malformed instead of handing the grid a list
      // it cannot use.
      const stored = data as { module_keys?: unknown; big_module_keys?: unknown } | null
      return {
        order: normalizeStoredModuleOrder(stored?.module_keys),
        big: normalizeStoredBigModules(stored?.big_module_keys),
      }
    },
    // A preference changes only when its owner changes it, in this tab, and the
    // save writes the new value straight into this entry — so there is nothing
    // to poll for and no reason to refetch on every mount.
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  })
}

/** What a save came back with. `ok: false` carries something worth showing. */
export type SaveModuleOrderResult = { ok: true } | { ok: false; message: string }

/**
 * Replace this person's stored order with `keys`.
 *
 * ONE UPSERT, so a save either happens or does not. The alternative — a row per
 * card, deleted and reinserted — is what the dashboard's Top 3 reorder has to
 * do, and it needs hand-written compensation for a half-applied write
 * (src/app/dashboard/page.tsx). A module key references nothing, so there is
 * nothing to gain from that shape and a partial state to lose.
 *
 * `user_id` is sent because the row is keyed by it. It is not a claim of
 * authority: the insert policy's `with check (auth.uid() = user_id)` refuses any
 * value but the caller's own, so a browser that sent somebody else's id would be
 * rejected by the database rather than trusted here.
 *
 * `big` is the big-block choice, sent ONLY when the person changed it. An upsert
 * writes just the columns it names, so a save that leaves the big blocks alone
 * keeps whatever is stored (including "never chosen", which must stay null so the
 * default can still follow a module they gain later).
 */
export async function saveModuleOrder(
  userId: string,
  keys: readonly string[],
  big?: readonly string[],
): Promise<SaveModuleOrderResult> {
  try {
    const supabase = createClient()
    const { error } = await supabase
      .from(PERSONAL_MODULE_ORDER_TABLE)
      .upsert(
        {
          user_id: userId,
          module_keys: [...keys],
          ...(big === undefined ? {} : { big_module_keys: [...big] }),
        },
        { onConflict: 'user_id' },
      )

    if (error) return { ok: false, message: error.message }
    return { ok: true }
  } catch (err) {
    // A thrown network error reads the same to the person as a refused write:
    // nothing was saved. What must not happen is an unhandled rejection that
    // leaves the controls disabled with no explanation.
    return { ok: false, message: err instanceof Error ? err.message : 'Network error' }
  }
}

/**
 * Put a just-saved order (and big blocks, when they were saved) into the cache, so
 * the grid outside edit mode renders what was stored without waiting for a
 * re-read. Only ever called after the upsert reported success, so the cache
 * cannot claim a preference the database does not hold. A save that did not send
 * the big blocks leaves the cached ones as they were.
 */
export function useModuleOrderCache() {
  const queryClient = useQueryClient()
  return (userId: string | null | undefined, keys: readonly string[], big?: readonly string[]) => {
    queryClient.setQueryData<ModulePreference>(moduleOrderKey(userId), previous => ({
      order: [...keys],
      big: big === undefined ? toModulePreference(previous).big : [...big],
    }))
  }
}
