// Metal weight, worked out the way the two calculators the owner uses do it (owner, 23 Nov 2026):
// galaluminium.in/Metal_weight_calculator.html and maiak-m.bg/en/calculator (sheets, pipes, tubes, bars).
// Both take weight = cross-section × length × density. They differ only on square and rectangular tubes:
// maiak-m.bg takes off the steel of the rounded corners of a real tube (outer radius 1.5 × wall, inner 0.5 × wall:
// its constant 0.044877 = 0.0314 + 4 × (1 − π/4) × (1.5² − 0.5²) × 0.00785), galaluminium.in keeps the corners sharp.
// Pure: sizes in, kilograms and square feet out.

/** Densities in kg/m³, as galaluminium.in lists them. */
export const METALS = [
  { key: 'ms', label: 'Mild steel (MS)', density: 7850 },
  { key: 'ss', label: 'Stainless steel', density: 7900 },
  { key: 'aluminium', label: 'Aluminium', density: 2700 },
  { key: 'brass', label: 'Brass', density: 8500 },
  { key: 'copper', label: 'Copper', density: 8960 },
  { key: 'bronze', label: 'Bronze', density: 8800 },
  { key: 'cast_iron', label: 'Cast iron', density: 7200 },
] as const

/** Standard Wire Gauge in mm: Indian tube and sheet sizes are often given as "18 gauge". */
export const SWG: Record<number, number> = {
  10: 3.251, 11: 2.946, 12: 2.642, 13: 2.337, 14: 2.032, 15: 1.829, 16: 1.626, 17: 1.422,
  18: 1.219, 19: 1.016, 20: 0.914, 21: 0.813, 22: 0.711, 23: 0.61, 24: 0.559,
}

/** Steel lost at the four rounded corners of a tube, in mm² per mm² of wall squared (maiak-m.bg). */
export const ROUNDED_CORNER_LOSS = 4 * (1 - Math.PI / 4) * (1.5 * 1.5 - 0.5 * 0.5)

export type ProfileKey = 'pipe' | 'sqtube' | 'recttube' | 'rbar' | 'sbar' | 'flat' | 'hex' | 'angle' | 'sheet' | 'circle' | 'ring'
/** The three sizes each profile asks for (A, B, T); null where a profile has none. byLength: sold and weighed per metre. */
export const PROFILES: Record<ProfileKey, { label: string; sizes: [string, string | null, string | null]; byLength: boolean; tube?: boolean }> = {
  pipe: { label: 'Round pipe', sizes: ['Outside diameter', null, 'Wall'], byLength: true },
  sqtube: { label: 'Square tube', sizes: ['Side', null, 'Wall'], byLength: true, tube: true },
  recttube: { label: 'Rectangular tube', sizes: ['Side', 'Other side', 'Wall'], byLength: true, tube: true },
  rbar: { label: 'Round bar', sizes: ['Diameter', null, null], byLength: true },
  sbar: { label: 'Square bar', sizes: ['Side', null, null], byLength: true },
  flat: { label: 'Flat bar', sizes: ['Width', null, 'Thickness'], byLength: true },
  hex: { label: 'Hexagon bar', sizes: ['Across flats', null, null], byLength: true },
  angle: { label: 'Angle', sizes: ['Leg', 'Other leg', 'Thickness'], byLength: true },
  sheet: { label: 'Sheet or plate', sizes: ['Width', 'Length', 'Thickness'], byLength: false },
  circle: { label: 'Circle (disc)', sizes: ['Diameter', null, 'Thickness'], byLength: false },
  ring: { label: 'Ring', sizes: ['Outside diameter', 'Inside diameter', 'Thickness'], byLength: false },
}
export const isProfile = (v: unknown): v is ProfileKey => typeof v === 'string' && v in PROFILES

/** A profile sold by length: its cross-section in mm² and outer perimeter in mm. Null when the sizes cannot be. */
export function section(p: ProfileKey, a: number, b: number, t: number, rounded = true): { area: number; perimeter: number } | null {
  const corners = rounded ? ROUNDED_CORNER_LOSS * t * t : 0
  switch (p) {
    case 'pipe': return t * 2 >= a ? null : { area: Math.PI * t * (a - t), perimeter: Math.PI * a }
    case 'sqtube': return t * 2 >= a ? null : { area: 4 * a * t - 4 * t * t - corners, perimeter: 4 * a }
    case 'recttube': return t * 2 >= Math.min(a, b) ? null : { area: 2 * t * (a + b) - 4 * t * t - corners, perimeter: 2 * (a + b) }
    case 'rbar': return { area: Math.PI * a * a / 4, perimeter: Math.PI * a }
    case 'sbar': return { area: a * a, perimeter: 4 * a }
    case 'flat': return { area: a * t, perimeter: 2 * (a + t) }
    case 'hex': return { area: 0.866 * a * a, perimeter: 6 * a / Math.sqrt(3) } // galaluminium.in's 0.866 × AF²
    case 'angle': return t >= Math.min(a, b) ? null : { area: (a + b - t) * t, perimeter: 2 * (a + b) }
    default: return null
  }
}

