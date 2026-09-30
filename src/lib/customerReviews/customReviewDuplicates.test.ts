/**
 * Duplicate detection for custom reviews (20270224000000) — what the migration,
 * the routes and the screens SAY, for the guarantees a browser cannot get around:
 *
 *   the server rechecks on every save and answers 409 BEFORE anything is stored;
 *   "Submit anyway" is bound to the warning that was shown, and stored;
 *   an unavailable check is recorded as unavailable, never as clear;
 *   evidence is a verifier's — employees get reason categories only;
 *   a decision changes no status and no credit, and a changed review is checked again.
 *
 * The same rules are EXECUTED against PostgreSQL by
 * supabase/tests/custom_review_duplicate_assertions.sql; the matching itself is
 * tested in duplicateDetection.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/customReviewDuplicates.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DUPLICATE_REASON_LABELS,
  DUPLICATE_UNAVAILABLE_TITLE,
  DUPLICATE_WARNING_TITLE,
  DUPLICATE_THRESHOLDS,
} from './duplicateDetection'
import {
  CUSTOM_SUBMISSION_COLUMNS,
  CUSTOM_SUBMISSION_EVENT_LABELS,
  CUSTOM_SUBMISSION_EVENT_TYPES,
  customSubmissionFailureStatus,
  parseMatchFields,
} from './customSubmissions'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const SQL = read('supabase/migrations/20270224000000_customer_review_custom_duplicate_detection.sql')
const code = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const ROUTE = read('src/app/api/customer-reviews/custom-submissions/route.ts')
const WORKSPACE = read('src/components/customerReviews/CustomReviewSubmissions.tsx')
const QUEUE = read('src/app/customer-reviews/CustomSubmissionsScreen.tsx')
const REVIEW = read('src/components/customerReviews/DuplicateReview.tsx')
const NEXT_CONFIG = read('next.config.ts')

function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`)
  assert.ok(start !== -1, `${name} is not defined`)
  const body = code.indexOf('$$', start)
  const end = code.indexOf('$$;', body + 2)
  return code.slice(start, end)
}
function verb(name: string): string {
  const start = ROUTE.indexOf(`export async function ${name}(`)
  assert.ok(start !== -1, name)
  const next = ROUTE.indexOf('\nexport async function', start + 10)
  return ROUTE.slice(start, next === -1 ? undefined : next)
}

describe('the fields the check compares', () => {
  test('name and text are optional, trimmed, and bounded like the database', () => {
    assert.deepEqual(parseMatchFields({ reviewerName: '  ', reviewText: '' }), { ok: true, value: { reviewerName: null, reviewText: null } })
    assert.deepEqual(parseMatchFields({ reviewerName: ' Priya ', reviewText: ' Nice. ' }), { ok: true, value: { reviewerName: 'Priya', reviewText: 'Nice.' } })
    assert.equal(parseMatchFields({ reviewerName: 'x'.repeat(81), reviewText: null }).ok, false)
    assert.equal(parseMatchFields({ reviewerName: null, reviewText: 'x'.repeat(2001) }).ok, false)
    assert.match(SQL, /length\(reviewer_name\) <= 80/)
    assert.match(SQL, /length\(review_text\) <= 2000/)
  })
  test('the screens read them, the history has two more events', () => {
    assert.ok(CUSTOM_SUBMISSION_COLUMNS.includes('reviewer_name') && CUSTOM_SUBMISSION_COLUMNS.includes('review_text'))
    for (const t of ['duplicate_flagged', 'duplicate_decided'] as const) {
      assert.ok(CUSTOM_SUBMISSION_EVENT_TYPES.includes(t))
      assert.ok(CUSTOM_SUBMISSION_EVENT_LABELS[t])
    }
    assert.match(code, /event_type in \('submitted', 'rejected', 'reapplied', 'approved', 'edited', 'deleted',\s+'duplicate_flagged', 'duplicate_decided'\)/)
  })
})

describe('the server rechecks on every save, before anything is stored', () => {
  for (const name of ['POST', 'PUT', 'PATCH']) {
    test(`${name}: the gate runs before the upload and blocks with the warning`, () => {
      const body = verb(name)
      const gate = body.indexOf('await duplicateGate(')
      assert.ok(gate !== -1, 'the gate runs')
      assert.match(body, /if \('block' in gate\) return gate\.block/)
      const upload = body.indexOf('.upload(')
      assert.ok(upload === -1 || gate < upload, 'the gate comes before the storage upload')
      assert.match(body, /p_duplicate:\s+gate\.argument/)
      assert.match(body, /p_proof_phash:\s+gate\.phash/)
      assert.match(body, /p_reviewer_name_norm:\s+gate\.nameNorm/)
    })
  }
  test('a possible duplicate or an unavailable check is a 409 with categories and a token — never ids', () => {
    const gate = ROUTE.slice(ROUTE.indexOf('async function duplicateGate('), ROUTE.indexOf('/** The fields every save reads'))
    assert.match(gate, /outcome\.status !== 'clear' && args\.acknowledged !== outcome\.token/)
    assert.match(gate, /status: 409/)
    assert.match(gate, /toEmployeeView\(outcome, args\.actorId\)/)
    assert.match(gate, /DUPLICATE_UNAVAILABLE_TITLE : DUPLICATE_WARNING_TITLE/)
    assert.doesNotMatch(gate, /matchedId|matched_id/, 'the response carries no match ids')
    assert.match(gate, /code: 'possible_duplicate',\s+duplicate: toEmployeeView\(outcome, args\.actorId\),\s+token: outcome\.token,\s+\},\s+\{ status: 409/,
      'exactly error, code, duplicate, token')
    assert.match(gate, /code: 'possible_duplicate'/)
  })
  test('an unhashable image or a missing hash is UNAVAILABLE, not clear', () => {
    const gate = ROUTE.slice(ROUTE.indexOf('async function duplicateGate('), ROUTE.indexOf('/** The fields every save reads'))
    assert.match(gate, /hashFailed = true/)
    assert.match(gate, /hashFailed\s*\n?\s*\? \{ status: 'unavailable'/)
  })
  test('content the last check already covered is not warned about again', () => {
    const gate = ROUTE.slice(ROUTE.indexOf('async function duplicateGate('), ROUTE.indexOf('/** The fields every save reads'))
    assert.match(gate, /lastFingerprint === fingerprint/)
    assert.match(gate, /return \{ argument: null/)
  })
  test('an edit compares against everyone but itself', () => {
    assert.match(ROUTE, /excludeId: args\.submissionId/)
    assert.match(fn('customer_review_custom_duplicate_candidates'), /p_exclude is null or s\.id <> p_exclude/)
  })
  test('deleted reviews stay comparison evidence', () => {
    const cand = fn('customer_review_custom_duplicate_candidates')
    assert.doesNotMatch(cand, /deleted_at is null/)
    assert.match(cand, /\(s\.deleted_at is not null\)/)
  })
  test('the route works from hashes, never a filename or URL', () => {
    const lib = read('src/lib/customerReviews/duplicateCheck.server.ts')
    assert.match(lib, /proof_content_sha256/)
    assert.match(lib, /proof_phash/)
    assert.doesNotMatch(lib, /proof_file_name|storage_path|signedUrl/)
  })
  test('sharp is traced into the route that now hashes with it', () => {
    assert.match(NEXT_CONFIG, /'\/api\/customer-reviews\/custom-submissions': \['\.\/node_modules\/@img\/sharp-libvips-linux-x64\/\*\*\/\*'\]/)
  })
})

describe('the database stores what the route found, and refuses what it cannot trust', () => {
  const record = fn('record_customer_review_custom_duplicate_check')
  test('a warning the employee did not acknowledge is refused, with the marker the route maps to 409', () => {
    assert.match(record, /v_status <> 'clear' and not v_proceeded/)
    assert.match(record, /CUSTOMER_REVIEW_CUSTOM_DUPLICATE_WARNING/)
    assert.equal(customSubmissionFailureStatus('CUSTOMER_REVIEW_CUSTOM_DUPLICATE_WARNING: x'), 409)
  })
  test('the result is validated: status, fingerprint, consistency, self match, reasons, matched review', () => {
    assert.match(record, /v_status not in \('clear', 'flagged', 'unavailable'\)/)
    assert.match(record, /v_fp !~ '\^\[0-9a-f\]\{64\}\$'/)
    assert.match(record, /v_matched = p_submission_id/)
    assert.match(record, /<@ array\['reviewer_name', 'review_text', 'image'\]/)
    assert.match(record, /A matched review does not exist/)
    assert.match(record, /An unavailable check cannot carry matches/)
  })
  test('the run and its flags are written inside the change\'s own transaction, by the three save functions', () => {
    for (const [name, trigger] of [
      ['create_customer_review_custom_submission', 'submitted'],
      ['edit_customer_review_custom_submission', 'edited'],
      ['reapply_customer_review_custom_submission', 'reapplied'],
    ] as const) {
      assert.match(fn(name), new RegExp(`record_customer_review_custom_duplicate_check\\([^)]*'${trigger}', p_duplicate\\)`), name)
    }
    assert.match(code, /revoke execute on function public\.record_customer_review_custom_duplicate_check\(uuid, uuid, text, jsonb\)\s+from public, anon, authenticated, service_role;/)
  })
  test('the old signatures are dropped so a call is never ambiguous', () => {
    assert.match(code, /drop function if exists public\.create_customer_review_custom_submission\(uuid, uuid, text, date, text, text, text, text, integer, text\);/)
    assert.match(code, /drop function if exists public\.edit_customer_review_custom_submission\(uuid, uuid, text, date, text, integer, text, text, text, integer, text\);/)
    assert.match(code, /drop function if exists public\.reapply_customer_review_custom_submission\(uuid, uuid, text, date, text, text, text, text, text, integer, text\);/)
  })
  test('a flag records reasons, strength, evidence, whether the employee proceeded, and once per content', () => {
    assert.match(code, /reasons\s+text\[\]\s+not null/)
    assert.match(code, /strength\s+text\s+not null check \(strength in \('strong', 'moderate', 'weak'\)\)/)
    assert.match(code, /evidence\s+jsonb\s+not null/)
    assert.match(code, /employee_proceeded\s+boolean\s+not null default false/)
    assert.match(code, /unique \(submission_id, matched_submission_id, content_fingerprint\)/)
  })
})

describe('private evidence stays private', () => {
  test('one SELECT policy per evidence table, for verifiers only; no client write', () => {
    assert.equal((code.match(/create policy/g) ?? []).length, 2)
    assert.match(code, /using \(public\.can_read_customer_review_custom_duplicate_evidence\(\)\)/)
    assert.match(fn('can_read_customer_review_custom_duplicate_evidence'), /resolve_permission\(auth\.uid\(\), 'customer_review_requests', 'verify'\)/)
    assert.match(code, /revoke insert, update, delete, truncate, references, trigger on public\.customer_review_custom_duplicate_flags\s+from authenticated, anon;/)
    assert.doesNotMatch(code, /grant\s+(insert|update|delete)/i)
  })
  test('the summary view runs as the reader, so an employee reads none of it', () => {
    assert.match(code, /create or replace view public\.customer_review_custom_duplicate_summary\s+with \(security_invoker = true\)/)
    assert.match(code, /revoke all on public\.customer_review_custom_duplicate_summary from anon;/)
  })
  test('the candidate list is service-role only', () => {
    assert.match(code, /revoke execute on function public\.customer_review_custom_duplicate_candidates\(uuid\) from public, anon, authenticated;/)
    assert.match(code, /grant\s+execute on function public\.customer_review_custom_duplicate_candidates\(uuid\) to service_role;/)
  })
  test('the employee\'s response is built by employeeView and the route sends nothing else about a match', () => {
    const lib = read('src/lib/customerReviews/duplicateCheck.server.ts')
    assert.match(lib, /employeeView\(outcome\.status, outcome\.matches, actorId/)
    assert.doesNotMatch(WORKSPACE, /matched_id|matchedId|matched_submission_id/, 'the employee screen never reads a matched id')
  })
})

describe('decisions', () => {
  const decide = fn('decide_customer_review_custom_duplicate')
  test('a verifier only, never the review\'s own submitter, only on the current run', () => {
    assert.match(decide, /resolve_permission\(v_uid, 'customer_review_requests', 'verify'\)/)
    assert.match(decide, /s\.submitted_by = v_uid/)
    assert.match(decide, /CUSTOMER_REVIEW_CUSTOM_SELF/)
    assert.match(decide, /v_latest is distinct from f\.content_fingerprint/)
    assert.match(decide, /CUSTOMER_REVIEW_CUSTOM_STALE/)
  })
  test('it changes no status and no credit, and the history keeps each decision', () => {
    assert.doesNotMatch(decide, /update public\.customer_review_custom_submissions|boe_credit|status\s*=\s*'(approved|rejected)'/)
    assert.match(decide, /'duplicate_decided'/)
    assert.match(decide, /'previous_decision', v_previous/)
  })
  test('a flag can change only its decision, and nothing is deleted', () => {
    const guard = fn('customer_review_custom_duplicate_flags_guard')
    assert.match(guard, /only the decision on a duplicate flag may change/)
    assert.match(guard, /tg_op = 'DELETE'/)
    assert.match(fn('customer_review_custom_duplicate_checks_guard'), /never changed or deleted/)
  })
  test('a weak (name-only) flag is stored but not queued', () => {
    assert.match(code, /count\(\*\) filter \(where fl\.decision is null and fl\.strength <> 'weak'\)\s+as flags_open/)
  })
  test('changed content is checked again: decisions belong to one fingerprint', () => {
    assert.match(code, /fl\.content_fingerprint = c\.content_fingerprint/)
    assert.match(code, /on conflict \(submission_id, matched_submission_id, content_fingerprint\) do nothing/)
  })
  test('the approval and reward functions are not touched by this migration', () => {
    assert.doesNotMatch(code, /create or replace function public\.approve_customer_review_custom_submission/)
    assert.doesNotMatch(code, /create or replace function public\.reject_customer_review_custom_submission/)
    assert.doesNotMatch(code, /post_boe_credit/)
  })
})

describe('the older-review backfill changes only a null hash', () => {
  test('the guard allows exactly that and the function is service-role only', () => {
    assert.match(code, /old\.proof_phash is null and new\.proof_phash is not null\s+and \(to_jsonb\(new\) - 'proof_phash' - 'updated_at'\) = \(to_jsonb\(old\) - 'proof_phash' - 'updated_at'\)/)
    assert.match(code, /revoke execute on function public\.backfill_customer_review_custom_proof_phash\(uuid, text\) from public, anon, authenticated;/)
    assert.match(code, /grant\s+execute on function public\.backfill_customer_review_custom_proof_phash\(uuid, text\) to service_role;/)
    const script = read('scripts/backfill-review-image-hashes.ts')
    assert.match(script, /--apply/)
    assert.match(script, /\.is\('proof_phash', null\)/)
    assert.doesNotMatch(script, /\.delete\(|\.upload\(|\.remove\(/)
  })
})

describe('the screens', () => {
  test('the employee sees an amber icon, the title, the reasons and three choices — inline', () => {
    assert.match(WORKSPACE, /AlertTriangle/)
    assert.match(WORKSPACE, /role="alert"/)
    assert.match(WORKSPACE, /DUPLICATE_WARNING_TITLE/)
    assert.match(WORKSPACE, /DUPLICATE_UNAVAILABLE_TITLE/)
    assert.match(WORKSPACE, /DUPLICATE_REASON_LABELS\[reason\]/)
    assert.match(WORKSPACE, /Edit review/)
    assert.match(WORKSPACE, /Submit anyway/)
    assert.match(WORKSPACE, /onClick=\{onClose\}|onClick=\{\(\) => \{ if \(!busy\) onClose\(\) \}\}|Cancel/)
    assert.equal(DUPLICATE_WARNING_TITLE, 'Possible duplicate review')
    assert.equal(DUPLICATE_UNAVAILABLE_TITLE, 'Duplicate check unavailable')
    assert.deepEqual(Object.values(DUPLICATE_REASON_LABELS), ['Same reviewer name', 'Similar review text', 'Similar image'])
  })
  test('nothing is saved by the warning: Submit anyway resends with the token', () => {
    assert.match(WORKSPACE, /response\.status === 409 && payload\?\.code === 'possible_duplicate'/)
    assert.match(WORKSPACE, /acknowledgeDuplicate/)
    assert.match(WORKSPACE, /submit\(warning\.token\)/)
  })
  test('editing a compared field clears the warning so it is checked again', () => {
    assert.ok((WORKSPACE.match(/setWarning\(null\)/g) ?? []).length >= 4)
  })
  test('no notification is created for a duplicate warning', () => {
    assert.doesNotMatch(fn('record_customer_review_custom_duplicate_check'), /notifications/)
    assert.doesNotMatch(fn('decide_customer_review_custom_duplicate'), /notifications/)
    assert.doesNotMatch(read('src/lib/customerReviews/duplicateCheck.server.ts'), /notifications/)
  })
  test('the verifier sees the badge in the list and the detail, a comparison, and two decisions', () => {
    assert.match(QUEUE, /<DuplicateBadge summary=\{duplicates\?\.get\(row\.id\)\} \/>/)
    assert.match(QUEUE, /<DuplicatePanel/)
    assert.match(REVIEW, /decide_customer_review_custom_duplicate/)
    assert.match(REVIEW, />\s*Duplicate\s*</)
    assert.match(REVIEW, />\s*Different review\s*</)
    assert.match(REVIEW, /Recording a decision does not approve, reject or change any credit/)
  })
  test('a failed read is "unavailable", never "clear"', () => {
    assert.match(REVIEW, /if \(error\) return null/)
    assert.match(REVIEW, /\{DUPLICATE_UNAVAILABLE_TITLE\}\. The duplicate results could not be loaded/)
  })
  test('the thresholds the docs quote are the ones in the code', () => {
    const doc = read('docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md')
    for (const v of [
      DUPLICATE_THRESHOLDS.TEXT_MIN_CHARS, DUPLICATE_THRESHOLDS.TEXT_MIN_TOKENS, DUPLICATE_THRESHOLDS.TEXT_NEAR_MIN,
      DUPLICATE_THRESHOLDS.TEXT_NEAR_STRONG, DUPLICATE_THRESHOLDS.IMAGE_STRONG_MAX_RATIO, DUPLICATE_THRESHOLDS.IMAGE_SIMILAR_MAX_RATIO,
      DUPLICATE_THRESHOLDS.IMAGE_MIN_MARKED_BITS,
    ]) {
      assert.ok(doc.includes(String(v)), `the docs state ${v}`)
    }
  })
})
