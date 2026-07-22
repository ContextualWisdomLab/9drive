import { describe, it, expect } from 'vitest'
import { signAccessToken, verifyAccessToken } from './jwt.js'

describe('jwt utils', () => {
  it('signs and verifies an access token round-trip', () => {
    const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
    expect(typeof token).toBe('string')
    const payload = verifyAccessToken(token)
    expect(payload.sub).toBe('user-1')
    expect(payload.sid).toBe('session-1')
  })

  it('throws when verifying an invalid token', () => {
    expect(() => verifyAccessToken('not-a-jwt')).toThrow()
  })
})
