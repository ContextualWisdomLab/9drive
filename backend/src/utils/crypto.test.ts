import { describe, it, expect } from 'vitest'
import { encryptText, decryptText, randomToken, hashToken } from './crypto.js'

describe('crypto utils', () => {
  it('encrypts and decrypts text round-trip', () => {
    const plain = 'super-secret-value'
    const encrypted = encryptText(plain)
    expect(encrypted).toContain(':')
    expect(encrypted.split(':')).toHaveLength(3)
    expect(decryptText(encrypted)).toBe(plain)
  })

  it('throws on invalid encrypted payload', () => {
    expect(() => decryptText('invalid-payload')).toThrow('Invalid encrypted payload')
    expect(() => decryptText('a:b')).toThrow('Invalid encrypted payload')
  })

  it('generates random tokens of default and custom length', () => {
    const a = randomToken()
    const b = randomToken(16)
    expect(typeof a).toBe('string')
    expect(a).not.toBe(randomToken())
    expect(b.length).toBeLessThan(a.length)
  })

  it('hashes tokens deterministically', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
    expect(hashToken('abc')).toHaveLength(64)
  })
})
