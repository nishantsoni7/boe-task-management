// Deleting a quotation request from the Dashboard card (owner, 20 Nov 2026): what the helper sends and what it says back.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deleteRequestTask } from './deleteRequest'

const answer = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('deleteRequestTask', () => {
  test('posts the one task id with the administrator\'s token to the existing admin route, and answers null when it is gone', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const send = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response('{"success":true,"deleted":1}', { status: 200 }) }) as unknown as typeof fetch
    assert.equal(await deleteRequestTask('t-1', 'tok', send), null)
    assert.equal(seen!.url, '/api/admin-delete-tasks')
    assert.equal(seen!.init.method, 'POST')
    assert.deepEqual(JSON.parse(String(seen!.init.body)), { taskIds: ['t-1'] })
    assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer tok')
  })
  test('says so when signed out, when not an administrator, when the server refuses, and when there is no connection', async () => {
    assert.match(String(await deleteRequestTask('t-1', undefined, answer(200))), /signed out/)
    assert.match(String(await deleteRequestTask('t-1', 'tok', answer(403, { error: 'Forbidden' }))), /Only an administrator/)
    assert.match(String(await deleteRequestTask('t-1', 'tok', answer(401))), /Only an administrator/)
    assert.match(String(await deleteRequestTask('t-1', 'tok', answer(500, { error: 'violates foreign key constraint' }))), /not deleted: violates foreign key constraint/)
    assert.match(String(await deleteRequestTask('t-1', 'tok', answer(500, null))), /not deleted\.$/)
    const offline = (async () => { throw new Error('Failed to fetch') }) as unknown as typeof fetch
    assert.match(String(await deleteRequestTask('t-1', 'tok', offline)), /No connection/)
  })
})

describe('the Dashboard wiring', () => {
  const page = readFileSync('src/app/dashboard/page.tsx', 'utf8').replace(/\r/g, '')
  test('only the real signed-in administrator gets the bin (not under View As), and a delete refreshes the task lists', () => {
    assert.match(page, /const canDeleteRequests = profile\?\.role === 'admin' && !viewAsUserId/)
    assert.match(page, /onDelete=\{canDeleteRequests \? setRequestToDelete : undefined\}/)
    assert.match(page, /queryClient\.invalidateQueries\(\{ queryKey: \['tasks'\] \}\)/)
  })
})
