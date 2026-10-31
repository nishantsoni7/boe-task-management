import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { hasPermission } from '@/lib/permissions/resolver'
import { toTaskPeople } from '@/lib/tasks/taskPeople'

// GET /api/tasks/people — id, name and active flag for every employee.
//
// A task outlives its people. The `users` row policy hides a deactivated person
// from the browser, so the task screens had no name to show for them; see
// src/lib/tasks/taskPeople.ts for why the policy itself stays as it is.
//
// Authorization is Task Management module ENTRY, the same rule as the module
// guard: an admin, or effective `task_management.view`. The service role reads
// the table, so this route is the only thing deciding who gets the list, and the
// select below is the only thing deciding what is in it.

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET() {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return fail(401, 'Please sign in.')

  const admin = adminClient()
  if (!admin.ok) {
    console.error('[tasks/people] not configured; missing:', admin.missing.join(', '))
    return fail(503, 'Names are not available on this deployment.')
  }
  const service = admin.client

  const { data: me } = await service
    .from('users').select('id, role, is_active, is_deleted').eq('id', user.id).maybeSingle()
  if (!me || me.is_active !== true || me.is_deleted === true) {
    return fail(403, 'You do not have access to Task Management.')
  }
  const allowed = me.role === 'admin'
    || await hasPermission(service, user.id, 'task_management', 'view').catch(() => false)
  if (!allowed) return fail(403, 'You do not have access to Task Management.')

  const { data, error } = await service.from('users').select('id, full_name, is_active')
  if (error) {
    console.error('[tasks/people] read failed:', error.message)
    return fail(502, 'Names could not be loaded.')
  }

  return NextResponse.json({ people: toTaskPeople(data ?? []) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
