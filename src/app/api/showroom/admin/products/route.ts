import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { canAccessModule, type ModuleVisibilityType } from '@/lib/moduleAccess'

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

// GET /api/showroom/admin/products
//   • No `page` param  → every product, including inactive (legacy shape).
//     The Categories page depends on this to count products per category.
//   • With `page`      → server-side search/filter/sort/pagination for Product Master.
export async function GET(req: NextRequest) {
  const client = await requireShowroomAccess(req)
  if (!client) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sp = req.nextUrl.searchParams

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
  const filters: Filters = {
    search:   (sp.get('q') ?? '').trim(),
    category: (sp.get('category') ?? '').trim(),
    status:   rawStatus === 'active' || rawStatus === 'inactive' ? rawStatus : 'all',
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

  // Chip names come from the categories table (the same source the create/edit
  // forms use); each count reflects the active search + status so the chips
  // agree with the list. Category count is small and admin-managed, so one count
  // per category stays cheap.
  const { data: categoryRows } = await client
    .from('showroom_categories')
    .select('name')
    .order('name', { ascending: true })
  const categoryNames = (categoryRows ?? []).map(r => r.name as string)

  const [pageRes, filteredRes, allRes, catalogRes, inactiveRes, ...categoryCounts] = await Promise.all([
    sortedQuery.range(from, to),
    countQuery(filters),
    countQuery({ ...filters, category: '' }),
    client.from('showroom_products').select('id', { count: 'exact', head: true }),
    client.from('showroom_products').select('id', { count: 'exact', head: true }).eq('is_active', false),
    ...categoryNames.map(name => countQuery({ ...filters, category: name })),
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

  return NextResponse.json({
    products:      pageRes.data ?? [],
    total:         filteredRes.count ?? 0,
    page,
    pageSize:      PRODUCTS_PER_PAGE,
    allCount:      allRes.count ?? 0,
    catalogTotal:  catalogRes.count ?? 0,
    inactiveTotal: inactiveRes.count ?? 0,
    categories:    categoryNames.map((name, i) => ({ name, count: categoryCounts[i]?.count ?? 0 })),
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
