// The browser's half of "Start from a client file": any file becomes PAGE PICTURES the reader can look at, and the boxes the
// reader returns become cut-out pictures. Runs only in the browser (canvas, pdf.js, DOMParser).
//   PDF          every page rendered on this device with pdf.js (no upload size limit: only page pictures leave the device)
//   photo        one page (JPG, PNG, WebP)
//   PowerPoint   every slide drawn from its pictures and text boxes at their places (no fonts or effects: good enough to
//                read and to cut pictures from; the slide's own text is sent too)
// Pictures are cut by re-drawing the page larger, so a cut-out is sharp even when the reader saw a smaller page. The pages'
// embedded images are NOT used: in the owner's files they were logos on every page, black alpha-mask pieces of vector
// drawings and whole-room photos (studied 15 Nov 2026).

import { cutRect, type Box } from './scanReading'

/** The reader sees at most this: Anthropic's vision input stays undownscaled up to ~1568 px and ~1.15 megapixels. */
const READ_LONG_EDGE = 1568
const READ_MAX_PIXELS = 1_150_000
const SURVEY_LONG_EDGE = 560
const CUT_LONG_EDGE = 3000
const CUT_MIN_PX = 50

export type ScanPage = {
  n: number
  /** "Z40.pdf · page 3" for the review screen. */
  label: string
  /** What the reader sees (JPEG) and its size. */
  jpeg: Blob; width: number; height: number
  /** The page's own text when the file has any (PDF text layer, slide text). */
  text: string
  /** The page drawn large, for cutting pictures. */
  draw: (longEdge: number) => Promise<HTMLCanvasElement>
  /** The page is one photo: a product on it with no box of its own gets the whole photo. */
  photo?: boolean
}

export class ScanFileError extends Error {}

export const SCAN_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.pptx'
export const scanKind = (f: File): 'pdf' | 'photo' | 'pptx' | null => {
  const n = f.name.toLowerCase()
  if (n.endsWith('.pdf') || f.type === 'application/pdf') return 'pdf'
  if (n.endsWith('.pptx')) return 'pptx'
  if (/\.(jpe?g|png|webp)$/.test(n) || /^image\/(jpeg|png|webp)$/.test(f.type)) return 'photo'
  return null
}

const MAX_PAGES = 120

function fit(w: number, h: number, longEdge: number, maxPixels = Infinity) {
  const s = Math.min(longEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)))
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), s }
}

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new ScanFileError('This device could not draw the page.')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h)
  return [c, ctx]
}

const toJpeg = (c: HTMLCanvasElement, q = 0.85) => new Promise<Blob>((ok, bad) => c.toBlob(b => (b ? ok(b) : bad(new ScanFileError('The page could not be saved as a picture.'))), 'image/jpeg', q))

async function scaled(src: HTMLCanvasElement, longEdge: number, maxPixels = Infinity) {
  const { w, h } = fit(src.width, src.height, longEdge, maxPixels)
  const [c, ctx] = canvasOf(w, h)
  ctx.drawImage(src, 0, 0, w, h)
  return c
}

