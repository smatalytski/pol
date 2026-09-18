import { z } from 'zod'
import { COUNTS, MIXES } from './rounds'

/** A round's settings as a request body: only the offered counts and mixes. */
export const RoundBody = z.object({
  count: z.number().int().refine((n) => (COUNTS as readonly number[]).includes(n)),
  mix: z.enum(MIXES),
})
