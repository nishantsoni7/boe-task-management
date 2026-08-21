/**
 * The document-generation worker, and the guarantees it makes by ABSENCE.
 *
 * WHY SOURCE-SHAPE ASSERTIONS. This route is where a browser stops being
 * trusted and where the server's protected credentials start being used, and
 * almost every promise it makes is a promise about something NOT happening:
 *
 *   * the request is authorized AS THE CALLER, so RLS decides — using the
 *     service client there would bypass the two policies entirely and authorize
 *     anybody who could reach the URL;
 *   * nothing the client sends is read. There is no body. The PI, the workbook
 *     path, the version, the attempt and both destination keys are all resolved
 *     from the database;
 *   * a version is published only with both files, and only with a live token;
 *   * every upload is upsert:false, to a key nothing has ever occupied, so the
 *     original workbook and every earlier attempt's output are untouchable;
 *   * a failure stores a PREWRITTEN sentence and never an exception's own text;
 *   * the service-role key never leaves the server.
 *
 * A behavioural test cannot reach these without a live Supabase project and a
 * real bucket, which this session may not touch. So they are asserted against
 * the route's own source, exactly as processDraftRoute.test.ts does for the
 * save path. The logic underneath — the workbook rewrite, the provenance check,
 * the PDF model, the pagination — is unit-tested for real, elsewhere.
 *
 * Reads repository files only. No database, no network, no storage.
 *
 * Run:
 *   npx tsx --test src/lib/orders/documentsRoute.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/** Source with its comments removed. The route DOCUMENTS at length why it never
 *  trusts the client and never overwrites a file; a search over raw text would
 *  match the prose that promises the very thing it verifies. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const ROUTE = 'src/app/api/orders/[id]/documents/route.ts'
const raw = readFileSync(join(ROOT, ROUTE), 'utf8')
const route = stripComments(raw)

// ══ 1. The endpoint ══════════════════════════════════════════════════════════

describe('the endpoint', () => {
  test('is a POST route at /api/orders/[id]/documents', () => {
    assert.ok(existsSync(join(ROOT, ROUTE)))
    assert.ok(route.includes('export async function POST'))
  })

  test('runs on Node, because it rewrites a ZIP and renders a PDF', () => {
    assert.ok(route.includes("export const runtime = 'nodejs'"))
  })

  test('DECLARES ITS DURATION, and to a value every Vercel plan allows', () => {
    // A run cut off halfway leaves one object uploaded and the version claimed
    // until its lease goes stale. 60 is the Hobby ceiling, so this is portable
    // rather than tuned to a plan the repository cannot see.
    const declared = /export const maxDuration = (\d+)/.exec(route)?.[1]
    assert.ok(declared, 'maxDuration must be declared')
    assert.ok(Number(declared) > 0 && Number(declared) <= 60, `maxDuration ${declared} exceeds the Hobby ceiling`)
  })

  test('and there is no vercel.json whose settings it could contradict', () => {
    assert.ok(!existsSync(join(ROOT, 'vercel.json')))
  })

  test('exports nothing but POST — no GET that could become a second door', () => {
    const exported = [...route.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m => m[1])
    assert.deepEqual(exported.filter(n => /^(GET|POST|PUT|PATCH|DELETE)$/.test(n)), ['POST'])
  })
})

// ══ 2. Authorization ═════════════════════════════════════════════════════════

describe('who may generate', () => {
  test('the caller is identified from the SESSION, never from the request', () => {
    assert.ok(route.includes('await createClient()'))
    assert.ok(route.includes('authClient.auth.getUser()'))
    assert.ok(route.includes("fail(401, 'UNAUTHORIZED'"))
  })

  test('THE REQUEST RPC IS CALLED THROUGH THE CALLER\'S OWN CLIENT', () => {
    // The single most important line in this file. request_order_document_generation
    // is SECURITY INVOKER so the two write policies decide as the caller; sending
    // it through the service client would bypass row security and authorize
    // everybody.
    assert.match(route, /authClient\s*\n?\s*\.rpc\('request_order_document_generation'/)
    assert.ok(!/service\s*\n?\s*\.rpc\('request_order_document_generation'/.test(route),
      'the request must NOT go through the service client')
  })

  test('the service client is created only AFTER the request was authorized', () => {
    const requestAt = route.indexOf("rpc('request_order_document_generation'")
    const serviceAt = route.indexOf('serviceClient()', route.indexOf('export async function POST'))
    assert.ok(requestAt > 0 && serviceAt > requestAt,
      'privileged credentials must not be in hand before the caller has been authorized')
  })

  test('a refusal is translated, not echoed', () => {
    // A PostgREST message can name a constraint, a column or a function.
    assert.ok(route.includes("fail(403, 'FORBIDDEN'"))
    assert.ok(route.includes("fail(404, 'NOT_FOUND'"))
    assert.ok(!/message:\s*requestError\.message/.test(route))
    assert.ok(!/requestError\.message\s*\}/.test(route))
  })

  test('the worker half is called with the SERVICE client, which is what it is for', () => {
    for (const rpc of [
      'claim_order_document_generation',
      'complete_order_document_generation',
      'fail_order_document_generation',
    ]) {
      assert.match(route, new RegExp(`service\\s*\\n?\\s*\\.rpc\\('${rpc}'`), rpc)
    }
  })
})

// ══ 3. Nothing the client sends is trusted ═══════════════════════════════════

describe('what the route reads from the request', () => {
  test('THERE IS NO BODY. Not parsed, not read, not present', () => {
    assert.ok(!route.includes('req.json()'))
    assert.ok(!route.includes('req.text()'))
    assert.ok(!route.includes('formData'))
    assert.ok(!route.includes('searchParams'))
  })

  test('the Order id is validated as a uuid before anything else uses it', () => {
    assert.ok(route.includes('UUID.test(orderId)'))
    assert.ok(route.includes("fail(400, 'BAD_REQUEST'"))
  })

  test('NO STORAGE PATH COMES FROM THE CLIENT — every key is derived', () => {
    // The destination keys come back from the claim; the source key comes from
    // the PI record and is re-checked against that submission's own folder.
    assert.ok(route.includes('claim.excel_path'))
    assert.ok(route.includes('claim.pdf_path'))
    assert.ok(route.includes('workbook.source_workbook_path'))
    assert.ok(route.includes('loadApprovedWorkbook'))
  })

  test('and the claim\'s keys are CHECKED against the route\'s own path helper', () => {
    // Two implementations of one convention is how a file gets written where the
    // policy will not authorize it. A disagreement is a refusal.
    assert.ok(route.includes('orderDocumentAttemptPath(orderId, version, attempt'))
    assert.match(route, /excelPath !== expectedExcel \|\| pdfPath !== expectedPdf/)
  })

  test('a product image path is accepted only inside its own submission', () => {
    assert.match(route, /startsWith\(`submissions\/\$\{submissionId\}\//)
  })
})

// ══ 4. The files ═════════════════════════════════════════════════════════════

describe('what is written, and what is not', () => {
  test('EVERY UPLOAD IS upsert:false', () => {
    const uploads = [...route.matchAll(/\.upload\(([\s\S]*?)\)\s*\n/g)].map(m => m[1])
    assert.ok(uploads.length >= 2, 'both documents are uploaded')
    for (const call of uploads) {
      assert.ok(call.includes('upsert: false'), `an upload without upsert:false: ${call.trim()}`)
    }
  })

  test('nothing is REMOVED, MOVED or COPIED in storage', () => {
    // The original PI workbook is read and nothing else, and an earlier
    // attempt's output is history rather than something to tidy away.
    for (const forbidden of ['.remove(', '.move(', '.copy(', '.createSignedUploadUrl(']) {
      assert.ok(!route.includes(forbidden), `${forbidden} must not appear`)
    }
  })

  test('no public URL is ever built', () => {
    assert.ok(!route.includes('getPublicUrl'))
  })

  test('the workbook mimetype is the one the bucket admits', () => {
    assert.ok(route.includes('CONFIRMED_WORKBOOK_MIME'))
    assert.ok(route.includes("contentType: 'application/pdf'"))
  })

  test('both outputs are size-checked before they are uploaded', () => {
    assert.ok(route.includes('CONFIRMED_WORKBOOK_MAX_BYTES'))
    assert.ok(route.includes("code: 'PDF_TOO_LARGE'"))
    assert.ok(route.includes("code: 'WORKBOOK_TOO_LARGE'"))
  })

  test('BOTH FILES ARE UPLOADED BEFORE generate() REPORTS SUCCESS', () => {
    // Source order is not execution order across functions, so this reads the
    // generate() body specifically.
    const body = route.slice(route.indexOf('async function generate('))
    const excelAt = body.indexOf('excelUpload')
    const pdfAt = body.indexOf('pdfUpload')
    const okAt = body.indexOf('ok: true')
    assert.ok(excelAt > 0 && pdfAt > excelAt && okAt > pdfAt,
      'a success reported before both uploads would publish a one-file version')
  })

  test('and the version is published ONLY when generate() succeeded', () => {
    const post = route.slice(route.indexOf('export async function POST'),
      route.indexOf('async function generate('))
    const guardAt = post.indexOf('if (!outcome.ok)')
    const completeAt = post.indexOf("rpc('complete_order_document_generation'")
    assert.ok(guardAt > 0 && completeAt > guardAt,
      'publication must sit behind the failure guard')
  })

  test('and the publish call carries both paths and both hashes', () => {
    const at = route.indexOf("rpc('complete_order_document_generation'")
    const call = route.slice(at, at + 500)
    for (const arg of ['p_excel_path', 'p_pdf_path', 'p_excel_sha256', 'p_pdf_sha256', 'p_claim_token']) {
      assert.ok(call.includes(arg), arg)
    }
  })
})

// ══ 5. Failure ═══════════════════════════════════════════════════════════════

describe('when generation fails', () => {
  test('the claim is released with the matching token', () => {
    assert.ok(route.includes('p_claim_token: token'))
    assert.match(route, /fail_order_document_generation/)
  })

  test('THE STORED MESSAGE IS PREWRITTEN — the thrown value contributes nothing', () => {
    assert.ok(route.includes('sanitizeOrderDocumentFailure'))
    // The thrown value goes IN to the sanitizer and never out to the response.
    assert.ok(!/err\.message/.test(route))
    assert.ok(!/String\(err\)/.test(route))
    assert.ok(!/error:\s*err\b/.test(route))
  })

  test('a superseded run publishes NOTHING and releases NOTHING', () => {
    // Its output is stale, and the live claim belongs to somebody else — failing
    // it would take down a run that is still working.
    assert.ok(route.includes("status: 'superseded'"))
    const at = route.indexOf("status: 'superseded'")
    const around = route.slice(Math.max(0, at - 400), at)
    assert.ok(!around.includes('release('), 'a superseded run must not release another run\'s claim')
  })

  test('a claim that could not be taken is 202, not an error', () => {
    assert.ok(route.includes("status: 'in_progress'"))
    assert.ok(route.includes('{ status: 202 }'))
  })

  test('every failure code the route emits is one the sanitizer knows', async () => {
    const { ORDER_DOCUMENT_FAILURES } = await import('./orderDocuments')
    const emitted = [...route.matchAll(/code:\s*'([A-Z_]+)'/g)].map(m => m[1])
    assert.ok(emitted.length > 0)
    for (const code of emitted) {
      assert.ok(
        code in ORDER_DOCUMENT_FAILURES || code === 'GENERATION_FAILED',
        `${code} has no prewritten sentence, so it would render as the generic failure`)
    }
  })
})

// ══ 6. Credentials and privacy ═══════════════════════════════════════════════

describe('what never leaves the server', () => {
  test('the service-role key is read from the environment and never returned', () => {
    assert.ok(route.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'))
    const responses = [...route.matchAll(/NextResponse\.json\(([\s\S]*?)\)/g)].map(m => m[1])
    for (const body of responses) {
      // `claim.version` legitimately reads a field off the claim result; what
      // must never appear is the token itself, a storage key or a hash.
      for (const forbidden of ['SERVICE_ROLE', 'claim_token', 'excelPath', 'pdfPath', 'Sha', 'sha256']) {
        assert.ok(!body.includes(forbidden), `a response mentions ${forbidden}: ${body.trim().slice(0, 80)}`)
      }
    }
  })

  test('the claim token never reaches a response', () => {
    const responses = [...route.matchAll(/NextResponse\.json\(([\s\S]*?)\)/g)].map(m => m[1])
    for (const body of responses) {
      assert.ok(!body.includes('token'), body.trim().slice(0, 80))
    }
    // And it is never sent anywhere but the three RPCs that require it.
    const uses = [...route.matchAll(/\btoken\b/g)].length
    assert.ok(uses > 0 && uses <= 6, `the token is referenced ${uses} times; it should stay local`)
  })

  test('nothing is logged at all — no client name, no path, no byte', () => {
    assert.ok(!route.includes('console.log'))
    assert.ok(!route.includes('console.error'))
    assert.ok(!route.includes('console.warn'))
  })

  test('a response carries a status, a version and a prewritten message, and no more', () => {
    const keys = new Set(
      [...route.matchAll(/NextResponse\.json\(\{([\s\S]*?)\}/g)]
        .flatMap(m => [...m[1].matchAll(/(\w+)\s*:/g)].map(k => k[1])))
    for (const key of keys) {
      assert.ok(['status', 'version', 'code', 'message', 'error'].includes(key),
        `an unexpected response field: ${key}`)
    }
  })
})

// ══ 7. What it must not do ═══════════════════════════════════════════════════

describe('generation is separate from approval, and stays separate', () => {
  test('it never writes to public.orders', () => {
    assert.ok(!/from\('orders'\)[\s\S]{0,120}?\.(insert|update|upsert|delete)\(/.test(route))
  })

  test('it never touches a payment or an allocation', () => {
    for (const table of ['finance_payment_requests', 'finance_payment_allocations', 'payment_proof']) {
      assert.ok(!route.includes(table), table)
    }
  })

  test('it never allocates or reads an Order number cycle', () => {
    assert.ok(!route.includes('allocate_confirmed_order_number'))
    assert.ok(!route.includes('confirmed_order_number_cycle'))
    assert.ok(!route.includes('approve_order_submission'))
  })

  test('it writes to no table at all — only through the four RPCs', () => {
    assert.ok(!/\.(insert|update|upsert|delete)\(/.test(route),
      'every write goes through a named, audited RPC')
  })

  test('it reads the PI with NAMED columns, never `select(\'*\')`', () => {
    assert.ok(!route.includes(".select('*')"))
    assert.ok(route.includes('ORDER_PI_HANDOFF_COLUMNS'))
    assert.ok(route.includes('WORKBOOK_COLUMNS'))
  })
})

// ══ 8. Determinism ═══════════════════════════════════════════════════════════

describe('the PDF the route produces', () => {
  test('PINS ITS METADATA DATE, so a regeneration hashes the same', () => {
    // pdfkit stamps the clock unless told otherwise, which would make the
    // recorded sha256 a timestamp rather than an identity.
    assert.ok(route.includes('metadata:'))
    assert.ok(route.includes('order.confirm_date'))
    assert.ok(!/new Date\(\)/.test(route), 'the clock must not reach the document')
  })

  test('falls back to a FIXED instant when the Order has no confirm date', () => {
    assert.ok(route.includes('new Date(0)'))
  })

  test('reads the BOE mark from the repository, and survives its absence', () => {
    assert.ok(route.includes('boe-logo-full.png'))
    assert.match(raw, /A missing file\s*\n?\s*\*?\s*is not a failure/)
  })
})
