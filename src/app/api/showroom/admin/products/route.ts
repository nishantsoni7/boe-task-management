import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'
import { fetchAllRows, unwrapPagedRows } from '@/lib/supabasePaging'
import { tallyByCategory } from '@/lib/showroom/productCounts'
import {
  LOOKUP_RESULT_LIMIT,
  lookupOrExpression,
  normalizeLookupQuery,
} from '@/lib/showroom/productLookup'

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Any user allowed to see the Showroom QR module (per Control Center visibility)
// may manage products — same source of truth as the module launcher and the
// showroom-admin route guards.
async function requireShowroomAccess(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim()
  if (!token) return null

  const client = serviceClient()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null

  const [{ data: profile }, { data: mod }] = await Promise.all([
    client.from('users').select('role, team').eq('id', user.id).single(),
    client.from('app_modules').select('visibility_type, allowed_department').eq('module_key', 'showroom_qr').single(),
  ])
  if (!profile) return null

  const team = (profile.team as string | null)?.toLowerCase()
  const teamFallback = !!team && (team.includes('sales') || team.includes('showroom'))
  const allowed = profile.role === 'admin' ||
    canAccessModule(mod?.visibility_type as ModuleVisibilityType | undefined, mod?.allowed_department, profile, teamFallback)

  return allowed ? client : null
}

// List view only needs enough to render the table — full specifications/
// dimensions/description are fetched separately on the edit page.
const LIST_COLUMNS = 'id, product_code, name, category, mrp, is_active, image_url, images, created_at'

// Mirrors PRODUCTS_PER_PAGE in components/ui/ProductCatalogControls — a route
// file can only export route handlers, so the value is repeated rather than
// shared. The page also echoes `pageSize` back, so a drift would be visible.
const PRODUCTS_PER_PAGE = 15

// Product codes are unique, so using one as the tiebreaker guarantees a total
// order — without it, rows with equal name/mrp could swap between pages.
const SORT_MAP = {
  code_asc:  { column: 'product_code', ascending: true  },
  code_desc: { column: 'product_code', ascending: false },
  name_asc:  { column: 'name',         ascending: true  },
  name_desc: { column: 'name',         ascending: false },
  mrp_asc:   { column: 'mrp',          ascending: true  },
  mrp_desc:  { column: 'mrp',          ascending: false },
  newest:    { column: 'created_at',   ascending: false },
  oldest:    { column: 'created_at',   ascending: true  },
} as const

type SortKey = keyof typeof SORT_MAP
const DEFAULT_SORT: SortKey = 'code_asc'
const isSortKey = (v: string | null): v is SortKey => !!v && v in SORT_MAP

type StatusFilter = 'all' | 'active' | 'inactive'
type Filters = { search: string; category: string; status: StatusFilter }

// PostgREST splits `or()` on commas and reads parentheses as grouping, so an
// unescaped term like "chair, oak (teak)" would corrupt the filter. Wrapping the
// value in double quotes makes those literal.
//
// The term then passes through two layers, so the escaping has to satisfy both:
// PostgREST first unescapes the quoted value (turning `\x` into `x`), and only
// what survives that reaches Postgres as the LIKE pattern. A `%` or `_` must
// arrive at Postgres as `\%`/`\_` to match literally, which means emitting
// `\\%`/`\\_` here — escaping them just once would leave a bare wildcard and
// make a search for "%" match every row.
function escapeSearchTerm(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\\\\\')
    .replace(/%/g, '\\\\%')
    .replace(/_/g, '\\\\_')
    .replace(/"/g, '\\"')
}

type FilterOp =
  | { kind: 'eq'; column: string; value: string | boolean }
  | { kind: 'or'; expression: string }

// Supabase query builders are single-use, so the filters are described once as
// data and replayed onto each freshly built page/count query. That keeps every
// filter combination identical without threading the builder's generics through
// a shared helper.
function filterOps({ search, category, status }: Filters): FilterOp[] {
  const ops: FilterOp[] = []
  if (category) ops.push({ kind: 'eq', column: 'category', value: category })
  if (status === 'active')   ops.push({ kind: 'eq', column: 'is_active', value: true })
  if (status === 'inactive') ops.push({ kind: 'eq', column: 'is_active', value: false })
  if (search) {
    const s = escapeSearchTerm(search)
    ops.push({ kind: 'or', expression: `name.ilike."%${s}%",product_code.ilike."%${s}%",category.ilike."%${s}%"` })
  }
  return ops
}

// Sidebar counts: the catalog total and one count per active category, under the
// same rule the Product Master list defaults to — active products only, so a
// badge never promises rows the list will not show.
//
// Exactly TWO database round trips, whatever the category count: the category
// names, then one paged read of the products' category column. The obvious
// shape — a head count per category — is an N+1 that grows with the catalogue,
// which is why it is not used here.
async function categoryCounts(client: ReturnType<typeof serviceClient>) {
  // Active categories only, matching GET /api/showroom/admin/categories (which
  // needs ?all=1 to include deactivated ones). A deactivated category must not
  // reappear as a sidebar entry.
  const { data: categoryRows, error } = await client
    .from('showroom_categories')
    .select('name')
    .eq('is_active', true)
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)

  const categoryNames = (categoryRows ?? []).map(r => r.name as string)

  // Paged: PostgREST silently caps a plain read at 1000 rows, which would
  // under-count every badge without any error once the catalogue grows past it.
  const result = await fetchAllRows<{ id: string; category: string | null }>((from, to) =>
    client
      .from('showroom_products')
      .select('id, category')
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to),
  )

  return tallyByCategory(unwrapPagedRows('showroom product counts', result), categoryNames)
}

