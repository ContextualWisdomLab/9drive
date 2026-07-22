import { describe, it, expect } from 'vitest'
import { env } from './env.js'

describe('env config', () => {
  it('parses required environment variables', () => {
    expect(env.DATABASE_URL).toBe('file::memory:?cache=shared')
    expect(env.APP_PORT).toBe(4000)
    expect(env.FRONTEND_URL).toBe('http://localhost:5173')
    expect(env.JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32)
    expect(env.TOKEN_ENCRYPTION_KEY.length).toBeGreaterThanOrEqual(32)
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900)
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30)
    expect(env.MAX_UPLOAD_BYTES).toBe(5368709120)
  })
})
