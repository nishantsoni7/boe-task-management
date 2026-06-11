/**
 * PATCH /api/activity-log/[id]  — edit note text
 * DELETE /api/activity-log/[id] — delete log entry + its attachments
 *
 * Uses service role to bypass RLS on task_activity_log.
 * Caller must be the original actor_id on the entry.
 */

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function resolveUser(req: NextRequest) {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return null
  const { data: { user }, error } = await sb().auth.getUser(token)
  if (error || !user) return null
  return user
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await resolveUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const { note } = await req.json()

  const client = sb()

  // Verify caller is the actor who created this log entry
  const { data: entry } = await client
    .from('task_activity_log')
    .select('actor_id')
    .eq('id', id)
    .single()

  if (!entry || entry.actor_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { error } = await client
    .from('task_activity_log')
    .update({ note: note ?? null })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await resolveUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const client = sb()

  // Verify caller is the actor who created this log entry
  const { data: entry } = await client
    .from('task_activity_log')
    .select('actor_id')
    .eq('id', id)
    .single()

  if (!entry || entry.actor_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Delete attachments first (FK constraint)
  const { error: attErr } = await client
    .from('task_attachments')
    .delete()
    .eq('activity_log_id', id)

  if (attErr) return NextResponse.json({ error: attErr.message }, { status: 500 })

  const { error } = await client
    .from('task_activity_log')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
