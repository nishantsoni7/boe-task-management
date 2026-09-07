/**
 * /api/orders/pi-revisions/approve — the server side of approving a revised PI
 * (20261119000000), pinned by its source.
 *
 * The route owns nothing of its own: it checks the actor, finds the pending
 * version, takes the processing lease, and hands the version id to the ONE
 * parser pipeline. This file proves those four facts and that the browser
 * hands up one id and nothing else.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piRevisionApproveRoute.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const read = (p: string) => stripComments(readFileSync(join(ROOT, p), 'utf8'))

const ROUTE = 'src/app/api/orders/pi-revisions/approve/route.ts'
const PIPELINE = 'src/app/api/orders/import/process-draft/route.ts'
const ORDER_PAGE = 'src/app/orders/[id]/page.tsx'
const route = read(ROUTE)

describe('the approve route', () => {
  test('is a POST route on Node, and the Order page calls exactly this path', () => {
    assert.ok(existsSync(join(ROOT, ROUTE)))
    assert.ok(route.includes('export async function POST'))
    assert.ok(route.includes("export const runtime = 'nodejs'"))
    assert.ok(read(ORDER_PAGE).includes("'/api/orders/pi-revisions/approve'"))
  })

  test('the body carries one id, and the actor comes from the session', () => {
    assert.ok(route.includes('versionId?: unknown'))
    assert.ok(route.includes('if (!isUuid(versionId))'))
    for (const forbidden of ['body.userId', 'body.actorId', 'body.submissionId', 'body.workbookPath', 'body.payload']) {
      assert.ok(!route.includes(forbidden), forbidden)
    }
    assert.ok(route.includes('const { data: { user } } = await authClient.auth.getUser()'))
    assert.ok(route.includes("if (!user) return fail(401, 'UNAUTHORIZED'"))
    assert.ok(route.includes('actorId: user.id'))
  })

  test('an active ADMIN, and nobody else — re-derived before a byte is downloaded', () => {
    assert.ok(route.includes('me.is_active !== true || me.is_deleted === true'))
    assert.ok(route.includes("if (me.role !== 'admin') {"))
    assert.ok(route.includes("fail(403, 'FORBIDDEN'"))
    assert.ok(!route.includes('approve_order'), 'holding orders.approve_order is not this authority')
    const adminAt = route.indexOf("me.role !== 'admin'")
    const leaseAt = route.indexOf("service.rpc('begin_order_submission_processing'")
    assert.ok(adminAt > 0 && adminAt < leaseAt)
  })

  test('the version must be pending and name an approved PI linked to its Order', () => {
    assert.ok(route.includes("if (version.status !== 'pending')"))
    assert.ok(route.includes("fail(409, 'ORDER_PI_REVISION_NOT_PENDING'"))
    assert.ok(route.includes('isWorkbookPathFor(workbookPath, submissionId)'))
    assert.ok(route.includes("submission.status !== 'approved' || submission.order_id !== version.order_id"))
  })

  test('it takes the lease, runs the ONE pipeline with the version id, and always releases', () => {
    assert.ok(route.includes("import { processUnderLease } from '@/app/api/orders/import/process-draft/route'"))
    assert.ok(route.includes('revisionVersionId: versionId'))
    assert.ok(route.includes('afterSubmission: true'))
    assert.ok(route.includes('} finally {'))
    assert.ok(route.includes("service.rpc('finish_order_submission_processing'"))
    assert.ok(!route.includes('parseBoePiWorkbook'), 'no second parser')
    assert.ok(!route.includes("rpc('replace_order_submission_parse'"), 'the pipeline decides which RPC')
  })

  test('the pipeline routes a revision through approve_order_pi_revision and a draft through the parser', () => {
    const pipeline = read(PIPELINE)
    assert.ok(pipeline.includes('export async function processUnderLease'))
    assert.ok(pipeline.includes('revisionVersionId?: string | null'))
    assert.ok(pipeline.includes("rpc('approve_order_pi_revision', {"))
    assert.ok(pipeline.includes("rpc('replace_order_submission_parse', {"))
    assert.ok(pipeline.includes('p_version_id: ctx.revisionVersionId'))
  })

  test('no service key exists in any client page, and the Order page hands up only the version id', () => {
    const page = read(ORDER_PAGE)
    assert.ok(!/service_role|SERVICE_ROLE/.test(page))
    assert.ok(page.includes('body: JSON.stringify({ versionId: version.id })'))
    assert.ok(!page.includes("rpc('approve_order_pi_revision'"), 'the service-role door is unreachable from the browser')
  })
})
