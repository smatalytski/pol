import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Some geminiGenerator() tests omit `model` to exercise the env-fallback
    // path without needing real credentials — they only need FISZKI_MODEL to
    // be a truthy string, never an actual network call. Vitest does not load
    // .env.local (that's Next.js-only), so provide a fixed test value here.
    env: { FISZKI_MODEL: 'gemini-3.8-flash' },
  },
  resolve: { alias: { '@': import.meta.dirname } },
})
