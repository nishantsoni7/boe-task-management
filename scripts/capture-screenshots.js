// @ts-check
const { chromium } = require('C:/Users/Lenovo/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright')
const path = require('path')
const fs   = require('fs')

const BASE_URL = 'http://localhost:3000'
const OUT_DIR  = path.join(__dirname, '..', 'screenshots')
const WIDTH    = 1440
const HEIGHT   = 900

// Read seeded task IDs
const ids = JSON.parse(fs.readFileSync(path.join(__dirname, '.demo-task-ids.json'), 'utf8'))
const DETAIL_TASK_ID = ids[0]

async function capture(page, filename, opts = {}) {
  const { fullPage = false, clip } = opts
  await page.waitForTimeout(600)
  // Hide the Next.js dev tools button
  await page.evaluate(() => {
    const el = document.querySelector('nextjs-portal') || document.querySelector('[data-nextjs-dialog-overlay]')
    if (el) el.style.display = 'none'
    // Also hide any fixed bottom-left dev badge
    const all = document.querySelectorAll('body > *')
    all.forEach(n => {
      const s = window.getComputedStyle(n)
      if (s.position === 'fixed' && parseInt(s.bottom) < 80 && parseInt(s.left) < 80) {
        n.style.display = 'none'
      }
    })
  })
  const filepath = path.join(OUT_DIR, filename)
  await page.screenshot({ path: filepath, fullPage, clip })
  console.log(`  ✓  ${filename}`)
  return filepath
}

async function waitIdle(page, extra = 1200) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(extra)
}

;(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()

  // ── 1. Login page ──────────────────────────────────────────────────────────
  console.log('\n[1/8] Login page')
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' })
  await page.waitForSelector('input[type="email"]')
  // Crop to just the centered content — remove the large empty chrome
  await capture(page, '01-login.png', {
    clip: { x: 0, y: 0, width: WIDTH * 2, height: HEIGHT * 2 },
  })

  // ── Log in ──────────────────────────────────────────────────────────────────
  await page.fill('input[type="email"]',    'boesales8@gmail.com')
  await page.fill('input[type="password"]', 'Prerna@123')
  await page.click('button:has-text("Sign in")')
  await page.waitForURL('**/', { timeout: 15000 })
  await waitIdle(page)

  // ── 2. Module selection page ───────────────────────────────────────────────
  console.log('[2/8] Module selection page')
  await page.waitForSelector('text=Task Management')
  await capture(page, '02-module-selection.png')

  // ── 3. Dashboard page ──────────────────────────────────────────────────────
  console.log('[3/8] Dashboard page')
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' })
  await waitIdle(page, 1500)
  await capture(page, '03-dashboard.png')

  // ── 4. Create Task page ────────────────────────────────────────────────────
  console.log('[4/8] Create Task page')
  await page.goto(`${BASE_URL}/tasks/create`, { waitUntil: 'networkidle' })
  await waitIdle(page, 800)
  // Fill realistic sample data
  try {
    // Title
    const titleInput = page.locator('input').filter({ hasText: '' }).first()
    const allInputs = page.locator('input[type="text"], input:not([type="email"]):not([type="password"]):not([type="date"]):not([type="checkbox"])')
    const firstText = allInputs.first()
    if (await firstText.count()) await firstText.fill('Follow up with Al-Noor Textiles on fabric approval')
    // Note / description textarea
    const textarea = page.locator('textarea').first()
    if (await textarea.count()) await textarea.fill('Client needs final confirmation on fabric shade before production. Call Mr. Hamid and share the updated swatch images from the sample folder.')
    // Due date
    const dateInput = page.locator('input[type="date"]').first()
    if (await dateInput.count()) await dateInput.fill('2026-06-12')
    // Priority — click High
    const highBtn = page.locator('button, div').filter({ hasText: /^High$/ }).first()
    if (await highBtn.count()) await highBtn.click()
  } catch (_) {}
  await page.waitForTimeout(400)
  await capture(page, '04-create-task.png')

  // ── 5. Task Detail page (open a real task in a slide-over panel) ───────────
  console.log('[5/8] Task Detail page')
  await page.goto(`${BASE_URL}/tasks/my`, { waitUntil: 'networkidle' })
  await waitIdle(page, 1500)
  // Click the first task card to open the detail panel
  try {
    // The task list renders cards — click the first one
    const card = page.locator('[class*="task"], [data-task-id]').first()
    if (await card.count()) {
      await card.click()
      await page.waitForTimeout(800)
    } else {
      // Fallback: click anything that looks like a task row
      const row = page.getByText('Al-Noor Textiles').first()
      if (await row.count()) await row.click()
    }
  } catch (_) {}
  await page.waitForTimeout(600)
  await capture(page, '05-task-detail.png')

  // ── 6. My Tasks page (panel closed) ───────────────────────────────────────
  console.log('[6/8] My Tasks page')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  // Reload to ensure clean state
  await page.goto(`${BASE_URL}/tasks/my`, { waitUntil: 'networkidle' })
  await waitIdle(page, 1500)
  await capture(page, '06-my-tasks.png')

  // ── 7. Assigned To Me page ─────────────────────────────────────────────────
  console.log('[7/8] Assigned To Me page')
  await page.goto(`${BASE_URL}/tasks/assigned-to-me`, { waitUntil: 'networkidle' })
  await waitIdle(page, 1500)
  await capture(page, '07-assigned-to-me.png')

  // ── 8. Quick Start Guide page ──────────────────────────────────────────────
  console.log('[8/8] Quick Start Guide page')
  await page.goto(`${BASE_URL}/quick-start-guide`, { waitUntil: 'networkidle' })
  await waitIdle(page, 600)
  await capture(page, '08-quick-start-guide.png')

  await browser.close()

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('\n── Screenshot report ──────────────────────────────────')
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png')).sort()
  for (const f of files) {
    const stat = fs.statSync(path.join(OUT_DIR, f))
    console.log(`  ${f}  (${(stat.size / 1024).toFixed(0)} KB)`)
  }
  console.log(`\nAll screenshots saved to: ${OUT_DIR}`)
})()
