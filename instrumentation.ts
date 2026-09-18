/**
 * Next.js calls this once when a server instance starts. The generation queue
 * (spec 2026-09-18-generation-queue §5) runs inside the web server, only in the
 * Node.js runtime, and never during `next build`.
 *
 * The runtime check is a single positive `if` around the dynamic import,
 * rather than two early returns before it: this project also has an edge
 * `middleware.ts`, so `next build` compiles this file for the edge runtime
 * too, and only this shape lets webpack's dead-code elimination drop the
 * `./lib/queue/worker` import (and its Node-only `@google-cloud/speech`
 * dependency, which fails to bundle for edge) from that build. An early
 * `if (process.env.NEXT_RUNTIME !== 'nodejs') return` before the import broke
 * `npm run build` with "Can't resolve 'stream'" from that package.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { startWorker } = await import('./lib/queue/worker')
    await startWorker()
  }
}
