// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as icons from './icons'
import { Icon } from './Icon'

afterEach(cleanup)

// Every icon the spec's icon map (§4) names, under lucide's canonical names
// (CirclePause/CirclePlay/LoaderCircle are the spec's PauseCircle/PlayCircle/Loader2).
const USED = [
  'Archive', 'Check', 'CirclePause', 'CirclePlay', 'Eye', 'FolderInput', 'Headphones', 'Layers', 'List',
  'LoaderCircle', 'Mic', 'Pause', 'Play', 'Plus', 'RefreshCw', 'RotateCcw', 'Search', 'Settings',
  'SkipForward', 'Sparkles', 'Square', 'Trash2', 'Undo2', 'X',
] as const

describe('icons', () => {
  it('exports every icon the screens use', () => {
    for (const name of USED) expect(icons[name], name).toBeTruthy()
  })

  it('exports nothing else', () => {
    expect(Object.keys(icons).sort()).toEqual([...USED].sort())
  })
})

describe('Icon', () => {
  it('renders 20px, stroke 2, hidden from screen readers', () => {
    const { container } = render(<Icon icon={icons.Plus} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('stroke-width')).toBe('2')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('takes a smaller size for small buttons', () => {
    const { container } = render(<Icon icon={icons.Plus} size={18} />)
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('18')
  })
})
