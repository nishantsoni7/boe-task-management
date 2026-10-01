// Server-side read of every retained Minop delivery, for the incoming-data
// register. Read-only: it selects and nothing else.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MinopDeliveryRow } from './incomingRegister'

const BATCH = 500
/** Hard ceiling on messages read per request; hitting it is reported, never silent. */
export const MINOP_INCOMING_MAX_DELIVERIES = 20_000

const COLUMNS =
  'id, received_at, service_tag_id, content_type, user_agent, auth_method, processing_status, error_text, body_sha256, payload, raw_body'

export async function readAllMinopDeliveries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: SupabaseClient<any, any, any>,
): Promise<{ deliveries: MinopDeliveryRow[]; truncated: boolean }> {
  const deliveries: MinopDeliveryRow[] = []
  for (let from = 0; from < MINOP_INCOMING_MAX_DELIVERIES; from += BATCH) {
    const { data, error } = await svc
      .from('minop_webhook_deliveries')
      .select(COLUMNS)
      .order('received_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + BATCH - 1)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as MinopDeliveryRow[]
    deliveries.push(...batch)
    if (batch.length < BATCH) return { deliveries, truncated: false }
  }
  return { deliveries, truncated: true }
}
