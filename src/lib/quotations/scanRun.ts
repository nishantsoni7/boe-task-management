// One scan of a client's file(s), start to end, in the browser: pages → survey → pages read in batches → pictures cut.
// Every step reports progress; a step that fails loses only its own part (a page batch that cannot be read is named in the
// note, the rows of the other pages stay).

import type { createClient } from '@/lib/supabase/client'
import type { ImportRow } from './importBoq'
import { base64Of, cutPictures, filePages, surveyJpeg, ScanFileError, type ScanPage } from './scanPages'
import {
  MAX_SURVEY_PAGES, mergeDuplicates, parseRead, parseSurvey, pictureJobs, readBatches, surveyText, toImportRows,
  type ScanRow, type Survey,
} from './scanReading'

type Supabase = ReturnType<typeof createClient>

export type ScanStage = 'pages' | 'survey' | 'read' | 'pictures'
export type ScanProgress = { stage: ScanStage; done: number; total: number }
/** `pages` keep only their JPEG for the review screen: the file itself is closed once the pictures are cut. */
export type ScanResult = { rows: ImportRow[]; pictures: Blob[]; note: string; pages: ScanPage[]; survey: Survey | null }

const CONCURRENT_BATCHES = 3

class Refused extends Error { constructor(message: string, public status: number, public cut = false) { super(message) } }

async function post(token: string, body: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await fetch('/api/quotations/scan', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` } })
  } catch { throw new Refused('No connection. Check the network and try again.', 0) }
  const json = await res.json().catch(() => null) as { ok: boolean; reading?: unknown; cut?: boolean; error?: string } | null
  if (!json) throw new Refused(res.status === 504 ? 'Reading took too long.' : 'Could not read the file right now. Try again.', res.status)
  if (!json.ok) throw new Refused(json.error ?? 'Could not read the file.', res.status)
  if (json.cut) throw new Refused('The answer was cut short.', 200, true)
  return json.reading
}

const pagesPayload = async (pages: readonly ScanPage[]) => Promise.all(pages.map(async p => ({ n: p.n, jpeg: await base64Of(p.jpeg), text: p.text || undefined })))

export async function scanFiles(supabase: Supabase, files: readonly File[], onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new ScanFileError('Your session ended. Sign in again, then read the file.')
  const token = session.access_token

  // 1. Pages, every file one after the other, numbered across all files.
  const pages: ScanPage[] = []
  const closers: (() => void)[] = []
  const close = () => closers.forEach(c => c())
  try {
    for (const f of files) {
      const got = await filePages(f, pages.length + 1, (d, t) => onProgress({ stage: 'pages', done: pages.length + d, total: Math.max(pages.length + t, 1) }))
      pages.push(...got.pages); closers.push(got.close)
    }
  } catch (e) { close(); throw e }

  // 2. The survey: what kind of document, sections, units, rooms. Without it the pages are still read, only with less context.
  onProgress({ stage: 'survey', done: 0, total: 1 })
  let survey: Survey | null = null
  try {
    // shortcut: a file over 60 pages is surveyed on its first 60; the rest are read without their headings. Upgrade: survey in parts.
    const small = await Promise.all(pages.slice(0, MAX_SURVEY_PAGES).map(async p => ({ n: p.n, jpeg: await base64Of(await surveyJpeg(p)) })))
    survey = parseSurvey(await post(token, { step: 'survey', pages: small }), pages.length)
  } catch (e) {
    if (e instanceof Refused && [401, 403, 429, 503].includes(e.status)) { close(); throw new ScanFileError(e.message) }
  }
  onProgress({ stage: 'survey', done: 1, total: 1 })

  // 3. The pages, in batches, a few at a time. A batch whose answer is cut short or times out is read again page by page.
  const batches = readBatches(pages.length, survey)
  const context = survey ? surveyText(survey) : ''
  const found: { at: number; rows: ScanRow[] }[] = []
  const failed: number[] = []
  let done = 0
  const total = batches.reduce((n, b) => n + b.length, 0)
  const readBatch = async (nums: number[]): Promise<void> => {
    try {
      const raw = await post(token, { step: 'read', pages: await pagesPayload(pages.filter(p => nums.includes(p.n))), survey: context })
      found.push({ at: nums[0], rows: parseRead(raw, nums) })
      done += nums.length
    } catch (e) {
      if (e instanceof Refused && (e.cut || e.status === 504) && nums.length > 1) { for (const n of nums) await readBatch([n]); return }
      if (e instanceof Refused && [401, 403].includes(e.status)) throw new ScanFileError(e.message)
      failed.push(...nums); done += nums.length
    } finally { onProgress({ stage: 'read', done, total }) }
  }
  onProgress({ stage: 'read', done: 0, total })
  try {
    const queue = [...batches]
    await Promise.all(Array.from({ length: Math.min(CONCURRENT_BATCHES, queue.length) }, async () => { for (let b = queue.shift(); b; b = queue.shift()) await readBatch(b) }))
  } catch (e) { close(); throw e }

  // 4. One list in page order, duplicates merged; a product on a photo with no box of its own gets the whole photo.
  const rows = mergeDuplicates(found.sort((a, b) => a.at - b.at).flatMap(f => f.rows))
  for (const r of rows) if (!r.picture && pages.find(p => p.n === r.page)?.photo) r.picture = { page: r.page, x: 0, y: 0, w: 100, h: 100 }

  // 5. The pictures, cut from the pages drawn large.
  const jobs = pictureJobs(rows)
  const blobs = await cutPictures(pages, jobs, (d, t) => onProgress({ stage: 'pictures', done: d, total: t })).finally(close)
  const pictures: Blob[] = []
  const pictureAt = blobs.map(b => (b ? pictures.push(b) - 1 : null))

  const failedNote = failed.length ? ` Page${failed.length > 1 ? 's' : ''} ${failed.sort((a, b) => a - b).join(', ')} could not be read: read the file again, or add those products by hand.` : ''
  const about = survey?.layout ? `${survey.layout} ` : ''
  const note = rows.length
    ? `Read ${pages.length} page${pages.length === 1 ? '' : 's'}. ${about}Check every row against its page, especially the marked cells.${failedNote}`
    : `No products were found in ${pages.length} page${pages.length === 1 ? '' : 's'}.${failedNote}`
  return { rows: toImportRows(rows, survey, pictureAt), pictures, note, pages, survey }
}
