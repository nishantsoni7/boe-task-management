// Server-side learning for Customize image: reading the active rules and
// similar examples, recording attempts, and copying an example's pictures.
// SERVER ONLY — the three tables (20270420000000) have RLS on and no
// policies, so only the service role reaches them, and only after a route has
// asked the database, as the person, whether they may.
//
// BEST EFFORT on the salesperson's path. Until the migration is applied (or
// if a read fails), Check understanding and Regenerate work exactly as before:
// no rules, no examples, nothing recorded, no error shown.

import type { SupabaseClient } from '@supabase/supabase-js'
import { sniffImageFormat } from '@/lib/xlsxMediaOptimizer'
import {
  MAX_RULES_IN_PROMPT, examplePicturePath, keywordsFrom, rankExamples,
  type LearningExample, type LearningRule,
} from './customizationLearning'

export const ATTEMPTS = 'pi_customization_attempts'
export const RULES = 'pi_customization_rules'
export const EXAMPLES = 'pi_customization_examples'

/** Learning is not set up on this database yet (the migration is not applied). */
export function isLearningMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === '42P01' || error.code === 'PGRST205' || error.code === '42883' || error.code === 'PGRST202'
    || /pi_customization_|can_train_customize_image/.test(error.message ?? '')
}

export type LoadedLearning = { rules: LearningRule[]; examples: LearningExample[] }

/** The active rules and the most similar active examples, or nothing. */
export async function loadLearningFor(
  service: SupabaseClient,
  request: { comment: string; productName: string },
): Promise<LoadedLearning> {
  try {
    const [rules, examples] = await Promise.all([
      service.from(RULES).select('id, rule_text').eq('is_active', true)
        .order('created_at', { ascending: true }).limit(MAX_RULES_IN_PROMPT),
      // Candidates sharing at least one keyword; ranked here.
      service.from(EXAMPLES).select('id, comment, instruction, product_name, pi_dimensions, keywords, created_at')
        .eq('is_active', true).overlaps('keywords', keywordsFrom(request.comment, request.productName))
        .order('created_at', { ascending: false }).limit(50),
    ])
    if (rules.error && !isLearningMissing(rules.error)) console.error('[customize-learning] rules read failed', { code: rules.error.code })
    if (examples.error && !isLearningMissing(examples.error)) console.error('[customize-learning] examples read failed', { code: examples.error.code })
    return {
      rules: (rules.data ?? []) as LearningRule[],
      examples: rankExamples((examples.data ?? []) as LearningExample[], keywordsFrom(request.comment, request.productName)),
    }
  } catch {
    return { rules: [], examples: [] }
  }
}

/** Records one Check understanding. Returns its id, or null when it could not be recorded. */
export async function recordAttempt(service: SupabaseClient, row: Record<string, unknown>): Promise<string | null> {
  try {
    const { data, error } = await service.from(ATTEMPTS).insert(row).select('id').single()
    if (error) {
      if (!isLearningMissing(error)) console.error('[customize-learning] attempt not recorded', { code: error.code })
      return null
    }
    return (data as { id: string }).id
  } catch {
    return null
  }
}

/**
 * Updates the person's OWN attempt on this PI. The two .eq filters are the
 * authorization (service role): someone else's attempt id changes nothing.
 */
export async function updateOwnAttempt(
  service: SupabaseClient,
  attemptId: string,
  owner: { userId: string; submissionId?: string },
  patch: Record<string, unknown>,
): Promise<boolean> {
  try {
    let q = service.from(ATTEMPTS).update(patch).eq('id', attemptId).eq('created_by', owner.userId)
    if (owner.submissionId) q = q.eq('submission_id', owner.submissionId)
    const { data, error } = await q.select('id')
    if (error) {
      if (!isLearningMissing(error)) console.error('[customize-learning] attempt not updated', { code: error.code })
      return false
    }
    return (data ?? []).length > 0
  } catch {
    return false
  }
}

/** The Learning page's door, asked as the person. 'missing' = migration not applied. */
export async function mayTrain(authClient: SupabaseClient): Promise<'yes' | 'no' | 'missing'> {
  const { data, error } = await authClient.rpc('can_train_customize_image')
  if (error) return isLearningMissing(error) ? 'missing' : 'no'
  return data === true ? 'yes' : 'no'
}

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const

/** Copies one picture into the example's own folder. Null when the source is gone or not an image. */
export async function copyExamplePicture(
  service: SupabaseClient,
  exampleId: string,
  which: 'before' | 'after',
  sourcePath: string | null,
): Promise<string | null> {
  if (!sourcePath) return null
  const download = await service.storage.from('order-files').download(sourcePath)
  if (download.error || !download.data) return null
  const bytes = new Uint8Array(await download.data.arrayBuffer())
  const format = sniffImageFormat(bytes)
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') return null
  const path = examplePicturePath(exampleId, which, EXT[format])
  const { error } = await service.storage.from('order-files').upload(path, bytes, { contentType: MIME[format], upsert: true })
  return error ? null : path
}

/** Short-lived links for the Learning page, for paths the route has already read from the tables. */
export async function signPaths(service: SupabaseClient, paths: (string | null | undefined)[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => typeof p === 'string' && p !== ''))]
  if (unique.length === 0) return {}
  const { data } = await service.storage.from('order-files').createSignedUrls(unique, 600)
  return Object.fromEntries((data ?? []).filter(s => s.signedUrl && s.path).map(s => [s.path as string, s.signedUrl as string]))
}
