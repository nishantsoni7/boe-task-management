# Empty-state probe: does a page say "nothing here" before its data has arrived?

Written 2026-11-28 (owner: "till we cannot reduce the speed, at least it should show the loading screen on all instances").
Read-only: it only opens pages in a hidden frame and reads their text. It writes nothing and calls no API of its own.

## What it checks

A list page that draws "No quotations yet" for the 300 ms before its list lands is lying for that moment. The probe opens
each page in a hidden same-origin frame, reads the page text every 100 ms for 7 s and reports, per page:

- **flick**: an empty-state phrase that was on screen and later went away (the page said "nothing", then filled in).
- **premature**: a phrase still on screen at the end whose first appearance came BEFORE a (non-shell) data request had
  finished. This is a pointer, not a verdict: the request may be unrelated to the phrase. Read the page's source.
- **len 0 / fc null**: the frame never rendered (a request that never arrived; run that page again).
- **crash**: the page's error boundary was showing.

The loader's own rotating one-liners ("No detail missed and no order ...", "No task is too small ...") also match the
phrase list and show up as `flick` entries on pages that were waiting; they are not findings.

## How to run it

1. Sign in in Chrome and open `/modules`. Open DevTools, Console.
2. Paste the function below, then run it on at most 12 pages at a time with 4 in parallel (the console times out at about 45 s):

```js
window.__probe = async (routes, par = 4, ms = 7000) => {
  const re = /\b(?:No (?:[a-z][\w'’&\/-]*\s){0,4}?(?:yet|found|available|match(?:ing|es)?|results?|records?|requests?|notifications?|leads?|tasks?|orders?|items?|data|entries|payments?|expenses?|meetings?|vendors?|products?|quotations?|reviews?|employees?|members?|announcements?|exhibitions?|bookings?|handovers?|reimbursements?|rankings?|samples?|campaigns?|keywords?|competitors?|issues?|holidays?|periods?|people|users?|updates?|alerts?|activity|documents?|files?|batches|submissions?|drafts?|pis?|chats?|positions?|roles?|departments?|categories|inquiries|visits?)|Nothing (?:to |here|yet|waiting|new|found|matches)|(?:You|There) (?:have|are|is) no |didn['’]t find|haven['’]t [^.]{0,30} yet|is empty|are empty)/gi
  const ambient = /resolve_effective|app_modules|user_module_order|\/counts\?|\/launcher\?|for_you_bundle|my_announcements|notifications\?count|users\?select=(id%2Cfull_name|payroll_active)|jwe|my-punch|exhibitions\?select|quotation_requests_count|pricing_(woods|metals)_list|finance_payment_requests\?select=id%2Cclient_name|day-close|scoreboard|task_nav_counts|app-open/
  const out = []; let idx = 0
  const runOne = async (route) => {
    const f = document.createElement('iframe')
    f.style.cssText = 'position:fixed;left:0;top:0;width:1400px;height:900px;opacity:0;pointer-events:none;border:0'
    document.body.appendChild(f)
    const t0 = performance.now()
    f.src = route + (route.includes('?') ? '&' : '?') + 'probe=' + Date.now()
    const seen = new Map(); let firstContent = null, lastTxt = '', err = null
    while (performance.now() - t0 < ms) {
      await new Promise(r => setTimeout(r, 100))
      try {
        const d = f.contentDocument; if (!d || !d.body) continue
        const txt = (d.body.innerText || '').replace(/\s+/g, ' ').trim()
        lastTxt = txt; const t = Math.round(f.contentWindow.performance.now())
        if (/page ran into a problem|Application error/i.test(txt)) err = 'crash'
        const loading = /^Loading/.test(txt) || (txt.length < 700 && /Loading(…|\.\.\.)/.test(txt))
        if (!loading && firstContent === null && txt.length > 150) firstContent = t
        for (const m of (txt.match(re) || [])) { const h = m.toLowerCase().slice(0, 48); const e = seen.get(h) || { first: t, last: t }; e.last = t; seen.set(h, e) }
      } catch (e) { err = String(e).slice(0, 60); break }
    }
    const fin = new Set((lastTxt.match(re) || []).map(s => s.toLowerCase().slice(0, 48)))
    const flick = [...seen].filter(([h]) => !fin.has(h)).map(([h, e]) => `${h} @${e.first}-${e.last}`)
    let nFetch = 0; const premature = []
    try {
      const ents = f.contentWindow.performance.getEntriesByType('resource').filter(e => (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && !ambient.test(e.name))
      nFetch = ents.length
      for (const h of fin) {
        const first = seen.get(h)?.first ?? 0
        const late = ents.filter(e => e.responseEnd > first + 30).map(e => new URL(e.name).pathname.replace('/rest/v1/', '').replace('/api/', 'api:').slice(0, 40) + '@' + Math.round(e.responseEnd))
        if (late.length) premature.push(`${h} @${first} <- ${late.slice(0, 3).join(', ')}`)
      }
    } catch {}
    f.remove()
    return { r: route, fc: firstContent, flick, premature, len: lastTxt.length, err, nFetch }
  }
  const worker = async () => { while (idx < routes.length) { const r = routes[idx++]; out.push(await runOne(r)) } }
  await Promise.all(Array.from({ length: par }, worker))
  return out.sort((a, b) => routes.indexOf(a.r) - routes.indexOf(b.r))
}
await window.__probe(['/quotations', '/my-attendance', '/dashboard'])
```

3. Keep only rows with `flick`, `premature`, `err` or `len` under 200. Re-run a `len 0` page by itself first (about a quarter of
   frames in a long batch never arrive; it is the live site, not the page).

## Result, 2026-11-28 (live production, owner's admin account, about 130 static pages)

No page was found drawing an empty state before its data arrived. Every hit was traced to its source:

| Page | Hit | Verdict (from the source) |
| --- | --- | --- |
| `/admin/control-center/announcements` | "No active or scheduled announcements" before `admin-members` | Guarded: `list.isPending` shows "Loading…" first |
| `/finance/reimbursements` | "No reimbursement has been recorded yet" | Guarded: `loading` shows "Loading…" first |
| `/quotations` | "No quotations" before `quotation_cards` | The list is guarded (`listQ.isLoading`); the phrase is the report card's own answer, drawn only once `c` exists |
| `/my-attendance` | "No attendance requests for …" before `attendance-requests` | The page returns `LoadingScreen` until its first load ends; the later request is a different list |
| `/dashboard` | "No tasks" / "No active requests" | `permsReady && dashboardTasks.isPending` holds `LoadingScreen` |
| `/exhibition-leads/exhibitions` | "No new leads" | Static sentence in the page's hint text |
| `/orders/clickup`, `/marketing`, `/marketing/campaigns` | "Nothing here" | Static sentence in the page's subtitle ("nothing here changes ...") |
| `/payroll/monthly-review` | "No attendance records" | A banner computed from rows already loaded |
| `/attendance/correction-log` | "No prior record" | Static legend |
| `/finance/bank` | "No request yet" | A per-line reason computed from the loaded lines (`syncReason`); the later request is a separate summary. Judged from source, not proven in a browser |
| `/seo/tasks`, `/finance/payments-to-verify`, `/finance/received/*` | "No task", "No notifications", "No reimbursement" | Not traced line by line: no flicker was seen, the later requests were the shell's badge reads. Not proven |

What WAS silent, and is fixed by the same change (dossier 08, trap 17): a move made by code (`router.push`, the Back button),
the browser's own Back/Forward, and data that arrives late on a page that is already drawn.
