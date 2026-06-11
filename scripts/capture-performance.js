// @ts-check
// Seeds demo data, captures the performance page, then cleans up.
const { chromium }    = require('C:/Users/Lenovo/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright')
const { createClient } = require('@supabase/supabase-js')
const path            = require('path')
const fs              = require('fs')

const BASE_URL   = 'http://localhost:3000'
const OUT_DIR    = path.join(__dirname, '..', 'screenshots')
const WIDTH      = 1440
const HEIGHT     = 900

const SUPABASE_URL      = 'https://albnsrohngkljfsrrrhf.supabase.co'
const SERVICE_ROLE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFsYm5zcm9obmdrbGpmc3JycmhmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTI4MDk2MywiZXhwIjoyMDk0ODU2OTYzfQ.pNOzEyuqTAYaCRd1Fa1TMdJFW8YVgfNrq07PHq3GGMA'
const PRERNA_ID         = '9322e802-7203-456d-8986-ca625f3a8b77'

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Sample EOD content ──────────────────────────────────────────────────────
const EOD_SUMMARY   = 'Submitted revised quotation to Hotel XYZ\nFollowed up with vendor for material confirmation\nUpdated task statuses and acknowledged all pending items'
const EOD_HIGHLIGHTS = 'Received client approval for fabric selection for the summer collection order'
const EOD_BLOCKERS   = 'Waiting for final layout confirmation from client — Need production timeline confirmation from the factory'