// Global product lookup: find ONE product by code or name, across every
// category, for the sidebar's jump-to control.
//
// Deliberately narrow. Four explicit columns — never LIST_COLUMNS, never `*` —
// so pricing (`mrp`), activity, imagery and timestamps stay out of a response
// whose only job is to name a product and route to it. No status filter, no
// sort control, no count and no paging: this locates a product, it does not
// browse the catalogue.
async function productLookup(
  client: ReturnType<typeof serviceClient>,
  rawQuery: string | null,
  rawLimit: string | null,
) {
  const q = normalizeLookupQuery(rawQuery)
  // A blank term would match every row. Answer with nothing rather than with
  // the whole catalogue.
  if (!q) return { products: [] }

  // The client's limit is a ceiling to negotiate DOWN, never up: `limit=5000`
  // cannot turn this into a bulk export.
  const asked = Number.parseInt(rawLimit ?? '', 10)
  const limit = Number.isFinite(asked) && asked > 0
    ? Math.min(asked, LOOKUP_RESULT_LIMIT)
    : LOOKUP_RESULT_LIMIT

  const { data, error } = await client
    .from('showroom_products')
    .select('id, product_code, name, category')
    .or(lookupOrExpression(escapeSearchTerm(q)))
    // Inactive products are findable on purpose: "where did BOE-1042 go" is
    // exactly the question asked about a product that was deactivated.
    .order('product_code', { ascending: true })
    .limit(limit)

  if (error) throw new Error(error.message)
  return { products: data ?? [] }
}

