import { createClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'

// Shared request-side rules for the PI import, kept out of the route files.
//
// A Next.js route module may only export its handlers and a small set of
// framework config values; anything else it exports is a build-time surprise.
// Both PI routes need the same limit and the same authorization, so both live
// here instead.

/**
 * 10 MB for a PI, against 5 MB for the meeting-review template.
 *
 * The larger allowance is granted ONLY on the PI path. A PI embeds its product
 * photographs — one verified sample is 6.3 MB — whereas the review template is
 * a plain grid that has no reason to grow. Raising the shared limit would have
 * relaxed a constraint on an endpoint that does not need it.
 */
export const PI_MAX_BYTES = 10 * 1024 * 1024

/** `.xlsx` only. A PI's photographs cannot survive .xls or .csv. */
export function isPiFileName(name: string): boolean {
  return /\.xlsx$/i.test(name.trim())
}

export type PiFileRejection = { error: string; status: 400 }

/** Shape checks shared by preview and confirm. Null when the file is acceptable. */
export function rejectPiFile(file: File | null): PiFileRejection | null {
  if (!file) return { error: 'No file was uploaded.', status: 400 }
  if (!isPiFileName(file.name)) {
    return {
      error: 'A BOE PI must be an .xlsx file. Older .xls and .csv files are not supported here.',
      status: 400,
    }
  }
  if (file.size > PI_MAX_BYTES) {
    return {
      error: `That PI is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`,
      status: 400,
    }
  }
  return null
}

/**
 * Signed in, active, and holding Meetings edit or manage (or admin).
 *
 * Returns the caller's token so the route can act AS THEM rather than as the
 * service role — every write then passes the same RLS the browser would.
 *
 * This is not the authorization boundary. `import_meeting_rows()` and
 * `set_meeting_item_image_path()` re-check editorship against the specific
 * meeting; this only avoids accepting a large upload from someone who could
 * never use it.
 */
export async function authorizePiImporter(req: NextRequest): Promise<string | null> {
  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return null

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: { user }, error } = await svc.auth.getUser(token)
  if (error || !user) return null

  const { data: profile } = await svc
    .from('users')
    .select('id, role, is_active')
    .eq('id', user.id)
    .single()

  if (!profile || !profile.is_active) return null
  if (profile.role === 'admin') return token

  for (const action of ['edit', 'manage']) {
    const { data: allowed } = await svc.rpc('resolve_permission', {
      p_user_id: user.id, p_module_key: 'meetings', p_action_key: action,
    })
    if (allowed === true) return token
  }
  return null
}