;(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // ── 1. Seed completed tasks so Output / Momentum scores are non-zero ──────
  console.log('Seeding demo performance data…')
  const now       = new Date().toISOString()
  const today     = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  // Insert completed tasks (today's completions for Output score)
  const { data: tasks, error: taskErr } = await sb.from('tasks').insert([
    {
      title: 'Follow up with Hotel XYZ on revised quotation',
      note:  'Prepare and send the updated pricing sheet with revised GSM rates.',
      status: 'completed',
      priority: 'high',
      type: 'completion',
      is_urgent: false,
      due_date: today,
      assigned_to: PRERNA_ID,
      created_by:  PRERNA_ID,
      team: 'sales',
      acknowledged_at: now,
      completed_at: now,
      last_update_at: now,
    },
    {
      title: 'Vendor material confirmation for summer collection',
      note:  'Call vendor and confirm raw material availability and delivery timeline.',
      status: 'completed',
      priority: 'high',
      type: 'completion',
      is_urgent: false,
      due_date: today,
      assigned_to: PRERNA_ID,
      created_by:  PRERNA_ID,
      team: 'sales',
      acknowledged_at: now,
      completed_at: now,
      last_update_at: now,
    },
    {
      title: 'Client fabric selection approval — summer line',
      note:  'Share swatches and get written confirmation for the final shade selection.',
      status: 'completed',
      priority: 'medium',
      type: 'completion',
      is_urgent: false,
      due_date: today,
      assigned_to: PRERNA_ID,
      created_by:  PRERNA_ID,
      team: 'sales',
      acknowledged_at: now,
      completed_at: now,
      last_update_at: now,
    },
    // One working task (adds Momentum score from status updates)
    {
      title: 'Confirm production timeline with factory for Order #BOE-2851',
      note:  'Get final dates from production team before sending to client.',
      status: 'working',
      priority: 'high',
      type: 'completion',
      is_urgent: true,
      due_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      assigned_to: PRERNA_ID,
      created_by:  PRERNA_ID,
      team: 'sales',
      acknowledged_at: now,
      last_update_at: now,
    },
    // One task from yesterday (shows up in 7-day trend)
    {
      title: 'Prepare shipment documents for Batch #2847',
      note:  'Packing list, invoice, and GST certificate.',
      status: 'completed',
      priority: 'medium',
      type: 'completion',
      is_urgent: false,
      due_date: yesterday,
      assigned_to: PRERNA_ID,
      created_by:  PRERNA_ID,
      team: 'sales',
      acknowledged_at: new Date(Date.now() - 86400000).toISOString(),
      completed_at: new Date(Date.now() - 86400000).toISOString(),
      last_update_at: new Date(Date.now() - 86400000).toISOString(),
    },
  ]).select('id')

  if (taskErr) {
    console.error('Task seed failed:', taskErr.message)
    process.exit(1)
  }
  const seedIds = tasks.map(t => t.id)
  console.log(`Seeded ${seedIds.length} tasks:`, seedIds)

  // ── 2. Launch browser ──────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()

  // Log in
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]',    'boesales8@gmail.com')
  await page.fill('input[type="password"]', 'Prerna@123')
  await page.click('button:has-text("Sign in")')
  await page.waitForURL('**/', { timeout: 15000 })

  // ── 3. Navigate to Performance page ───────────────────────────────────────
  console.log('Opening Performance page…')
  await page.goto(`${BASE_URL}/performance`, { waitUntil: 'networkidle' })

  // Wait for the progress loader to finish (it hides once data is loaded)
  // The loader is a fixed overlay; wait for it to disappear
  await page.waitForFunction(() => {
    const fixed = [...document.querySelectorAll('div')].find(el => {
      const s = window.getComputedStyle(el)
      return s.position === 'fixed' && el.textContent?.includes('Good things take a little time')
    })
    return !fixed
  }, { timeout: 30000 })

  await page.waitForTimeout(1200) // let charts/bars animate

  // ── 4. Fill in the EOD Log form with sample content ───────────────────────
  console.log('Filling EOD form…')

  // Summary textarea (required field)
  const summaryTA = page.locator('textarea').first()
  if (await summaryTA.count()) {
    await summaryTA.click()
    await summaryTA.fill(EOD_SUMMARY)
  }

  // Highlights input
  const inputs = page.locator('input[placeholder*="achievement"], input[placeholder*="milestone"], input[placeholder*="win"]')
  if (await inputs.count()) {
    await inputs.first().fill(EOD_HIGHLIGHTS)
  } else {
    // Fallback: second visible input in the EOD section
    const allInputs = page.locator('input[type="text"], input:not([type])').filter({ hasNot: page.locator('[type="email"],[type="password"]') })
    const cnt = await allInputs.count()
    if (cnt >= 1) await allInputs.nth(0).fill(EOD_HIGHLIGHTS)
  }

  // Blockers input
  const blockersInput = page.locator('input[placeholder*="block"], input[placeholder*="tomorrow"], input[placeholder*="pending"]')
  if (await blockersInput.count()) {
    await blockersInput.first().fill(EOD_BLOCKERS)
  } else {
    const allInputs = page.locator('input[type="text"], input:not([type])').filter({ hasNot: page.locator('[type="email"],[type="password"]') })
    const cnt = await allInputs.count()
    if (cnt >= 2) await allInputs.nth(1).fill(EOD_BLOCKERS)
  }

  // Star rating — click 4 stars
  const starBtns = page.locator('button').filter({ hasText: '★' })
  const starCount = await starBtns.count()
  if (starCount >= 4) {
    await starBtns.nth(3).click() // 4th star (index 3)
  }

  await page.waitForTimeout(400)

  // ── 5. Hide dev overlay, take full-page screenshot ─────────────────────────
  await page.evaluate(() => {
    document.querySelectorAll('body > *').forEach(n => {
      const s = window.getComputedStyle(n)
      if (s.position === 'fixed' && parseInt(s.bottom) < 80 && parseInt(s.left) < 80) {
        n.style.display = 'none'
      }
    })
  })

  const filepath = path.join(OUT_DIR, '09-performance.png')
  await page.screenshot({ path: filepath, fullPage: true })
  console.log('✓  09-performance.png')

  await browser.close()

  // ── 6. Cleanup demo tasks ──────────────────────────────────────────────────
  console.log('Cleaning up demo tasks…')
  const { error: delErr } = await sb.from('tasks').delete().in('id', seedIds)
  if (delErr) console.error('Cleanup error:', delErr.message)
  else console.log(`Removed ${seedIds.length} demo tasks.`)

  // ── 7. Report ──────────────────────────────────────────────────────────────
  const { default: sharp } = await import('sharp')
  const meta = await sharp(filepath).metadata()
  const kb   = (fs.statSync(filepath).size / 1024).toFixed(0)
  console.log(`\n── Report ──────────────────────────────────`)
  console.log(`  File:       09-performance.png`)
  console.log(`  Dimensions: ${meta.width}x${meta.height} px`)
  console.log(`  Size:       ${kb} KB`)
  console.log(`  Saved to:   ${OUT_DIR}`)
})()
