import { vi } from 'vitest'

// Set required env vars for tests before any module reads them.
process.env.DATABASE_URL = 'file::memory:?cache=shared'
process.env.APP_PORT = '4000'
process.env.FRONTEND_URL = 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET = 'test-jwt-secret-that-is-at-least-32-chars!!'
process.env.TOKEN_ENCRYPTION_KEY = 'test-encryption-key-32-chars-ok!'
process.env.ACCESS_TOKEN_TTL_SECONDS = '900'
process.env.REFRESH_TOKEN_TTL_DAYS = '30'
process.env.MAX_UPLOAD_BYTES = '5368709120'

// Silence expected console noise from error-handling branches.
vi.spyOn(console, 'error').mockImplementation(() => undefined)
vi.spyOn(console, 'log').mockImplementation(() => undefined)
