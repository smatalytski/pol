import { describe, it, expect, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ffmpegArgs,
  parseDurationMs,
  ffmpegEncoder,
  FfmpegMissingError,
  type EncodePart,
} from './ffmpeg'

describe('ffmpegArgs', () => {
  it('builds the verified command for mixed files and silence', () => {
    const args = ffmpegArgs(
      [{ file: '/t/0.mp3' }, { silenceMs: 5000 }, { file: '/t/2.mp3' }],
      '/t/out.mp3',
    )
    expect(args).toEqual([
      '-hide_banner',
      '-y',
      '-i',
      '/t/0.mp3',
      '-f',
      'lavfi',
      '-t',
      '5',
      '-i',
      'anullsrc=r=24000:cl=mono',
      '-i',
      '/t/2.mp3',
      '-filter_complex',
      '[0:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[p0];[1:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[p1];[2:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[p2];[p0][p1][p2]concat=n=3:v=0:a=1[out]',
      '-map',
      '[out]',
      '-ac',
      '1',
      '-ar',
      '24000',
      '-b:a',
      '64k',
      '-f',
      'mp3',
      '/t/out.mp3',
    ])
  })

  it('writes silence durations in seconds with up to 3 decimals', () => {
    const args = ffmpegArgs([{ silenceMs: 1500 }], '/t/out.mp3')
    expect(args).toContain('1.5')
    expect(args).not.toContain('1500')
  })

  it('writes whole-second silences without a decimal point', () => {
    const args = ffmpegArgs([{ silenceMs: 2000 }], '/t/out.mp3')
    expect(args).toContain('2')
    expect(args).not.toContain('2.000')
  })
})

describe('parseDurationMs', () => {
  it('returns the last time= value in the stderr, in milliseconds', () => {
    const stderr = [
      'frame=   10 fps=0.0 q=-1.0 size=       1kB time=00:00:01.00 bitrate=   8.2kbits/s',
      'frame=   90 fps=0.0 q=-1.0 Lsize=       9kB time=00:00:09.00 bitrate=   8.2kbits/s',
    ].join('\n')
    expect(parseDurationMs(stderr)).toBe(9000)
  })

  it('returns null when there is no time=', () => {
    expect(parseDurationMs('ffmpeg version 7.1.5 ...\nno progress lines here')).toBeNull()
  })
})

describe('ffmpegEncoder with a fake run', () => {
  function parts(): EncodePart[] {
    return [
      { kind: 'clip', bytes: new Uint8Array([1, 2, 3]) },
      { kind: 'silence', ms: 5000 },
      { kind: 'clip', bytes: new Uint8Array([4, 5]) },
    ]
  }

  it('writes clip files under tmpRoot, matches ffmpegArgs, and returns the output bytes', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'fiszki-listen-test-root-'))
    let capturedDir = ''

    const run = vi.fn(async (cmd: string, args: string[]) => {
      expect(cmd).toBe('ffmpeg')
      // Positions per the verified ffmpegArgs shape for [file, silence, file]:
      // 0 -hide_banner 1 -y 2 -i 3 file0 4 -f 5 lavfi 6 -t 7 5 8 -i 9 anullsrc 10 -i 11 file2 ... last outFile
      const file0 = args[3]
      const file2 = args[11]
      const outFile = args[args.length - 1]
      capturedDir = file0.slice(0, file0.lastIndexOf('/'))

      expect(capturedDir.startsWith(tmpRoot)).toBe(true)
      expect(file0).toBe(join(capturedDir, '0.mp3'))
      expect(file2).toBe(join(capturedDir, '2.mp3'))
      expect(await readFile(file0)).toEqual(Buffer.from([1, 2, 3]))
      expect(await readFile(file2)).toEqual(Buffer.from([4, 5]))

      expect(args).toEqual(
        ffmpegArgs([{ file: file0 }, { silenceMs: 5000 }, { file: file2 }], outFile),
      )

      await writeFile(outFile, Buffer.from([9, 9, 9]))
      return { code: 0, stderr: 'time=00:00:05.00' }
    })

    const encoder = ffmpegEncoder({ run, tmpRoot })
    const result = await encoder.encode(parts())

    expect(run).toHaveBeenCalledTimes(1)
    expect([...result.bytes]).toEqual([9, 9, 9])
    expect(result.durationMs).toBe(5000)

    // Temp dir is gone afterwards on success.
    await expect(stat(capturedDir)).rejects.toThrow()
  })

  it('removes the temp dir on failure too, and throws an Error including the stderr last line', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'fiszki-listen-test-fail-'))
    let capturedDir = ''

    const run = vi.fn(async (_cmd: string, args: string[]) => {
      const file0 = args[3]
      capturedDir = file0.slice(0, file0.lastIndexOf('/'))
      return { code: 1, stderr: 'Unknown encoder\nConversion failed!' }
    })

    const encoder = ffmpegEncoder({ run, tmpRoot })
    await expect(encoder.encode(parts())).rejects.toThrow(/Conversion failed!/)
    await expect(stat(capturedDir)).rejects.toThrow()
  })

  it('throws FfmpegMissingError when run rejects with code ENOENT', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'fiszki-listen-test-enoent-'))
    const run = vi.fn(async () => {
      const err = new Error('spawn ffmpeg ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })

    const encoder = ffmpegEncoder({ run, tmpRoot })
    await expect(encoder.encode(parts())).rejects.toBeInstanceOf(FfmpegMissingError)
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

describe('ffmpegEncoder with real ffmpeg', () => {
  function generateClip(args: string[]): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args)
      const chunks: Buffer[] = []
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`ffmpeg clip generation failed: ${stderr}`))
        else resolve(new Uint8Array(Buffer.concat(chunks)))
      })
    })
  }

  it.skipIf(!hasFfmpeg)(
    'joins clips and silences into one MP3 of the summed duration',
    async () => {
      const monoClip = await generateClip([
        '-hide_banner',
        '-f',
        'lavfi',
        '-t',
        '1.3',
        '-i',
        'sine=f=440:r=24000',
        '-ac',
        '1',
        '-b:a',
        '32k',
        '-f',
        'mp3',
        'pipe:1',
      ])
      const stereoClip = await generateClip([
        '-hide_banner',
        '-f',
        'lavfi',
        '-t',
        '0.7',
        '-i',
        'sine=f=440:r=44100',
        '-ac',
        '2',
        '-b:a',
        '64k',
        '-f',
        'mp3',
        'pipe:1',
      ])

      const encoder = ffmpegEncoder()
      const { bytes, durationMs } = await encoder.encode([
        { kind: 'clip', bytes: monoClip },
        { kind: 'silence', ms: 5000 },
        { kind: 'clip', bytes: stereoClip },
        { kind: 'silence', ms: 2000 },
      ])

      expect(Math.abs(durationMs - 9000)).toBeLessThanOrEqual(150)

      const isId3 = Buffer.from(bytes.slice(0, 3)).toString('ascii') === 'ID3'
      const isFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
      expect(isId3 || isFrameSync).toBe(true)
    },
    20000,
  )
})
