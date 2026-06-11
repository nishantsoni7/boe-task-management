// @ts-check
// Retake only the screenshots that need refreshing after adding more data
const { chromium } = require('C:/Users/Lenovo/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright')
const path = require('path')
const fs   = require('fs')

const BASE_URL = 'http://localhost:3000'
const OUT_DIR  = path.join(__dirname, '..', 'screenshots')
const WIDTH    = 1440
const HEIGHT   = 900

async function capture(page, filename) {
  await page.waitForTimeout(600)
  await page.evaluate(() => {
    const all = document.querySelectorAll('body > *')
    all.forEach(n => {
      const s = window.getComputedStyle(n)
      if (s.position === 'fixed' && parseInt(s.bottom) < 80 && parseInt(s.left) < 80) n.style.display = 'none'
    })
  })
  await page.screenshot({ path: path.join(OUT_DIR, filename) })
  console.log(`  ✓  ${filename}`)
}

async function waitIdle(page, extra = 1500) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(extra)
}

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 })
  const page    = await context.newPage()

  // Log in
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type="email"]',    'boesales8@gmail.com')
  await page.fill('input[type="password"]', 'Prerna@123')
  await page.click('button:has-text("Sign in")')
  await page.waitForURL('**/', { timeout: 15000 })
  await waitIdle(page)

  // Dashboard (now has waiting task count)
  console.log('Dashboard')
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' })
  await waitIdle(page)
  await capture(page, '03-dashboard.png')

  // Assigned By Me (now has 1 task)
  console.log('Assigned By Me')
  await page.goto(`${BASE_URL}/tasks/assigned-by-me`, { waitUntil: 'networkidle' })
  await waitIdle(page)
  await capture(page, '07-assigned-to-me.png')

  await browser.close()
  console.log('Done.')
})()
