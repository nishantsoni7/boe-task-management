import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  detectDuplicates,
  employeeView,
  normalizeName,
  normalizeText,
  type DuplicateCandidate,
  type DuplicateMatch,
  type EmployeeDuplicateView,
} from './duplicateDetection'

// SERVER ONLY. Runs the duplicate check for a submission, an edit or a
// reapplication: fetches every earlier review (deleted ones included) through
// the service-role candidate function, compares, and produces
//
//   * what the DATABASE stores (toDatabaseArgument), and
//   * what the EMPLOYEE may see (toEmployeeView) — reason categories only.
//
// A CHECK THAT FAILS IS NOT A CLEAN CHECK. Any error while reading candidates or
// comparing returns status 'unavailable'; the caller shows "Duplicate check
// unavailable" and the database records it as such.
//
// THE ACKNOWLEDGEMENT TOKEN ties "Submit anyway" to the warning the employee
// actually saw. It is the SHA-256 of the sorted matched ids and reasons (or the
// word "unavailable"): if a new match appears between the warning and the save,
// the token no longer fits and the employee is warned again. It reveals nothing:
// the ids it hashes are never sent to the employee.

export type DuplicateOutcome = {
  status: 'clear' | 'flagged' | 'unavailable'
  matches: DuplicateMatch[]
  /** SHA-256 of proof hash, normalized name and normalized text — the content the check was about. */
  fingerprint: string
  /** What "Submit anyway" must echo. Empty when the status is clear. */
  token: string
  /** Submission references, for the employee's OWN earlier reviews only. */
  refs: Map<string, string>
}

export type DuplicateCheckInput = {
  service: SupabaseClient
  actorId: string
  /** The review being edited or reapplied; left out of the comparison. */
  excludeId: string | null
  reviewerName: string | null
  reviewText: string | null
  sha256: string
  phash: string | null
}

export function normalizedFields(reviewerName: string | null, reviewText: string | null) {
  const nameNorm = normalizeName(reviewerName)
  const textNorm = normalizeText(reviewText)
  return { nameNorm: nameNorm === '' ? null : nameNorm, textNorm: textNorm === '' ? null : textNorm }
}

export function contentFingerprint(sha256: string, nameNorm: string | null, textNorm: string | null): string {
  return createHash('sha256').update(`${sha256}|${nameNorm ?? ''}|${textNorm ?? ''}`).digest('hex')
}

export function duplicateToken(status: DuplicateOutcome['status'], matches: DuplicateMatch[]): string {
  if (status === 'clear') return ''
  if (status === 'unavailable') return 'unavailable'
  const body = matches
    .map(m => `${m.matchedId}:${[...m.reasons].sort().join('+')}`)
    .sort()
    .join('|')
  return createHash('sha256').update(body).digest('hex')
}

type CandidateRow = {
  id: string
  submitted_by: string
  submission_ref: string
  reviewer_name_norm: string | null
  review_text_norm: string | null
  proof_content_sha256: string
  proof_phash: string | null
  deleted: boolean
}

export async function runDuplicateCheck(input: DuplicateCheckInput): Promise<DuplicateOutcome> {
  const { nameNorm, textNorm } = normalizedFields(input.reviewerName, input.reviewText)
  const fingerprint = contentFingerprint(input.sha256, nameNorm, textNorm)
  const unavailable: DuplicateOutcome = {
    status: 'unavailable', matches: [], fingerprint, token: 'unavailable', refs: new Map(),
  }
  try {
    const { data, error } = await input.service.rpc('customer_review_custom_duplicate_candidates', {
      p_exclude: input.excludeId,
    })
    if (error || !Array.isArray(data)) return unavailable

    const rows = data as CandidateRow[]
    const refs = new Map(rows.map(r => [r.id, r.submission_ref]))
    const candidates: DuplicateCandidate[] = rows.map(r => ({
      id: r.id,
      submittedBy: r.submitted_by,
      nameNorm: r.reviewer_name_norm,
      textNorm: r.review_text_norm,
      sha256: r.proof_content_sha256,
      phash: r.proof_phash,
      deleted: r.deleted,
    }))
    const matches = detectDuplicates({ nameNorm, textNorm, sha256: input.sha256, phash: input.phash }, candidates)
    const status = matches.length === 0 ? 'clear' : 'flagged'
    return { status, matches, fingerprint, token: duplicateToken(status, matches), refs }
  } catch {
    return unavailable
  }
}

/** What the employee is told. Reason categories, and their own earlier review's reference — nothing else. */
export function toEmployeeView(outcome: DuplicateOutcome, actorId: string): EmployeeDuplicateView {
  return employeeView(outcome.status, outcome.matches, actorId, id => outcome.refs.get(id))
}

/** The argument the create / edit / reapply function stores, in the same transaction as the change. */
export function toDatabaseArgument(outcome: DuplicateOutcome, employeeProceeded: boolean) {
  return {
    status: outcome.status,
    fingerprint: outcome.fingerprint,
    employee_proceeded: outcome.status !== 'clear' && employeeProceeded,
    matches: outcome.matches.map(m => ({
      matched_id: m.matchedId,
      reasons: m.reasons,
      strength: m.strength,
      evidence: m.evidence,
    })),
  }
}
