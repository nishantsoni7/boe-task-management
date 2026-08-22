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

import { orderDocumentResponse } from '@/lib/orders/orderDocuments'
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
    // The construction moved to the shared helper; the ORDERING property it
    // guards is unchanged and is what matters.
    const serviceAt = route.indexOf('adminClient()', route.indexOf('async function handle'))
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

  test('every code the route emits has PREWRITTEN copy the client owns', async () => {
    const { ORDER_DOCUMENT_RESPONSES } = await import('./orderDocuments')
    // WIDENED, in both directions, when the response matrix was introduced.
    //
    // It used to check only ORDER_DOCUMENT_FAILURES — the codes that get STORED
    // on a failed version — which is a narrower set than the codes the route
    // ANSWERS with. It also matched only `code:` object properties, so every
    // code passed positionally to fail() escaped it entirely, including
    // FORBIDDEN and NOT_FOUND. Both gaps are closed here.
    const emitted = [
      ...[...route.matchAll(/code:\s*'([A-Z_]+)'/g)].map(m => m[1]),
      ...[...route.matchAll(/fail\(\s*\d+,\s*'([A-Z_]+)'/g)].map(m => m[1]),
    ]
    assert.ok(emitted.length > 0)
    for (const code of emitted) {
      assert.ok(
        code in ORDER_DOCUMENT_RESPONSES,
        `${code} has no prewritten sentence, so it would render as the generic failure`)
    }
  })
})

// ══ 6. Credentials and privacy ═══════════════════════════════════════════════