/** Pages to read, from one file. `onPage` reports progress. */
export async function filePages(file: File, startAt: number, onPage: (done: number, total: number) => void): Promise<{ pages: ScanPage[]; close: () => void }> {
  const k = scanKind(file)
  const name = file.name.length > 40 ? `${file.name.slice(0, 37)}…` : file.name
  const make = async (n: number, i: number, total: number, text: string, draw: ScanPage['draw']): Promise<ScanPage> => {
    const big = await draw(READ_LONG_EDGE)
    const read = await scaled(big, READ_LONG_EDGE, READ_MAX_PIXELS)
    const page = { n, label: total > 1 ? `${name} · page ${i}` : name, jpeg: await toJpeg(read), width: read.width, height: read.height, text, draw }
    onPage(i, total)
    return page
  }

  if (k === 'photo') {
    let bmp: ImageBitmap
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch { throw new ScanFileError(`${file.name} could not be opened. Use a JPG or PNG.`) }
    const draw = async (longEdge: number) => {
      const { w, h } = fit(bmp.width, bmp.height, Math.min(longEdge, Math.max(bmp.width, bmp.height)))
      const [c, ctx] = canvasOf(w, h)
      ctx.drawImage(bmp, 0, 0, w, h)
      return c
    }
    return { pages: [{ ...await make(startAt, 1, 1, '', draw), photo: true }], close: () => bmp.close() }
  }

  if (k === 'pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' })
    }
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    let doc: Awaited<typeof task.promise>
    try { doc = await task.promise }
    catch (e) { void task.destroy(); throw new ScanFileError((e as Error)?.name === 'PasswordException' ? `${file.name} is locked with a password. Ask the client for an open copy.` : `${file.name} could not be opened as a PDF.`) }
    const total = Math.min(doc.numPages, MAX_PAGES)
    const pages: ScanPage[] = []
    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const draw = async (longEdge: number) => {
        const vp = page.getViewport({ scale: longEdge / Math.max(base.width, base.height) })
        const [c] = canvasOf(Math.round(vp.width), Math.round(vp.height))
        await page.render({ canvas: c, viewport: vp, background: '#ffffff' }).promise
        return c
      }
      let text = ''
      try {
        const tc = await page.getTextContent()
        text = tc.items.map(it => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+/g, ' ').trim()
      } catch { /* the picture is the page; text is only a hint */ }
      pages.push(await make(startAt + i - 1, i, total, text, draw))
    }
    return { pages, close: () => { void task.destroy() } }
  }

  if (k === 'pptx') return { pages: await slidePages(file, name, startAt, onPage), close: () => {} }
  throw new ScanFileError(`${file.name}: use a PDF, a photo (JPG, PNG, WebP) or a PowerPoint (.pptx). Excel files go through "Import client file".`)
}

// ── PowerPoint ───────────────────────────────────────────────────────────────

const EMU = (v: string | null) => Number(v) || 0

/** Where a shape sits, as fractions of the slide (sw × sh EMU). Read inside a:xfrm only: PowerPoint also writes
 *  <a:extLst><a:ext uri=…> (no size) in the shape's name, before it, which drew every picture of the Brewery deck at zero size. */
// shortcut: positions inside a group shape are taken as they are (no group transform); a grouped picture can land a
// little off. Fine for reading; upgrade when a real deck shows it.
export function slideFrame(el: Element, sw: number, sh: number) {
  const xf = el.getElementsByTagName('a:xfrm')[0]
  const off = xf?.getElementsByTagName('a:off')[0]; const ext = xf?.getElementsByTagName('a:ext')[0]
  return { x: EMU(off?.getAttribute('x') ?? null) / sw, y: EMU(off?.getAttribute('y') ?? null) / sh, w: EMU(ext?.getAttribute('cx') ?? null) / sw, h: EMU(ext?.getAttribute('cy') ?? null) / sh }
}

