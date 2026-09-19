import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type EncodePart = { kind: 'clip'; bytes: Uint8Array } | { kind: 'silence'; ms: number }

export interface Encoder {
  encode(parts: EncodePart[]): Promise<{ bytes: Uint8Array; durationMs: number }>
}

/** Thrown when `ffmpeg` is not on PATH (the spawn fails with ENOENT). */
export class FfmpegMissingError extends Error {}

type RunFn = (cmd: string, args: string[]) => Promise<{ code: number; stderr: string }>

/**
 * Formats milliseconds as seconds for ffmpeg's `-t`, with up to 3 decimals
 * and no trailing zeros (5000 -> '5', 1500 -> '1.5').
 */
function toSeconds(ms: number): string {
  let s = (ms / 1000).toFixed(3)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

/**
 * Builds the ffmpeg command that resamples every input to 24 kHz mono,
 * concatenates them in order, and encodes the result as 64 kbps MP3. A file
 * input is read with `-i`; a silence input is synthesized with `anullsrc`
 * for `silenceMs`. This exact shape (verified against real ffmpeg with
 * mixed-rate, mixed-channel inputs) is what makes the summed duration land
 * on the input MP3s' own lengths rather than on some resampling artifact.
 */
export function ffmpegArgs(inputs: { file?: string; silenceMs?: number }[], out: string): string[] {
  const args: string[] = ['-hide_banner', '-y']

  for (const input of inputs) {
    if (input.file !== undefined) {
      args.push('-i', input.file)
    } else {
      args.push('-f', 'lavfi', '-t', toSeconds(input.silenceMs ?? 0), '-i', 'anullsrc=r=24000:cl=mono')
    }
  }

  const labels = inputs.map((_, i) => `p${i}`)
  const chains = inputs
    .map(
      (_, i) =>
        `[${i}:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[${labels[i]}]`,
    )
    .join(';')
  const concatInputs = labels.map((l) => `[${l}]`).join('')
  const filterComplex = `${chains};${concatInputs}concat=n=${inputs.length}:v=0:a=1[out]`

  args.push('-filter_complex', filterComplex)
  args.push('-map', '[out]', '-ac', '1', '-ar', '24000', '-b:a', '64k', '-f', 'mp3', out)

  return args
}

/**
 * Returns the last `time=HH:MM:SS.xx` in ffmpeg's stderr, in milliseconds,
 * or null when there is none. ffmpeg prints a progress line with `time=`
 * repeatedly as it works; the last one is the final duration.
 */
export function parseDurationMs(stderr: string): number | null {
  const matches = [...stderr.matchAll(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/g)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  const [, hh, mm, ss] = last
  const totalSeconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss)
  return Math.round(totalSeconds * 1000)
}

/**
 * Spawns `cmd`, collecting stderr and resolving with the exit code on
 * `close`. A wedged child (ffmpeg hung on a corrupt input, or anything else
 * that never exits) is killed with SIGKILL after `timeoutMs` so nothing
 * awaiting `encode()` — including an HTTP request — hangs forever; the
 * promise rejects instead of resolving in that case. Exported so a test can
 * exercise the timeout directly against a real child process (e.g. `sleep`)
 * without waiting on ffmpeg itself.
 */
export function defaultRun(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`))
      } else {
        resolve({ code: code ?? 1, stderr })
      }
    })
  })
}

/**
 * The production encoder: writes each clip to a temp dir, runs ffmpeg once
 * per call to join them (with synthesized silence between), and removes the
 * temp dir afterwards whether the run succeeded or not.
 */
export function ffmpegEncoder(opts?: { run?: RunFn; tmpRoot?: string; timeoutMs?: number }): Encoder {
  const timeoutMs = opts?.timeoutMs ?? 30_000
  const run: RunFn = opts?.run ?? ((cmd, args) => defaultRun(cmd, args, timeoutMs))
  const tmpRoot = opts?.tmpRoot ?? tmpdir()

  return {
    async encode(parts: EncodePart[]) {
      const dir = await mkdtemp(join(tmpRoot, 'fiszki-listen-'))
      try {
        const inputs: { file?: string; silenceMs?: number }[] = []
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]
          if (part.kind === 'clip') {
            const file = join(dir, `${i}.mp3`)
            await writeFile(file, part.bytes)
            inputs.push({ file })
          } else {
            inputs.push({ silenceMs: part.ms })
          }
        }

        const outFile = join(dir, 'out.mp3')
        const args = ffmpegArgs(inputs, outFile)

        let result: { code: number; stderr: string }
        try {
          result = await run('ffmpeg', args)
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'ENOENT') {
            throw new FfmpegMissingError('ffmpeg is not installed')
          }
          throw err
        }

        if (result.code !== 0) {
          const lastLine =
            result.stderr
              .trim()
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0)
              .pop() ?? ''
          throw new Error(`ffmpeg exited with code ${result.code}: ${lastLine}`)
        }

        const durationMs = parseDurationMs(result.stderr)
        if (durationMs === null) {
          throw new Error('ffmpeg reported no duration')
        }

        const bytes = await readFile(outFile)
        return { bytes: new Uint8Array(bytes), durationMs }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

export function getEncoder(): Encoder {
  return ffmpegEncoder()
}
