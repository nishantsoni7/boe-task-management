import sharp from 'sharp'

// A perceptual (difference) hash for the duplicate check.
//
// SERVER ONLY — imports sharp, like imageProcessing.ts.
//
// HOW IT WORKS (dHash, 64 rows × 64 comparisons = 4096 bits)
//   1. decode the image, flatten transparency onto white, convert to grey;
//   2. blur lightly (sigma 1) so compression noise does not flip bits;
//   3. resize to 65 × 64 pixels, ignoring aspect ratio;
//   4. for every row, compare each pixel with its right-hand neighbour: 1 when
//      the left one is darker. 64 × 64 = 4096 bits, written as 1024 hex characters.
//
// HOW TWO HASHES ARE COMPARED (duplicateDetection.ts): not by the raw number of
// differing bits but by that number as a share of the bits that are SET in either
// hash. A screenshot is mostly white background, so most bits are 0 in every hash;
// counting only where either image has marks makes a nearly-blank page and a busy
// page comparable, and keeps a shared white background from making unlike images
// look alike.
//
// WHY THIS RESOLUTION (measured on synthetic review screenshots — the hard case,
// one template with only the words changing): a coarse 17 × 16 or 33 × 32 grid
// sees a screenshot's layout but not its words, so a different review in the same
// template came out as close as one review saved at two JPEG qualities. At 65 × 64
// with a sigma-1 blur, JPEG (quality 25–50), WebP, resizing (300–1200 px) and blur
// of ONE screenshot differ in 13–21% of the marked bits; different reviews in the
// same template in 43–61%.
//
// WHAT IT DOES NOT SURVIVE: cropping to a different region, rotation, mirroring,
// an overlay that covers a large part of the image. Those are documented
// limitations, not silent gaps: an identical screenshot is caught separately by
// the SHA-256 of the stored bytes.
//
// The hash is computed from the RE-ENCODED bytes the route stores, so the value
// on the row describes exactly the object a verifier will open.

const COLS = 65
const ROWS = 64
const BLUR_SIGMA = 1

export async function differenceHash(bytes: Uint8Array): Promise<string> {
  const { data, info } = await sharp(bytes)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .blur(BLUR_SIGMA)
    .resize(COLS, ROWS, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  if (info.width !== COLS || info.height !== ROWS || info.channels !== 1) {
    throw new Error('image hash: unexpected decode shape')
  }

  let hex = ''
  let nibble = 0
  let bits = 0
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS - 1; x++) {
      const left = data[y * COLS + x]
      const right = data[y * COLS + x + 1]
      nibble = (nibble << 1) | (left < right ? 1 : 0)
      bits++
      if (bits === 4) {
        hex += nibble.toString(16)
        nibble = 0
        bits = 0
      }
    }
  }
  return hex
}
