'use client'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type Reducer,
  type SetStateAction,
} from 'react'

/**
 * Where each screen's place is kept while you are on another one (spec
 * 2026-09-22 §3). Mounted in the root layout, which a client navigation does
 * not unmount, so this outlives every tab switch and nothing else.
 *
 * The store is a plain Map in a ref, never state: a screen writing its value
 * back must not re-render the whole app underneath the layout. Screens keep
 * their own useState/useReducer for rendering and mirror into the Map, so a
 * keystroke re-renders exactly the screen it happened on, as it does today.
 *
 * Deliberately in memory only. It is emptied by a reload, which is the whole
 * lifetime the spec asks for (§2) — anything longer would mean re-validating
 * every restored value against the server on the way back in.
 */
const StoreContext = createContext<Map<string, unknown> | null>(null)

export function SessionState({ children }: { children: ReactNode }) {
  const ref = useRef<Map<string, unknown> | null>(null)
  ref.current ??= new Map()
  return <StoreContext.Provider value={ref.current}>{children}</StoreContext.Provider>
}

function useStore(): Map<string, unknown> {
  const store = useContext(StoreContext)
  // A screen outside the provider would silently forget everything, which is
  // exactly the bug this exists to prevent — so it is a crash, not a fallback.
  if (!store) throw new Error('session hooks used outside <SessionState>')
  return store
}

/** Drop-in for useState, backed by the store. `initial` runs only when the key has nothing yet. */
export function useScreenState<T>(key: string, initial: () => T): [T, Dispatch<SetStateAction<T>>] {
  const store = useStore()
  const [value, setValue] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : initial()))
  // The key can change without a remount — /tematy/t1 to /tematy/t2 keeps this
  // component mounted — so re-seed during render (React's documented "adjust
  // state when a prop changes" pattern) rather than in an effect, which would
  // paint one frame of the previous topic's draft first.
  const seeded = useRef(key)
  if (seeded.current !== key) {
    seeded.current = key
    setValue(store.has(key) ? (store.get(key) as T) : initial())
  }
  useEffect(() => {
    store.set(key, value)
  }, [store, key, value])
  return [value, setValue]
}

/** Drop-in for useReducer, backed by the store — /powtorki's reviewReducer. */
export function useScreenReducer<S, A>(key: string, reducer: Reducer<S, A>, initial: S): [S, Dispatch<A>] {
  const store = useStore()
  const [state, dispatch] = useReducer(reducer, undefined as never, () =>
    store.has(key) ? (store.get(key) as S) : initial,
  )
  useEffect(() => {
    store.set(key, state)
  }, [store, key, state])
  return [state, dispatch]
}

/**
 * Restores a screen's scroll position once it has something to scroll.
 *
 * `ready` is not optional dressing: a screen that fetches its list paints
 * short on mount, and a scroll restored then is clamped to 0 by the browser.
 * The position is recorded from a passive scroll listener straight into the
 * Map rather than read at unmount, so it survives a navigation that scrolls
 * the window before this screen tears down.
 */
export function useRestoreScroll(key: string, ready: boolean): void {
  const store = useStore()
  const storeKey = `scroll:${key}`
  const restored = useRef(false)

  useEffect(() => {
    const onScroll = () => store.set(storeKey, window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [store, storeKey])

  useLayoutEffect(() => {
    if (restored.current || !ready) return
    restored.current = true
    const y = store.get(storeKey)
    if (typeof y === 'number' && y > 0) window.scrollTo(0, y)
  }, [store, storeKey, ready])
}