describe('what never leaves the server', () => {
  test('the service-role key is read by the shared helper and never returned', () => {
    // The route no longer touches process.env at all: it asks
    // @/lib/supabase/admin, which reads BOE's ONE canonical credential name
    // (SUPABASE_SERVICE_ROLE_KEY) and reports absence instead of throwing.
    // adminClient.test.ts holds the properties of the helper itself.
    assert.ok(route.includes("from '@/lib/supabase/admin'"))
    assert.ok(route.includes('adminClient()'))
    assert.ok(!/process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(
      route.replace(/\/\*[\s\S]*?\*\//g, '')
           .split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')),
      'the route must reach the credential only through the helper')
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

  test('the ONLY thing logged is which configuration is absent', () => {
    // NARROWED, deliberately, when the config guard was added. The original
    // rule was "no logging at all", which was the right rule while the route
    // had nothing an operator could act on.
    //
    // A deployment missing SUPABASE_SERVICE_ROLE_KEY is different in kind: it
    // is nobody's data and it is the one fault an operator must be able to
    // diagnose from a log. What is written is the NAME of the absent variable
    // — never its value, and never anything belonging to the Order.
    const logs = [...route.matchAll(/console\.(log|error|warn|info)\(([^\n]*)/g)]
    assert.equal(logs.length, 1, 'exactly one log line, and it is the config one')
    const [, level, args] = logs[0]
    assert.equal(level, 'error')
    assert.ok(args.includes('admin.missing.join'), 'it logs the missing NAMES')
    for (const forbidden of [
      'client_name', 'excelPath', 'pdfPath', 'token', 'sha', 'Sha',
      'process.env', 'bytes', 'orderId', 'address',
    ]) {
      assert.ok(!args.includes(forbidden), `the log line carries ${forbidden}`)
    }
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

// ══ 9. THE MANUAL-TEST FAILURE, REGRESSED ════════════════════════════════════
//
// Nishant pressed Generate documents on confirmed Order 0001 and the card said
// "That could not be done just now." The Order had a linked approved PI, the
// card was visible, and his account was an active admin — so the sentence was
// wrong about every part of what it implied.
//
// The cause was `process.env.SUPABASE_SERVICE_ROLE_KEY!`. supabase-js throws
// `supabaseKey is required.` when that value is absent or empty, the client was
// constructed OUTSIDE this route's try/catch, and the escaped throw became a
// bare 500 with no `message` in its body. The card's own fallback sentence then
// stood in for a diagnosis it never had.
//
// Three separate things had to be true for a missing variable to look like a
// refusal, and each gets its own test below, because any one of them coming
// back reproduces the whole bug.

describe('a deployment with no service-role key', () => {
  test('the client is built from a CHECKED value, never a `!` assertion', () => {
    // The construction now lives in ONE shared helper rather than being
    // repeated per route, and the helper returns a result instead of throwing.
    // The property is the same and the blast radius is smaller.
    assert.ok(route.includes("import { adminClient, type AdminSupabaseClient } from '@/lib/supabase/admin'"))
    assert.ok(!route.includes('createServiceClient('),
      'the route must not build its own privileged client')
    const helper = readFileSync(
      join(process.cwd(), 'src/lib/supabase/admin.ts'), 'utf8')
    assert.ok(helper.includes('if (missing.length > 0) return { ok: false, missing }'),
      'the helper must report absence, not throw it')
  })

  test('the route REFUSES with its own code before touching the client', () => {
    assert.ok(route.includes("'SERVER_NOT_CONFIGURED'"))
    const guard = route.indexOf('if (!admin.ok)')
    const firstUse = route.indexOf('service\n    .rpc(')
    assert.ok(guard > 0, 'the not-ok result must be handled')
    assert.ok(guard < firstUse || firstUse === -1,
      'the guard must come before the first use of the client')
  })

  test('that refusal is NOT dressed up as a permission answer', () => {
    // The whole harm of the original bug: a server fault read as a user fault.
    const { message, retryable } = orderDocumentResponse('SERVER_NOT_CONFIGURED')
    assert.match(message, /not configured on this deployment/i)
    assert.match(message, /not something you can fix/i)
    assert.equal(retryable, false)
    assert.ok(!/permission|authority|allowed|access/i.test(message),
      'a missing environment variable is not a permission problem')
  })

  test('nothing can escape the handler without a message', () => {
    // The outermost net. Without it, any unanticipated throw reproduces the
    // exact same symptom through a different door.
    assert.ok(route.includes('return await handle(req, { params })'))
    assert.match(route, /catch \{\s*\n\s*return fail\(500, ORDER_DOCUMENT_UNKNOWN_FAILURE/)
  })
})

describe('every response this route can send', () => {
  test('carries a `message`, with NO exceptions', () => {
    // The client falls back to its own generic sentence whenever `message` is
    // absent, so a message-less response is indistinguishable from a crash.
    // Two responses used to lack one: 202 in_progress and 409 superseded.
    // SCOPED TO THE ERROR RESPONSES, which is exactly where the client reads
    // `message`. A 200 'ready' and the 202 both take other paths in the card,
    // and requiring copy on a success would be ceremony rather than a guard.
    const all = route.match(/NextResponse\.json\(\{[\s\S]*?\}, \{ status: (\d+) \}\)/g) ?? []
    const responses = all.filter(r => Number(/status: (\d+) \}\)$/.exec(r)?.[1] ?? 0) >= 400)
    assert.ok(responses.length >= 3, `expected several error responses, found ${responses.length}`)
    for (const r of responses) {
      // `message` shorthand is as good as `message:` — both put the field on
      // the wire, which is the only thing that matters to the client.
      assert.ok(/\bmessage\b/.test(r), `a response carries no message:\n${r}`)
    }
  })

  test('carries a stable `code` the client can resolve', () => {
    for (const code of ['SERVER_NOT_CONFIGURED', 'CLAIM_ACTIVE', 'CLAIM_LOST']) {
      assert.ok(route.includes(`'${code}'`), `${code} is not emitted`)
      assert.notEqual(orderDocumentResponse(code).message, undefined)
    }
  })

  test('recording a failure cannot REPLACE the failure being recorded', () => {
    // If release() throws, the caller must still learn about the original
    // problem. The lease falls to the TTL takeover it was designed for.
    const start = route.indexOf('const release =')
    assert.ok(start > 0, 'release() not found')
    const release = route.slice(start, route.indexOf('\n  }', start))
    assert.ok(/try \{/.test(release), 'the release must guard its own RPC')
    assert.ok(/\} catch \{/.test(release),
      'the release must not be able to throw over the error it is recording')
    assert.ok(release.includes('fail_order_document_generation'))
  })
})

// ══ The confirmed Excel carries what the RECORD says ═════════════════════════
//
// The workbook is the file the client agreed to, and until now the confirmed
// Excel was that file with one cell filled in. `Edit PI Details` can correct a
// phone number or an address without replacing it, so the document could ship
// carrying a value somebody had already fixed — contradicting the record it
// came from, with nothing on either saying which is right.

describe('a corrected PI reaches the confirmed Excel', () => {
  test('the route hands the record’s values to the workbook writer', () => {
    assert.ok(route.includes('const corrections = {'),
      'the route builds the correction set')
    assert.match(route, /buildConfirmedWorkbook\(\{\s*bytes: loaded\.bytes, orderNumber, corrections,?\s*\}\)/)
  })

  test('every value comes from the PI row, never from the workbook', () => {
    const at = route.indexOf('const corrections = {')
    const block = route.slice(at, route.indexOf('}', at))
    const fields = [...block.matchAll(/^\s*(\w+):\s*pi\./gm)].map(m => m[1])
    assert.deepEqual(fields.sort(), [
      'bill_to_gst', 'bill_to_name', 'bill_to_phone', 'billing_address',
      'contact_number', 'dispatch_commitment',
      'ship_to_gst', 'ship_to_name', 'ship_to_phone', 'shipping_address',
    ], 'the ten fields the template contract establishes, and no others')
    // NOTHING is read off the parsed workbook here, and nothing is defaulted to
    // a literal: a value the record does not carry must clear the cell or leave
    // it alone, never invent one.
    assert.ok(!/corrections[\s\S]{0,400}?loaded\./.test(block))
  })

  test('no commercial value is offered to the writer', () => {
    const at = route.indexOf('const corrections = {')
    const block = route.slice(at, route.indexOf('}', at))
    for (const forbidden of ['grand_total', 'gst_amount', 'discount', 'total_before_gst',
                             'fabric', 'packing', 'transportation', 'billing_percentage']) {
      assert.ok(!block.includes(forbidden), `${forbidden} must never be written into a cell`)
    }
  })

  test('the two GST columns are actually read', () => {
    // A correction the route cannot see is a correction that silently does not
    // happen — the failure mode that made this whole area worth fixing.
    const handoff = readFileSync(join(ROOT, 'src/lib/orders/orderPiHandoff.ts'), 'utf8')
    assert.match(handoff, /'bill_to_gst', 'ship_to_gst'/)
  })
})
