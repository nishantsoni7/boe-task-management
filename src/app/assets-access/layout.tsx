import ModuleGuard from '@/components/layout/ModuleGuard'

// Assets & Access was labelled "Active" (fully enforced) while having no entry
// guard at all: deriveAssetsAccessCapabilities computed canAccessAssetsModule
// and no page ever read it. The capabilities still decide what is shown INSIDE
// the module; this decides whether it opens.
export default function AssetsAccessLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey="assets_access">{children}</ModuleGuard>
}
