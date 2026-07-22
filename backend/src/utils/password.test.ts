import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password utils', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('my-password-123')
    expect(typeof hash).toBe('string')
    expect(await verifyPassword(hash, 'my-password-123')).toBe(true)
  })

  it('fails verification for wrong password', async () => {
    const hash = await hashPassword('correct-horse')
    expect(await verifyPassword(hash, 'wrong-horse')).toBe(false)
  })
})
