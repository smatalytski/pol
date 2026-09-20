// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LoginPage from './page'
import { t } from '@/i18n/pl'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubLogin(status: number) {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: status === 200, status }) as unknown as Promise<Response>,
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function submit(password = 'x') {
  fireEvent.change(screen.getByPlaceholderText(t.passwordPlaceholder), { target: { value: password } })
  fireEvent.click(screen.getByText(t.logIn))
}

describe('LoginPage', () => {
  it('says the password was wrong on a 401', async () => {
    stubLogin(401)
    render(<LoginPage />)
    submit()
    await waitFor(() => expect(screen.getByText(t.badPassword)).toBeTruthy())
    expect(screen.queryByText(t.tooManyAttempts)).toBeNull()
  })

  it('says to wait on a 429, rather than blaming the password', async () => {
    stubLogin(429)
    render(<LoginPage />)
    submit()
    await waitFor(() => expect(screen.getByText(t.tooManyAttempts)).toBeTruthy())
    expect(screen.queryByText(t.badPassword)).toBeNull()
  })

  it('clears the previous message when a new attempt is made', async () => {
    const fetchMock = stubLogin(401)
    render(<LoginPage />)
    submit()
    await waitFor(() => expect(screen.getByText(t.badPassword)).toBeTruthy())
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 429 }) as unknown as Promise<Response>)
    submit()
    await waitFor(() => expect(screen.getByText(t.tooManyAttempts)).toBeTruthy())
    expect(screen.queryByText(t.badPassword)).toBeNull()
  })
})
