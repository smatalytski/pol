import 'fake-indexeddb/auto'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// @testing-library/react's own auto-cleanup only registers itself when
// `afterEach` already exists as a global at import time, which requires
// vitest's `test.globals: true`. This project imports test APIs explicitly
// instead, so without this, DOM trees from one `*.dom.test.tsx` render leak
// into the next test in the same file and `getByRole` starts matching
// duplicates. Node-environment tests never call `render`, so this is a no-op
// for them.
afterEach(() => {
  cleanup()
})
