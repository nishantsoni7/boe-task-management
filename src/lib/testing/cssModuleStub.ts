// Lets a node:test file server-render a component that imports a CSS module.
//
// Node cannot load `foo.module.css`, so a render test of any component styled
// that way dies at import with "Unexpected token '.'". Importing THIS FIRST in
// the test registers a stub that answers every class name with itself
// (`styles.typeCard` → "typeCard"), which is all a render assertion needs.
//
// Test-only. Import it before the component under test — imports are evaluated
// in order — and never from application code.

type CjsModule = { exports: unknown }
type CjsRequire = NodeJS.Require & { extensions: Record<string, (m: CjsModule, filename: string) => void> }

const cjsRequire = require as CjsRequire
cjsRequire.extensions['.css'] = (m: CjsModule) => {
  m.exports = new Proxy({}, { get: (_t, key) => (key === '__esModule' ? false : String(key)) })
}

export {}
