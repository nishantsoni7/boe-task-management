// The one route under /payroll that is not admin-only.
//
// Its own module so PayrollGuard (src/app/payroll/layout.tsx) and the link cards
// that point at it agree on the string. A guard whose exception is spelled with
// a literal in one file and a link in another is one typo away from either
// locking employees out of the page or opening the module by accident.

export const PAYROLL_GUIDE_PATH = '/payroll/how-it-works'
