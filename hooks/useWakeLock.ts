'use client'
import { useEffect } from 'react'

type Sentinel = { release: () => Promise<void> }

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    let sentinel: Sentinel | null = null
    let released = false
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } }).wakeLock
    void wakeLock?.request('screen').then((s) => {
      if (released) void s.release()
      else sentinel = s
    }).catch(() => {})
    return () => {
      released = true
      void sentinel?.release()
    }
  }, [active])
}
