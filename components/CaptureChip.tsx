import type { CaptureView } from '@/lib/capture/pipeline'
import { t } from '@/i18n/pl'

export function CaptureChip({ capture, onRetry }: { capture: CaptureView; onRetry: (id: string) => void }) {
  return (
    <li className="flex items-center gap-3 border-b py-3">
      <div className="flex-1">
        <p className="text-lg">{capture.transcript ?? t.transcribing}</p>
        {capture.duplicateOf && <p className="text-sm text-amber-600">{t.alreadyHave}</p>}
        {capture.status === 'failed' && <p className="text-sm text-red-600">{capture.error}</p>}
      </div>
      {capture.audioMediaId && (
        <audio controls preload="none" src={`/api/media/${capture.audioMediaId}`} aria-label={t.play} />
      )}
      {capture.status === 'failed' && (
        <button onClick={() => onRetry(capture.id)} className="text-sm underline">
          {t.retry}
        </button>
      )}
    </li>
  )
}
