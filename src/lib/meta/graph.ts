// A read-only client for Meta's Graph API. It makes GET requests and nothing else: the token it is given is
// view-only, and src/lib/meta/graph.test.ts pins that no other method appears in this file.
//
// The token goes in the Authorization header, never in a URL, and the next page is asked for with the `after`
// cursor, because the `next` link Meta returns has the token written into it.

export const META_GRAPH_VERSION = 'v25.0'
const BASE = 'https://graph.facebook.com'
const MAX_PAGES = 200

export class MetaTokenRejected extends Error {}
export class MetaApiError extends Error {}

type Page = { data: Record<string, unknown>[]; paging?: { next?: string; cursors?: { after?: string } } }

export async function metaGet(
  path: string,
  params: Record<string, string>,
  token: string,
  doFetch: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const url = `${BASE}/${META_GRAPH_VERSION}/${path}?${new URLSearchParams(params).toString()}`
  const res = await doFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null

  if (!res.ok) {
    const error = (body?.error ?? {}) as Record<string, unknown>
    // 190 is Meta's "this token is no good": expired, removed, or the password changed.
    if (res.status === 401 || Number(error.code) === 190) {
      throw new MetaTokenRejected('Meta did not accept the token. It may have expired or been removed.')
    }
    const said = typeof error.message === 'string' ? `: ${error.message.replaceAll(token, '[token]').slice(0, 200)}` : ''
    throw new MetaApiError(`Meta answered ${res.status}${said}`)
  }
  if (!body) throw new MetaApiError('Meta sent an answer this app cannot read.')
  return body
}

/** Every row of a list edge, page by page. */
export async function metaGetAll(
  path: string,
  params: Record<string, string>,
  token: string,
  doFetch: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = (await metaGet(path, after ? { ...params, after } : params, token, doFetch)) as Page
    rows.push(...(Array.isArray(answer.data) ? answer.data : []))
    after = answer.paging?.next ? answer.paging.cursors?.after : undefined
    if (!after) return rows
  }
  throw new MetaApiError('Meta sent more pages than this app will read.')
}
