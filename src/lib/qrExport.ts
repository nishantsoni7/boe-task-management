/** Final PNG export is normalised to this exact pixel size, independent of screen DPR. */
export const QR_EXPORT_SIZE = 1024
/** Quiet zone in QR modules. The specification minimum of 4 keeps the code reliably scannable. */
export const QR_EXPORT_MARGIN_MODULES = 4

/** Sanitised, lowercase, hyphenated filename. Falls back when no usable name exists. */
export function qrFileNameFor(fullName?: string | null) {
  const slug = (fullName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `boe-showroom-qr-${slug}.png` : 'boe-showroom-qr.png'
}

/**
 * Redraws a rendered QR canvas onto an opaque white square of exactly
 * QR_EXPORT_SIZE and triggers a PNG download. qrcode.react sizes its canvas by
 * devicePixelRatio, so the source is larger than the export on HiDPI screens.
 */
export async function downloadQrCanvasAsPng(source: HTMLCanvasElement, fileName: string) {
  const out = document.createElement('canvas')
  out.width = QR_EXPORT_SIZE
  out.height = QR_EXPORT_SIZE

  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, QR_EXPORT_SIZE, QR_EXPORT_SIZE)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, QR_EXPORT_SIZE, QR_EXPORT_SIZE)

  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG encoding produced no data')

  const objectUrl = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
