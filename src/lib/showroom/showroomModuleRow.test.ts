import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The Showroom QR frame and the page inside it each read the showroom_qr visibility row
// (2026-11-12, "check other modules for duplicate requests"). They share one cached read now.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(dir, name)
    if (statSync(join(ROOT, p)).isDirectory()) pages(p, out)
    else if (name === 'page.tsx') out.push(p)
  }
  return out
}

describe('the showroom_qr visibility row is read once per page load', () => {
  it('the frame reads it through the shared query, not on its own', () => {
    const layout = read('src/components/layout/ShowroomAdminLayout.tsx')
    assert.match(layout, /useQuery\(showroomModuleQuery\(supabase\)\)/)
    assert.equal(layout.includes("from('app_modules')"), false)
  })

  it('every Showroom QR page reads it through the same shared query', () => {
    const found = pages('src/app/showroom-admin').filter(p => read(p).includes('showroom_qr'))
    assert.ok(found.length >= 7, `expected the seven Showroom QR pages, found ${found.length}`)
    for (const p of found) {
      const src = read(p)
      assert.equal(src.includes("from('app_modules')"), false, `${p} reads app_modules itself`)
      assert.ok(src.includes('showroomModuleQuery(supabase)'), `${p} does not use the shared read`)
    }
  })
})
