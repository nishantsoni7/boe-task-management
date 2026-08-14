import ModuleGuard from '@/components/layout/ModuleGuard'

// Showroom QR's ADMIN surface. The customer-facing /showroom tree is public and
// deliberately untouched — it has no auth at all by design.
//
// This route was previously a bare passthrough, with access decided per page by
// canAccessModule() against app_modules. Entry is now effective
// `showroom_qr:view`.
//
// NOTE FOR WHOEVER DEPLOYS THIS: app_modules gave Showroom QR a DEPARTMENT rule
// (sales / showroom teams). The permission engine expresses departments too —
// department_permissions is level 3 of the precedence chain — but no rows were
// backfilled into it, because this change was scoped to not alter any employee
// permission assignment. Confirm from the access audit that the Showroom staff
// who need this module hold `showroom_qr:view` before releasing.
export default function ShowroomAdminLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="showroom_qr">{children}</ModuleGuard>
}
