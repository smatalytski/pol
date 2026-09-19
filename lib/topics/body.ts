import { z } from 'zod'
import { COUNTS, LEVELS, MIXES } from './rounds'

/** A batch's settings as a request body: only the offered counts, mixes and levels (spec 2026-09-19-topic-items §4.5). */
export const BatchBody = z.object({
  count: z.number().int().refine((n) => (COUNTS as readonly number[]).includes(n)),
  mix: z.enum(MIXES),
  level: z.enum(LEVELS),
})