// GET /api/showroom/admin/products
//   • `lookup=1&q=…`   → up to 8 code/name matches across every category.
//   • `counts=1`       → sidebar badges only: catalog total + per-category counts.
//   • No `page` param  → every product, including inactive (legacy shape).
//     The Categories page depends on this to count products per category.
//   • With `page`      → server-side search/filter/sort/pagination for Product Master.
export async function GET(req: NextRequest) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sp = req.nextUrl.searchParams

  if (sp.get('lookup') === '1') {
    try {
      return NextResponse.json(await productLookup(client, sp.get('q'), sp.get('limit')))
    } catch (err) {
      console.error('[showroom-product-lookup]', err)
      return NextResponse.json({ error: 'Product lookup failed' }, { status: 500 })
    }
  }

  if (sp.get('counts') === '1') {
    try {
      return NextResponse.json(await categoryCounts(client))
    } catch (err) {
      // The underlying message can carry schema detail; log it and hand the
      // client something it can show.
      console.error('[showroom-product-counts]', err)
      return NextResponse.json({ error: 'Failed to load product counts' }, { status: 500 })
    }
  }

  if (!sp.has('page')) {
    const { data, error } = await client
      .from('showroom_products')
      .select(LIST_COLUMNS)
      .order('product_code', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ products: data ?? [] })
  }

  const page    = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)
  const sortKey = isSortKey(sp.get('sort')) ? (sp.get('sort') as SortKey) : DEFAULT_SORT
  const sort    = SORT_MAP[sortKey]
  const rawStatus = sp.get('status')
  // Product Master defaults to Active — no/invalid `status` means Active, not
  // All. Only an explicit `status=all` shows both; `status=inactive` shows only
  // inactive. The legacy no-`page` branch above (used by the Categories page)
  // never reaches this and is unaffected.
  const filters: Filters = {
    search:   (sp.get('q') ?? '').trim(),
    category: (sp.get('category') ?? '').trim(),
    status:   rawStatus === 'all' ? 'all' : rawStatus === 'inactive' ? 'inactive' : 'active',
  }

  const from = (page - 1) * PRODUCTS_PER_PAGE
  const to   = from + PRODUCTS_PER_PAGE - 1

  const ops = filterOps(filters)

  let pageQuery = client.from('showroom_products').select(LIST_COLUMNS, { count: 'exact' })
  for (const op of ops) {
    pageQuery = op.kind === 'eq' ? pageQuery.eq(op.column, op.value) : pageQuery.or(op.expression)
  }

  let sortedQuery = pageQuery.order(sort.column, { ascending: sort.ascending })
  if (sort.column !== 'product_code') sortedQuery = sortedQuery.order('product_code', { ascending: true })

  const countQuery = (f: Filters) => {
    let query = client.from('showroom_products').select('id', { count: 'exact', head: true })
    for (const op of filterOps(f)) {
      query = op.kind === 'eq' ? query.eq(op.column, op.value) : query.or(op.expression)
    }
    return query
  }

  // The catalog-wide active/inactive split depends on nothing the controls can
  // change — not the category, the search, the sort or the page. It only moves
  // when a product is created, deleted or toggled, so the client asks for it on
  // the first load and again after a mutation; `meta=0` means "keep what I
  // already have, skip these counts."
  //
  // Per-category counts are NOT here: they belong to the sidebar, which is
  // mounted on every showroom-admin page, and are served by the `counts=1`
  // branch above.
  const skipMeta = sp.get('meta') === '0'

  const loadMeta = async () => {
    const [catalogRes, inactiveRes] = await Promise.all([
      client.from('showroom_products').select('id', { count: 'exact', head: true }),
      client.from('showroom_products').select('id', { count: 'exact', head: true }).eq('is_active', false),
    ])

    return {
      catalogTotal:  catalogRes.count ?? 0,
      inactiveTotal: inactiveRes.count ?? 0,
    }
  }

  const [pageRes, meta] = await Promise.all([
    sortedQuery.range(from, to),
    skipMeta ? Promise.resolve(null) : loadMeta(),
  ])

  // Asking for a page past the end (a stale `?page=` after deleting rows, or a
  // hand-edited URL) makes PostgREST reject the range outright. That's an empty
  // page, not a failure — returning the real total alongside no rows lets the
  // client bounce back to the last valid page instead of losing its place.
  const rangeUnsatisfiable = pageRes.error?.code === 'PGRST103' ||
    /range not satisfiable/i.test(pageRes.error?.message ?? '')

  if (pageRes.error && !rangeUnsatisfiable) {
    return NextResponse.json({ error: pageRes.error.message }, { status: 500 })
  }

  // `count: 'exact'` on the page query already returns the total matching the
  // filters (not just this page's rows), so a second count query for the same
  // filters would be redundant — except in the unsatisfiable-range case above,
  // where PostgREST's error response carries no count and a dedicated query is
  // the only way to recover the real total.
  const total = rangeUnsatisfiable ? (await countQuery(filters)).count ?? 0 : pageRes.count ?? 0

  return NextResponse.json({
    products: pageRes.data ?? [],
    total,
    page,
    pageSize: PRODUCTS_PER_PAGE,
    // Nested rather than spread so the client can tell "recomputed" from
    // "skipped" without inspecting individual fields.
    ...(meta ? { meta } : {}),
  })
}

// POST /api/showroom/admin/products — create product
export async function POST(req: NextRequest) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { product_code, name, category, description, specifications, image_url, images, dimensions, mrp } = body

  if (!product_code?.trim() || !name?.trim() || !category?.trim() || mrp == null) {
    return NextResponse.json({ error: 'product_code, name, category and mrp are required' }, { status: 400 })
  }

  // Parse specifications: accept string (JSON) or object
  let specs = null
  if (specifications) {
    if (typeof specifications === 'string' && specifications.trim()) {
      try { specs = JSON.parse(specifications) } catch {
        return NextResponse.json({ error: 'specifications must be valid JSON' }, { status: 400 })
      }
    } else if (typeof specifications === 'object') {
      specs = specifications
    }
  }

  // Normalise images: filter empty strings, dedupe
  const imagesArr: string[] = Array.isArray(images)
    ? images.map((u: string) => u.trim()).filter(Boolean)
    : image_url?.trim() ? [image_url.trim()] : []

  // Primary image_url stays in sync with first image for backward compat
  const primaryUrl = imagesArr[0] ?? image_url?.trim() ?? null

  const { data, error } = await client
    .from('showroom_products')
    .insert({
      product_code: product_code.trim().toUpperCase(),
      name: name.trim(),
      category: category.trim(),
      description: description?.trim() || null,
      specifications: specs,
      image_url: primaryUrl,
      images: imagesArr,
      dimensions: dimensions ?? null,
      mrp: parseFloat(mrp),
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'This product code already exists. Please use a different code.' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ product: data }, { status: 201 })
}
