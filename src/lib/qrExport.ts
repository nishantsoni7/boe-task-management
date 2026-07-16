/** Final image exports are normalised to this exact pixel size, independent of screen DPR. */
export const QR_EXPORT_SIZE = 1024
/** Quiet zone in QR modules. The specification minimum of 4 keeps the code reliably scannable. */
export const QR_EXPORT_MARGIN_MODULES = 4
/** Side of the QR square drawn inside a plain export, centred in QR_EXPORT_SIZE. */
export const QR_PLAIN_CODE_SIZE = 896

/** Outer margin left on every side of a plain export: (1024 - 896) / 2. */
const QR_PLAIN_OFFSET = (QR_EXPORT_SIZE - QR_PLAIN_CODE_SIZE) / 2

const slugify = (value?: string | null) =>
  (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Sanitised, lowercase, hyphenated filename. Falls back when no usable name exists. */
export function qrFileNameFor(fullName?: string | null) {
  const slug = slugify(fullName)
  return slug ? `boe-showroom-qr-${slug}.png` : 'boe-showroom-qr.png'
}

export type QrImageFormat = 'png' | 'jpg'

/** Product export filename, e.g. boe-showroom-product-boe-sr-002.jpg */
export function productQrFileNameFor(productCode: string | null | undefined, format: QrImageFormat) {
  const slug = slugify(productCode)
  return slug ? `boe-showroom-product-${slug}.${format}` : `boe-showroom-product.${format}`
}

const MIME_TYPES: Record<QrImageFormat, string> = { png: 'image/png', jpg: 'image/jpeg' }
const JPEG_QUALITY = 0.95

async function triggerDownload(
  canvas: HTMLCanvasElement,
  fileName: string,
  mimeType: string,
  quality?: number,
) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mimeType, quality))
  if (!blob) throw new Error(`${mimeType} encoding produced no data`)

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

/**
 * Downloads the bare QR square — no heading, text or border — centred on an
 * exact QR_EXPORT_SIZE canvas with a QR_PLAIN_OFFSET margin on every side.
 *
 * JPG is flattened onto opaque white. PNG keeps a fully transparent background
 * and margin, which only holds if `source` was rendered with a transparent
 * bgColor: drawing a white-backed QR here would paint a white square.
 * Smoothing stays off so module edges remain hard rather than photo-soft.
 */
export async function downloadPlainQrImage(
  source: HTMLCanvasElement,
  fileName: string,
  format: QrImageFormat,
) {
  const out = document.createElement('canvas')
  out.width = QR_EXPORT_SIZE
  out.height = QR_EXPORT_SIZE

  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  if (format === 'jpg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, QR_EXPORT_SIZE, QR_EXPORT_SIZE)
  } else {
    ctx.clearRect(0, 0, QR_EXPORT_SIZE, QR_EXPORT_SIZE)
  }

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(source, QR_PLAIN_OFFSET, QR_PLAIN_OFFSET, QR_PLAIN_CODE_SIZE, QR_PLAIN_CODE_SIZE)

  await triggerDownload(
    out,
    fileName,
    MIME_TYPES[format],
    format === 'jpg' ? JPEG_QUALITY : undefined,
  )
}

/**
 * Redraws a rendered QR canvas onto an opaque white square of exactly
 * QR_EXPORT_SIZE and triggers a PNG download. qrcode.react sizes its canvas by
 * devicePixelRatio, so the source is larger than the export on HiDPI screens.
 * Used by the salesperson QR page, whose source canvas carries its own margin.
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

  await triggerDownload(out, fileName, MIME_TYPES.png)
}
