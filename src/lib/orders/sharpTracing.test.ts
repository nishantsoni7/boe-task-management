// Every API route that reaches sharp must ship sharp's native library.
//
// Next's file tracer follows require/import but cannot see the ELF dependency
// from @img/sharp-linux-x64's binding to libvips-cpp.so, so a route that loads
// sharp is only deployable if next.config.ts names it in
// outputFileTracingIncludes (see the comment there). The PI version PDF route
// (#209) was missed and failed in production on 2026-09-26 with
// ERR_DLOPEN_FAILED; this keeps the next such route from being missed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = process.cwd()
const config = readFileSync(join(root, 'next.config.ts'), 'utf8')

// Modules that load sharp, directly or through the PDF renderers.
const SHARP_REACHING = [/from 'sharp'/, /confirmedPdfRender/, /customerReviews\/imageProcessing/, /imageEditor\/(imageFormats|generatedProduct)/]

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return routes(p)
    return name === 'route.ts' ? [p] : []
  })
}

// PRE-EXISTING, OUTSIDE THE ORDERS RELEASE: the Customer Reviews image routes
// reach sharp through customerReviews/imageProcessing and are not traced either.
// Listed so this test guards every OTHER route today; fixing them (one line
// each in next.config.ts) is tracked separately, and each must then leave here.
const KNOWN_UNTRACED = new Set([
  '/api/customer-reviews/custom-submissions',
  '/api/customer-reviews/image-groups',
  '/api/customer-reviews/images',
  '/api/customer-reviews/photos',
])

test('every API route that reaches sharp is named in outputFileTracingIncludes', () => {
  const missing: string[] = []
  for (const file of routes(join(root, 'src', 'app', 'api'))) {
    const src = readFileSync(file, 'utf8')
    if (!SHARP_REACHING.some(re => re.test(src))) continue
    const route = '/' + relative(join(root, 'src', 'app'), file).split(sep).slice(0, -1).join('/')
    const key = route.replace(/\[/g, '\\\\[').replace(/\]/g, '\\\\]')
    if (!config.includes(`'${key}'`) && !KNOWN_UNTRACED.has(route)) missing.push(route)
  }
  assert.deepEqual(missing, [], 'these routes load sharp but would ship without libvips')
})

test('the PI version PDF route (#209) is traced', () => {
  assert.ok(config.includes(`'/api/orders/\\\\[id\\\\]/pi-versions/\\\\[versionId\\\\]/pdf'`))
})
