// Exact money arithmetic for the bank statements: whole paise as integers.
// Statement amounts are rupees with at most two decimals; comparing floats
// ("8416.24 + 50000 = 58416.24"?) is how a reconciliation lies, so every
// comparison goes through paise.

/** Rupees → whole paise. Refuses a value with more than two decimals. */
export function toPaise(rupees: number): number {
  const p = Math.round(rupees * 100)
  if (Math.abs(p / 100 - rupees) > 0.0000001) {
    throw new Error(`${rupees} has more than two decimals`)
  }
  return p
}

export function fromPaise(paise: number): number {
  return paise / 100
}

export const samePaise = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100)