/** A profile sold by the piece: its volume in mm³ and both faces in mm² (the edges are left out). */
export function piece(p: ProfileKey, a: number, b: number, t: number): { volume: number; faces: number } | null {
  switch (p) {
    case 'sheet': return { volume: a * b * t, faces: 2 * a * b }
    case 'circle': return { volume: Math.PI * a * a / 4 * t, faces: Math.PI * a * a / 2 }
    case 'ring': return b >= a ? null : { volume: Math.PI * (a * a - b * b) / 4 * t, faces: Math.PI * (a * a - b * b) / 2 }
    default: return null
  }
}

export const LENGTH_TO_M = { m: 1, mm: 0.001, ft: 0.3048, in: 0.0254 } as const
export type LengthUnit = keyof typeof LENGTH_TO_M
const SQFT_PER_M2 = 10.7639

export type MetalPart = {
  profile: ProfileKey
  /** Sizes as typed, in `unit`. */
  a: number; b: number | null; t: number | null; unit: 'mm' | 'in'
  /** An SWG gauge for the wall or thickness, used instead of `t` when given. */
  gauge: number | null
  corners: 'round' | 'sharp'
  length: number | null; lengthUnit: LengthUnit
  qty: number
}
export type PartWeight = {
  /** kg per metre for a profile sold by length, kg per m² for a sheet, kg per piece for a circle or ring. */
  per: number; perUnit: 'kg/m' | 'kg/m²' | 'kg'
  kgEach: number; kg: number
  /** Outer surface of all the pieces, for coating. */
  sqft: number
}

/** The weight of `qty` pieces of one profile, or a sentence saying what is wrong with the sizes. */
export function partWeight(p: MetalPart, density: number): PartWeight | { error: string } {
  const spec = PROFILES[p.profile]
  if (!spec) return { error: 'Pick a profile.' }
  const k = p.unit === 'in' ? 25.4 : 1
  const gaugeMm = p.gauge !== null ? SWG[p.gauge] : undefined
  if (p.gauge !== null && gaugeMm === undefined) return { error: `${p.gauge} is not an SWG gauge between 10 and 24.` }
  const a = p.a * k
  const b = spec.sizes[1] ? (p.b ?? 0) * k : a
  const t = spec.sizes[2] ? (gaugeMm ?? (p.t ?? 0) * k) : 0
  if (!(a > 0) || (spec.sizes[1] && !(b > 0)) || (spec.sizes[2] && !(t > 0))) return { error: `Give every size of the ${spec.label.toLowerCase()}.` }
  if (!(density > 0)) return { error: 'Give the density of the metal.' }
  if (!(p.qty > 0)) return { error: 'Give how many pieces.' }
  if (spec.byLength) {
    const s = section(p.profile, a, b, t, p.corners !== 'sharp')
    if (!s) return { error: 'The wall or thickness is too big for this size. Check for a slip such as 16 typed for 1.6.' }
    const metres = (p.length ?? 0) * LENGTH_TO_M[p.lengthUnit]
    if (!(metres > 0)) return { error: 'Give the length of each piece.' }
    const per = s.area * density / 1e6
    return { per, perUnit: 'kg/m', kgEach: per * metres, kg: per * metres * p.qty, sqft: s.perimeter / 1000 * metres * p.qty * SQFT_PER_M2 }
  }
  const v = piece(p.profile, a, b, t)
  if (!v) return { error: 'The inside diameter must be smaller than the outside diameter.' }
  const kgEach = v.volume * density / 1e9
  return { per: p.profile === 'sheet' ? t * density / 1000 : kgEach, perUnit: p.profile === 'sheet' ? 'kg/m²' : 'kg', kgEach, kg: kgEach * p.qty, sqft: v.faces / 1e6 * p.qty * SQFT_PER_M2 }
}
