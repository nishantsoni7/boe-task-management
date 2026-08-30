import ModuleGuard from '@/components/layout/ModuleGuard'
import { IMAGE_EDITOR_MODULE_KEY } from '@/lib/permissions/imageEditor'

// The parent gate, as a route guard.
//
// Same component every other engine-gated module uses, so "may this person open
// the Image Editor" is answered by the function the launcher card asks and the
// two can never drift. Direct navigation without `view` never mounts the page,
// so its queries never fire.
export default function ImageEditorLayout({ children }: { children: React.ReactNode }) {
  return <ModuleGuard moduleKey={IMAGE_EDITOR_MODULE_KEY}>{children}</ModuleGuard>
}
