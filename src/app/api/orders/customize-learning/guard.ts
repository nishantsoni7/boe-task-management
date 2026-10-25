// The one door for every Customize image Learning route: a signed-in person
// whom the database (can_train_customize_image(), 20270420000000) lets train.
// Answers with the service-role client the route then uses — the tables have
// RLS on and no policies, so this check IS the authorization.

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { isLearningMissing, mayTrain } from '@/lib/orders/customizationLearningServer'

export const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: code, message }, { status })

export const NOT_SET_UP = () =>
  fail(503, 'LEARNING_NOT_SET_UP', 'Customize image learning is not set up on this database yet. Ask the owner to apply migration 20270420000000.')

/** A database error from a Learning read or write, as a response. */
export function dbFailure(error: { code?: string; message?: string }, what: string) {
  if (isLearningMissing(error)) return NOT_SET_UP()
  console.error('[customize-learning]', what, { code: error.code })
  return fail(500, 'DB_ERROR', `The ${what} could not be saved or read. Please try again.`)
}

export async function requireTrainer(): Promise<
  { ok: true; userId: string; service: SupabaseClient } | { ok: false; response: NextResponse }
> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, response: fail(401, 'UNAUTHORIZED', 'Please sign in again.') }
  const may = await mayTrain(authClient)
  if (may === 'missing') return { ok: false, response: NOT_SET_UP() }
  if (may === 'no') return { ok: false, response: fail(403, 'FORBIDDEN', 'Only an administrator, or someone given “Train Customize image”, can open this page.') }
  const admin = adminClient()
  if (!admin.ok) return { ok: false, response: fail(500, 'SERVER_NOT_CONFIGURED', 'This is not configured on this deployment.') }
  return { ok: true, userId: user.id, service: admin.client }
}
