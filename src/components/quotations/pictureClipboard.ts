// COPY AND PASTE A PRODUCT'S PICTURE WITH THE KEYBOARD (owner, 18 Nov 2026: "There should be an option to copy and paste
// the images from one product to another (if required) by simply using standard copy and paste on keyboard").
//
// Point at a product's picture and press Ctrl+C (Cmd+C): its picture is copied. Point at another product's picture area and
// press Ctrl+V (Cmd+V): the copied picture becomes its picture. A picture copied from anywhere else (a screenshot, a picture
// in a browser) is pasted the same way and uploaded. While the cursor is in a text field, copy and paste are left alone.
//
// The copy is the picture's storage path behind a marker, as text on the clipboard: the same file is used again, nothing is
// uploaded twice, and the link still opens only for whoever may open the quotation's pictures.

export const PICTURE_MARK = 'boe-quote-picture:'

export type PictureTarget = {
  path: string | null
  editable: boolean
  set: (path: string) => void
  upload: (file: File) => void
  flash: (text: string) => void
}

let hovered: PictureTarget | null = null
let installed = false

/** A storage path the paste may take: letters, digits and / . _ - only, never ".." and never absolute. */
export const validPicturePath = (p: string) => p.length > 0 && p.length < 400 && /^[\w./-]+$/.test(p) && !p.includes('..') && !p.startsWith('/')

function typing(): boolean {
  const a = document.activeElement as HTMLElement | null
  return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))
}

export function onCopy(e: ClipboardEvent): void {
  const t = hovered
  if (!t?.path || typing() || (window.getSelection()?.toString() ?? '') !== '') return
  e.clipboardData?.setData('text/plain', PICTURE_MARK + t.path)
  e.preventDefault()
  t.flash('Picture copied. Point at another product and press Ctrl+V.')
}

export function onPaste(e: ClipboardEvent): void {
  const t = hovered
  if (!t?.editable || typing()) return
  const file = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'))
  if (file) { e.preventDefault(); t.upload(file); t.flash('Picture pasted.'); return }
  const text = (e.clipboardData?.getData('text/plain') ?? '').trim()
  if (!text.startsWith(PICTURE_MARK)) return
  const path = text.slice(PICTURE_MARK.length)
  if (!validPicturePath(path)) return
  e.preventDefault()
  t.set(path)
  t.flash('Picture pasted.')
}

/** The picture area the pointer (or keyboard focus) is on; null when it leaves. Installs the two listeners once. */
export function pointAtPicture(t: PictureTarget | null): void {
  hovered = t
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('copy', onCopy)
  document.addEventListener('paste', onPaste)
}

/** Forget a target that is going away (its product was removed), if it is the one pointed at. */
export function forgetPicture(t: PictureTarget): void {
  if (hovered === t) hovered = null
}