async function slidePages(file: File, name: string, startAt: number, onPage: (done: number, total: number) => void): Promise<ScanPage[]> {
  const JSZip = (await import('jszip')).default
  let zip: InstanceType<typeof JSZip>
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()) } catch { throw new ScanFileError(`${file.name} could not be opened as a PowerPoint.`) }
  const xml = async (path: string) => { const f = zip.file(path); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null }
  const pres = await xml('ppt/presentation.xml')
  const sz = pres?.getElementsByTagName('p:sldSz')[0]
  const [sw, sh] = [EMU(sz?.getAttribute('cx') ?? null) || 12192000, EMU(sz?.getAttribute('cy') ?? null) || 6858000]
  // shortcut: slides in file-name order (slide1, slide2…), which is the order PowerPoint writes; a deck whose slides were
  // reordered by hand can come out of order. Upgrade: follow p:sldIdLst through presentation.xml.rels.
  const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1])).slice(0, MAX_PAGES)
  const pages: ScanPage[] = []
  for (const [i, path] of slides.entries()) {
    const doc = await xml(path)
    const rels = await xml(path.replace('slides/', 'slides/_rels/') + '.rels')
    if (!doc) continue
    const target = (id: string) => {
      const r = Array.from(rels?.getElementsByTagName('Relationship') ?? []).find(x => x.getAttribute('Id') === id)
      const t = r?.getAttribute('Target') ?? ''
      return t.startsWith('../') ? `ppt/${t.slice(3)}` : t
    }
    const frame = (el: Element) => slideFrame(el, sw, sh)
    const pics: { f: ReturnType<typeof frame>; bmp: ImageBitmap }[] = []
    for (const pic of Array.from(doc.getElementsByTagName('p:pic'))) {
      const id = pic.getElementsByTagName('a:blip')[0]?.getAttribute('r:embed')
      const media = id ? zip.file(target(id)) : null
      if (!media || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(media.name)) continue
      try { pics.push({ f: frame(pic), bmp: await createImageBitmap(await media.async('blob')) }) } catch { /* a picture this device cannot open is left out */ }
    }
    const texts = Array.from(doc.getElementsByTagName('p:sp')).map(sp => ({
      f: frame(sp),
      lines: Array.from(sp.getElementsByTagName('a:p')).map(p => Array.from(p.getElementsByTagName('a:t')).map(t => t.textContent ?? '').join('')).filter(Boolean),
    })).filter(t => t.lines.length)
    const draw = async (longEdge: number) => {
      const { w, h } = fit(sw, sh, longEdge)
      const [c, ctx] = canvasOf(w, h)
      for (const p of pics) ctx.drawImage(p.bmp, p.f.x * w, p.f.y * h, p.f.w * w, p.f.h * h)
      const px = Math.max(10, Math.round(h / 40))
      ctx.fillStyle = '#111'; ctx.font = `${px}px sans-serif`; ctx.textBaseline = 'top'
      for (const t of texts) t.lines.forEach((line, j) => ctx.fillText(line, t.f.x * w, t.f.y * h + j * px * 1.25, Math.max(px * 4, t.f.w * w)))
      return c
    }
    pages.push(await (async () => {
      const big = await draw(READ_LONG_EDGE)
      const page: ScanPage = { n: startAt + i, label: `${name} · slide ${i + 1}`, jpeg: await toJpeg(big), width: big.width, height: big.height, text: texts.map(t => t.lines.join('\n')).join('\n'), draw }
      onPage(i + 1, slides.length)
      return page
    })())
  }
  if (!pages.length) throw new ScanFileError(`${file.name} has no slides to read.`)
  return pages
}

// ── what is sent, and the cut-outs ─────────────────────────────────────────────

export async function base64Of(b: Blob): Promise<string> {
  const url = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(r.error); r.readAsDataURL(b) })
  return url.slice(url.indexOf(',') + 1)
}

/** The small copy of a page the survey sees. */
export async function surveyJpeg(p: ScanPage): Promise<Blob> {
  const bmp = await createImageBitmap(p.jpeg)
  const { w, h } = fit(bmp.width, bmp.height, SURVEY_LONG_EDGE)
  const [c, ctx] = canvasOf(w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return toJpeg(c, 0.75)
}

/** Every box cut from its page, each page drawn large once. A box too small to be a picture, or one that failed, is null. */
export async function cutPictures(pages: readonly ScanPage[], boxes: readonly Box[], onPage?: (done: number, total: number) => void): Promise<(Blob | null)[]> {
  const out: (Blob | null)[] = boxes.map(() => null)
  const byPage = new Map<number, number[]>()
  boxes.forEach((b, i) => byPage.set(b.page, [...(byPage.get(b.page) ?? []), i]))
  let done = 0
  for (const [n, idx] of byPage) {
    const page = pages.find(p => p.n === n)
    if (page) {
      try {
        const big = await page.draw(CUT_LONG_EDGE)
        for (const i of idx) {
          const b = boxes[i]
          const { x, y, w, h } = cutRect(b, big.width, big.height)
          if (w < CUT_MIN_PX || h < CUT_MIN_PX) continue
          const [c, ctx] = canvasOf(Math.round(w), Math.round(h))
          ctx.drawImage(big, x, y, w, h, 0, 0, Math.round(w), Math.round(h))
          out[i] = await toJpeg(c, 0.9)
        }
      } catch { /* a page that will not draw loses its pictures, never the rows */ }
    }
    onPage?.(++done, byPage.size)
  }
  return out
}
