import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { handleMinopPathTokenWebhook, type MinopRawDeliveryRow } from '@/lib/minop/pathTokenWebhook'
import { recordMinopPunches } from '@/lib/minop/punches'

export const runtime = 'nodejs'

/**
 * POST /api/integrations/minop/webhook/<MINOP_WEBHOOK_PATH_TOKEN>
 *
 * Receiver for the Minop Developer Dashboard, which can send a URL but no
 * authentication header. See src/lib/minop/pathTokenWebhook.ts.
 * Never log req.url here: it contains the token.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleMinopPathTokenWebhook(req, token, {
    configuredToken: process.env.MINOP_WEBHOOK_PATH_TOKEN,
    insertDelivery: insertRawDelivery,
    recordPunches,
  })
}

function serviceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function insertRawDelivery(row: MinopRawDeliveryRow): Promise<{ ok: boolean; receivedAt?: string }> {
  const svc = serviceClient()
  if (!svc) {
    console.error('[minop/webhook/path-token] Supabase service configuration is missing')
    return { ok: false }
  }

  const { data, error } = await svc.from('minop_webhook_deliveries').insert(row).select('received_at').single()
  if (error) {
    console.error('[minop/webhook/path-token] delivery insert failed:', error.message)
    return { ok: false }
  }
  return { ok: true, receivedAt: data?.received_at }
}

async function recordPunches(receivedAt: string, payload: unknown): Promise<void> {
  const svc = serviceClient()
  if (svc) await recordMinopPunches(svc, receivedAt, payload)
}
