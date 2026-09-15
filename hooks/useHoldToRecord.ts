'use client'
import { useCallback, useRef, useState } from 'react'

export type RecorderHandle = { stop: () => void }
export type RecorderFactory = (
  onData: (bytes: ArrayBuffer, mime: string) => void,
) => Promise<RecorderHandle>

export function useHoldToRecord({
  factory,
  onRecorded,
  minMs = 300,
}: {
  factory: RecorderFactory
  onRecorded: (bytes: ArrayBuffer, mime: string) => void
  minMs?: number
}) {
  const handleRef = useRef<RecorderHandle | null>(null)
  const startedAtRef = useRef(0)
  const keepRef = useRef(true)
  const stopRequestedRef = useRef(false)
  const activeRef = useRef(false)
  const [recording, setRecording] = useState(false)

  const start = useCallback(() => {
    if (activeRef.current) return
    activeRef.current = true
    stopRequestedRef.current = false
    keepRef.current = true
    startedAtRef.current = Date.now()
    setRecording(true)

    void factory((bytes, mime) => {
      if (keepRef.current) onRecorded(bytes, mime)
    })
      .then((handle) => {
        handleRef.current = handle
        // The finger can lift before getUserMedia resolves. Without this the
        // recorder would keep running with nothing listening for the release.
        if (stopRequestedRef.current) {
          handleRef.current = null
          activeRef.current = false
          handle.stop()
        }
      })
      .catch(() => {
        // The recorder never started — permission denied, or the device is
        // busy. Reset, or the button stays stuck in its recording state and
        // every later press is ignored.
        handleRef.current = null
        activeRef.current = false
        stopRequestedRef.current = false
        setRecording(false)
      })
  }, [factory, onRecorded])

  const stop = useCallback(() => {
    if (!activeRef.current) return
    keepRef.current = Date.now() - startedAtRef.current >= minMs
    stopRequestedRef.current = true
    setRecording(false)
    const handle = handleRef.current
    if (handle) {
      handleRef.current = null
      activeRef.current = false
      handle.stop()
    }
  }, [minMs])

  return { recording, start, stop }
}

export function mediaRecorderFactory(getStream: () => Promise<MediaStream>): RecorderFactory {
  return async (onData) => {
    const stream = await getStream()
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = () => {
      void new Blob(chunks, { type: mime }).arrayBuffer().then((bytes) => onData(bytes, mime))
    }
    recorder.start()
    return { stop: () => recorder.stop() }
  }
}
