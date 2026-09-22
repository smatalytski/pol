// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionState, useRestoreScroll, useScreenState } from './SessionState'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Counter({ storeKey }: { storeKey: string }) {
  const [n, setN] = useScreenState(storeKey, () => 0)
  return <button onClick={() => setN(n + 1)}>{`${storeKey}=${n}`}</button>
}

describe('useScreenState', () => {
  it('keeps a screen’s value across unmount and remount', () => {
    const view = render(
      <SessionState>
        <Counter storeKey="a" />
      </SessionState>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').textContent).toBe('a=1')

    // Same provider, child unmounted and mounted again — a tab switch.
    view.rerender(<SessionState><span /></SessionState>)
    view.rerender(<SessionState><Counter storeKey="a" /></SessionState>)
    expect(screen.getByRole('button').textContent).toBe('a=1')
  })

  it('does not let two keys share a slice, even without a remount', () => {
    const view = render(
      <SessionState>
        <Counter storeKey="t1" />
      </SessionState>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button').textContent).toBe('t1=1')

    // The key changes while the component stays mounted: /tematy/t1 -> /tematy/t2.
    view.rerender(<SessionState><Counter storeKey="t2" /></SessionState>)
    expect(screen.getByRole('button').textContent).toBe('t2=0')

    view.rerender(<SessionState><Counter storeKey="t1" /></SessionState>)
    expect(screen.getByRole('button').textContent).toBe('t1=1')
  })

  it('starts fresh under a new provider, so nothing outlives a reload', () => {
    const first = render(<SessionState><Counter storeKey="a" /></SessionState>)
    fireEvent.click(screen.getByRole('button'))
    first.unmount()
    render(<SessionState><Counter storeKey="a" /></SessionState>)
    expect(screen.getByRole('button').textContent).toBe('a=0')
  })
})

function Scrolled({ ready }: { ready: boolean }) {
  useRestoreScroll('s', ready)
  return <span>scrolled</span>
}

describe('useRestoreScroll', () => {
  it('waits for content before restoring, so the restore is not clamped to 0', () => {
    const scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    const view = render(<SessionState><Scrolled ready={true} /></SessionState>)

    // Scrolling is what records the position; jsdom does not move the window,
    // so set scrollY by hand and fire the event the hook listens for.
    Object.defineProperty(window, 'scrollY', { value: 240, configurable: true })
    fireEvent.scroll(window)

    // Back with nothing rendered yet: no restore, because the page is short.
    view.rerender(<SessionState><span /></SessionState>)
    view.rerender(<SessionState><Scrolled ready={false} /></SessionState>)
    expect(scrollTo).not.toHaveBeenCalled()

    // Content has arrived: now it restores, exactly once.
    view.rerender(<SessionState><span /></SessionState>)
    view.rerender(<SessionState><Scrolled ready={true} /></SessionState>)
    expect(scrollTo).toHaveBeenCalledWith(0, 240)
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })
})
