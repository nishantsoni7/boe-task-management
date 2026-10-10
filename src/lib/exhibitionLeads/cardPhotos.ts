import type { createClient } from '@/lib/supabase/client'
import { newSubmissionId } from './draft'

// The photograph of a card or visitor form, kept on the lead.
//
// The bytes never go into the outbox (localStorage is small and the photo is
// not worth risking the entries for). They wait here, in memory, under the
// entry's submission id, and go to the private bucket only AFTER the lead has
// been created — Save itself never waits for an upload. If the page is reloaded
// before that, the lead is still saved and only the photograph is lost; the
// lead's sheet lets it be added again.

type Supabase = ReturnType<typeof createClient>

export const CARD_BUCKET = 'exhibition-lead-cards'

const waiting = new Map<string, Blob>()

export const stashCard = (submissionId: string, photo: Blob) => { waiting.set(submissionId, photo) }
export const peekCard = (submissionId: string): Blob | undefined => waiting.get(submissionId)
export const forgetCard = (submissionId: string) => { waiting.delete(submissionId) }
/** Hand the photograph back (an entry put back into the form for editing). */
export function takeCard(submissionId: string): Blob | undefined {
  const photo = waiting.get(submissionId)
  waiting.delete(submissionId)
  return photo
}

/** '{uploader}/{uuid}.jpg' — the shape the bucket policy and the column CHECK both require. */
export const newCardPath = (userId: string) => `${userId}/${newSubmissionId()}.jpg`

export async function uploadCard(supabase: Supabase, userId: string, photo: Blob): Promise<string> {
  const path = newCardPath(userId)
  const { error } = await supabase.storage.from(CARD_BUCKET).upload(path, photo, {
    contentType: 'image/jpeg', upsert: false, cacheControl: '3600',
  })
  if (error) throw new Error(error.message || 'The photo could not be uploaded')
  return path
}

/** Five minutes is plenty to look at it; the link is not kept. */
export async function signedCardUrl(supabase: Supabase, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(CARD_BUCKET).createSignedUrl(path, 300)
  return error ? null : data.signedUrl
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export type AttachOutcome = { ok: true } | { ok: false; missing: ('email' | 'photo')[] }

/**
 * After the lead exists: upload the photograph (if there is one) and attach it
 * with the email. A few tries, a little apart — hall Wi-Fi drops — and each part
 * is remembered, so a retry never uploads twice. Nothing here can undo the lead.
 */
export async function attachExtras(
  supabase: Supabase,
  send: (changes: { email?: string | null; card_photo_path?: string | null }) => Promise<unknown>,
  init: { userId: string; submissionId: string; leadId: string; email: string },
  waitMs: (attempt: number) => number = n => 1500 * n,
): Promise<AttachOutcome> {
  const photo = peekCard(init.submissionId)
  if (!init.email && !photo) return { ok: true }
  let path: string | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (photo && !path) path = await uploadCard(supabase, init.userId, photo)
      const changes: { email?: string | null; card_photo_path?: string | null } = {}
      if (init.email) changes.email = init.email
      if (path) changes.card_photo_path = path
      await send(changes)
      forgetCard(init.submissionId)
      return { ok: true }
    } catch {
      if (attempt < 3) await sleep(waitMs(attempt))
    }
  }
  forgetCard(init.submissionId)
  return { ok: false, missing: [...(init.email ? ['email' as const] : []), ...(photo ? ['photo' as const] : [])] }
}
