import { afterEach, describe, expect, it, vi } from 'vitest'

const startWorker = vi.fn()
vi.mock('./lib/queue/worker', () => ({ startWorker }))
const { register } = await import('./instrumentation')

afterEach(() => {
  startWorker.mockClear()
  vi.unstubAllEnvs()
})

describe('register', () => {
  it('starts the worker in the Node.js server runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    await register()
    expect(startWorker).toHaveBeenCalledTimes(1)
  })

  it('does not start it in the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    await register()
    expect(startWorker).not.toHaveBeenCalled()
  })

  it('does not start it during next build', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('NEXT_PHASE', 'phase-production-build')
    await register()
    expect(startWorker).not.toHaveBeenCalled()
  })
})
