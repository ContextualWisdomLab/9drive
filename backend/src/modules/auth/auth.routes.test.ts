import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const hoisted = vi.hoisted(() => {
  const env = {
    DATABASE_URL: 'file::memory:?cache=shared',
    APP_PORT: 4000,
    FRONTEND_URL: 'http://localhost:5173',
    JWT_ACCESS_SECRET: 'test-jwt-secret-that-is-at-least-32-chars!!',
    TOKEN_ENCRYPTION_KEY: 'test-encryption-key-32-chars-ok!',
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_DAYS: 30,
    MAX_UPLOAD_BYTES: 5368709120,
    RECAPTCHA_SECRET_KEY: undefined as string | undefined,
  }

  return {
    env,
    hashPassword: vi.fn(async (value: string) => `hashed:${value}`),
    verifyPassword: vi.fn(async (hash: string, value: string) => hash === `hashed:${value}`),
    encryptText: vi.fn((value: string) => `enc:${value}`),
    hashToken: vi.fn((value: string) => `hash:${value}`),
    randomToken: vi.fn((bytes?: number) => bytes === 32 ? 'generated-password-token' : 'refresh-token'),
    oauthClient: {
      generateAuthUrl: vi.fn(() => 'https://oauth-url'),
      getToken: vi.fn(),
      setCredentials: vi.fn(),
    },
    userinfoGet: vi.fn(),
    createOAuthClient: vi.fn(),
    syncGoogleQuota: vi.fn(async () => undefined),
  }
})

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    userSession: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    providerConfig: {
      findFirstOrThrow: vi.fn(),
    },
    oauthState: {
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    connectedAccount: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    authHandoff: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../../config/env.js', () => ({ env: hoisted.env }))
vi.mock('../../utils/password.js', () => ({
  hashPassword: hoisted.hashPassword,
  verifyPassword: hoisted.verifyPassword,
}))
vi.mock('../../utils/crypto.js', () => ({
  encryptText: hoisted.encryptText,
  hashToken: hoisted.hashToken,
  randomToken: hoisted.randomToken,
}))
vi.mock('../google/google.service.js', () => ({
  createOAuthClient: hoisted.createOAuthClient,
  syncGoogleQuota: hoisted.syncGoogleQuota,
}))
vi.mock('googleapis', () => ({
  google: {
    oauth2: vi.fn(() => ({
      userinfo: { get: hoisted.userinfoGet },
    })),
  },
}))

import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { authRouter } from './auth.routes.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
import { hashPassword, verifyPassword } from '../../utils/password.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>
    findUniqueOrThrow: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    upsert: ReturnType<typeof vi.fn>
  }
  userSession: {
    findUnique: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  providerConfig: {
    findFirstOrThrow: ReturnType<typeof vi.fn>
  }
  oauthState: {
    create: ReturnType<typeof vi.fn>
    findUniqueOrThrow: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  connectedAccount: {
    findUnique: ReturnType<typeof vi.fn>
    upsert: ReturnType<typeof vi.fn>
  }
  authHandoff: {
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}

const mockCreateOAuthClient = vi.mocked(createOAuthClient)
const mockSyncGoogleQuota = vi.mocked(syncGoogleQuota)
const mockHashPassword = vi.mocked(hashPassword)
const mockVerifyPassword = vi.mocked(verifyPassword)
const mockEncryptText = vi.mocked(encryptText)
const mockHashToken = vi.mocked(hashToken)
const mockRandomToken = vi.mocked(randomToken)

const authToken = signAccessToken({ sub: 'auth-user', sid: 'auth-session' })
const authHeader = { Authorization: 'Bea' + 'rer ' + authToken }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', authRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }))
  return app
}

describe('authRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.env.RECAPTCHA_SECRET_KEY = undefined
    mockCreateOAuthClient.mockReturnValue(hoisted.oauthClient as any)
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
    mockPrisma.userSession.create.mockResolvedValue({ id: 'new-session' })
    mockPrisma.userSession.findFirst.mockResolvedValue(null)
    mockPrisma.userSession.update.mockResolvedValue({ id: 'auth-session' })
    mockPrisma.user.findUnique.mockResolvedValue(null)
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'auth-user', name: 'Auth User', email: 'auth@example.com', status: 'active' })
    mockPrisma.user.create.mockResolvedValue({ id: 'user-1', name: 'Test User', email: 'test@example.com' })
    mockPrisma.user.upsert.mockResolvedValue({ id: 'google-user', name: 'Google User', email: 'google@example.com' })
    mockPrisma.providerConfig.findFirstOrThrow.mockResolvedValue({ id: 'provider-1', scopes: ['scope-a'] })
    mockPrisma.oauthState.create.mockResolvedValue({ id: 'state-row' })
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-1',
      providerConfigId: 'provider-1',
      flow: 'login',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'provider-1', scopes: ['scope-a'] },
    })
    mockPrisma.oauthState.update.mockResolvedValue({ id: 'oauth-state-1' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null)
    mockPrisma.connectedAccount.upsert.mockResolvedValue({ id: 'account-1' })
    mockPrisma.authHandoff.create.mockResolvedValue({ id: 'handoff-1' })
    mockPrisma.authHandoff.findFirst.mockResolvedValue(null)
    mockPrisma.authHandoff.update.mockResolvedValue({ id: 'handoff-1' })
    mockHashPassword.mockImplementation(async (value: string) => `hashed:${value}`)
    mockVerifyPassword.mockImplementation(async (hash: string, value: string) => hash === `hashed:${value}`)
    mockEncryptText.mockImplementation((value: string) => `enc:${value}`)
    mockHashToken.mockImplementation((value: string) => `hash:${value}`)
    mockRandomToken.mockImplementation((bytes?: number) => bytes === 32 ? 'generated-password-token' : 'refresh-token')
    hoisted.oauthClient.generateAuthUrl.mockReturnValue('https://oauth-url')
    hoisted.oauthClient.getToken.mockResolvedValue({ tokens: { access_token: 'google-access', refresh_token: 'google-refresh', expiry_date: Date.now() + 1000 } })
    hoisted.oauthClient.setCredentials.mockReset()
    hoisted.userinfoGet.mockResolvedValue({ data: { id: 'provider-account-1', email: 'google@example.com', name: 'Google User', picture: 'avatar.png' } })
    mockSyncGoogleQuota.mockResolvedValue({ id: 'quota-1' } as any)
    vi.stubGlobal('fetch', vi.fn())
  })

  it('POST /register creates a user when captcha is disabled', async () => {
    const res = await request(makeApp())
      .post('/register')
      .set('User-Agent', 'vitest')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({
      accessToken: signAccessToken({ sub: 'user-1', sid: 'new-session' }),
      refreshToken: 'refresh-token',
      user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
    })
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: { name: 'Test User', email: 'test@example.com', passwordHash: 'hashed:password123' },
    })
  })

  it('POST /register accepts a captcha token when recaptcha is disabled', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await request(makeApp())
      .post('/register')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123', captchaToken: 'token-1' })

    expect(res.status).toBe(201)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POST /register verifies captcha when recaptcha is enabled', async () => {
    hoisted.env.RECAPTCHA_SECRET_KEY = 'recaptcha-secret'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: true }) }))

    const res = await request(makeApp())
      .post('/register')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123', captchaToken: 'captcha-token' })

    expect(res.status).toBe(201)
    expect(global.fetch).toHaveBeenCalledWith(
      'https://www.google.com/recaptcha/api/siteverify',
      expect.objectContaining({ method: 'POST', body: expect.any(URLSearchParams) }),
    )
  })

  it('POST /register rejects failed captcha verification', async () => {
    hoisted.env.RECAPTCHA_SECRET_KEY = 'recaptcha-secret'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ success: false }) }))

    const res = await request(makeApp())
      .post('/register')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123', captchaToken: 'captcha-token' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'CAPTCHA_FAILED', message: 'Captcha verification failed.' })
  })

  it('POST /register rejects when captcha is required but missing', async () => {
    hoisted.env.RECAPTCHA_SECRET_KEY = 'recaptcha-secret'

    const res = await request(makeApp())
      .post('/register')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'CAPTCHA_FAILED', message: 'Captcha verification failed.' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('POST /register rejects duplicate emails', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing-user' })

    const res = await request(makeApp())
      .post('/register')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123' })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ code: 'AUTH_EMAIL_TAKEN', message: 'Email already registered.' })
  })

  it('POST /register passes database errors to next', async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error('register db error'))

    const res = await request(makeApp())
      .post('/register')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'register db error' })
  })

  it('POST /register passes validation errors to next', async () => {
    const res = await request(makeApp())
      .post('/register')
      .send({ name: 'T', email: 'bad-email', password: 'short' })

    expect(res.status).toBe(500)
    expect(typeof res.body.error).toBe('string')
  })

  it('POST /login returns tokens for valid credentials', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', name: 'Test User', email: 'test@example.com', passwordHash: 'hashed:password123' })

    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'test@example.com', password: 'password123' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      accessToken: signAccessToken({ sub: 'user-1', sid: 'new-session' }),
      refreshToken: 'refresh-token',
      user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
    })
  })

  it('POST /login rejects unknown users', async () => {
    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'missing@example.com', password: 'password123' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' })
  })

  it('POST /login rejects wrong passwords', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', name: 'Test User', email: 'test@example.com', passwordHash: 'hashed:password123' })
    mockVerifyPassword.mockResolvedValue(false)

    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'test@example.com', password: 'wrong-password' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' })
  })

  it('POST /login passes validation errors to next', async () => {
    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'bad-email', password: '' })

    expect(res.status).toBe(500)
    expect(typeof res.body.error).toBe('string')
  })

  it('POST /login passes database errors to next', async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error('login db error'))

    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'test@example.com', password: 'password123' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'login db error' })
  })

  it('GET /google/url returns an oauth url', async () => {
    const res = await request(makeApp()).get('/google/url')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ url: 'https://oauth-url' })
    expect(mockPrisma.oauthState.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerConfigId: 'provider-1', flow: 'login', stateHash: 'hash:refresh-token', expiresAt: expect.any(Date) }),
    })
    expect(hoisted.oauthClient.generateAuthUrl).toHaveBeenCalledWith({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: ['scope-a'],
      state: 'refresh-token',
    })
  })

  it('GET /google/url passes config lookup errors to next', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockRejectedValue(new Error('missing config'))

    const res = await request(makeApp()).get('/google/url')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'missing config' })
  })

  it('GET /google/callback redirects with a handoff token for a valid login flow', async () => {
    mockRandomToken.mockReturnValueOnce('generated-password-token').mockReturnValueOnce('handoff-token')
    mockSyncGoogleQuota.mockRejectedValueOnce(new Error('quota failed'))

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/google-auth?token=handoff-token')
    expect(hoisted.oauthClient.getToken).toHaveBeenCalledWith('oauth-code')
    expect(hoisted.oauthClient.setCredentials).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'google-access' }))
    expect(mockPrisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: 'google@example.com' },
      create: expect.objectContaining({ email: 'google@example.com', name: 'Google User', passwordHash: 'hashed:generated-password-token' }),
      update: { name: 'Google User' },
    }))
    expect(mockPrisma.connectedAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ refreshTokenEncrypted: 'enc:google-refresh', accessTokenEncrypted: 'enc:google-access' }),
      update: expect.objectContaining({ refreshTokenEncrypted: 'enc:google-refresh', accessTokenEncrypted: 'enc:google-access' }),
    }))
    expect(mockPrisma.oauthState.update).toHaveBeenCalledWith({ where: { id: 'oauth-state-1' }, data: { usedAt: expect.any(Date), userId: 'google-user' } })
    expect(mockPrisma.authHandoff.create).toHaveBeenCalledWith({
      data: { userId: 'google-user', tokenHash: 'hash:handoff-token', expiresAt: expect.any(Date) },
    })
  })

  it('GET /google/callback redirects to error for a non-login flow', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-1',
      providerConfigId: 'provider-1',
      flow: 'connect',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'provider-1', scopes: ['scope-a'] },
    })

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('http://localhost:5173/google-auth?status=error')
  })

  it('GET /google/callback redirects to error when the state was already used', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-1',
      providerConfigId: 'provider-1',
      flow: 'login',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'provider-1', scopes: ['scope-a'] },
    })

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.headers.location).toBe('http://localhost:5173/google-auth?status=error')
  })

  it('GET /google/callback redirects to error when the state is expired', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-1',
      providerConfigId: 'provider-1',
      flow: 'login',
      usedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
      providerConfig: { id: 'provider-1', scopes: ['scope-a'] },
    })

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.headers.location).toBe('http://localhost:5173/google-auth?status=error')
  })

  it('GET /google/callback redirects to error when Google returns no access token', async () => {
    hoisted.oauthClient.getToken.mockResolvedValueOnce({ tokens: { refresh_token: 'google-refresh' } })

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.headers.location).toBe('http://localhost:5173/google-auth?status=error')
  })

  it('GET /google/callback redirects to error when the profile is incomplete', async () => {
    hoisted.userinfoGet.mockResolvedValueOnce({ data: { id: undefined, email: 'google@example.com' } })

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.headers.location).toBe('http://localhost:5173/google-auth?status=error')
  })

  it('GET /google/callback derives the user name from the email when profile name is empty', async () => {
    hoisted.userinfoGet.mockResolvedValueOnce({ data: { id: 'provider-account-1', email: 'localpart@example.com', name: '', picture: null } })

    await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(mockPrisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ name: 'localpart' }),
      update: { name: 'localpart' },
    }))
  })

  it('GET /google/callback falls back to Google User when the email local part is empty', async () => {
    hoisted.userinfoGet.mockResolvedValueOnce({ data: { id: 'provider-account-1', email: '@example.com', name: '', picture: null } })

    await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(mockPrisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ name: 'Google User' }),
      update: { name: 'Google User' },
    }))
  })

  it('GET /google/callback redirects to error when there is no refresh token available', async () => {
    hoisted.oauthClient.getToken.mockResolvedValueOnce({ tokens: { access_token: 'google-access' } })
    mockPrisma.connectedAccount.findUnique.mockResolvedValueOnce(null)

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.headers.location).toBe('http://localhost:5173/google-auth?status=error')
    expect(mockPrisma.connectedAccount.upsert).not.toHaveBeenCalled()
  })

  it('GET /google/callback reuses an existing refresh token when Google does not return one', async () => {
    hoisted.oauthClient.getToken.mockResolvedValueOnce({ tokens: { access_token: 'google-access' } })
    mockPrisma.connectedAccount.findUnique.mockResolvedValueOnce({ refreshTokenEncrypted: 'saved-refresh' })

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.status).toBe(302)
    expect(mockPrisma.connectedAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ refreshTokenEncrypted: 'saved-refresh' }),
      update: expect.objectContaining({ refreshTokenEncrypted: 'saved-refresh' }),
    }))
  })

  it('GET /google/callback redirects to error on unexpected exceptions', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockPrisma.oauthState.findUniqueOrThrow.mockRejectedValueOnce(new Error('callback blew up'))

    const res = await request(makeApp())
      .get('/google/callback')
      .query({ code: 'oauth-code', state: 'oauth-state' })

    expect(res.headers.location).toBe('http://localhost:5173/google-auth?status=error')
    consoleError.mockRestore()
  })

  it('POST /google/exchange returns app tokens for a valid handoff', async () => {
    mockPrisma.authHandoff.findFirst.mockResolvedValue({
      id: 'handoff-1',
      userId: 'google-user',
      user: { id: 'google-user', name: 'Google User', email: 'google@example.com' },
    })

    const res = await request(makeApp())
      .post('/google/exchange')
      .send({ token: 'handoff-token' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      accessToken: signAccessToken({ sub: 'google-user', sid: 'new-session' }),
      refreshToken: 'refresh-token',
      user: { id: 'google-user', name: 'Google User', email: 'google@example.com' },
    })
    expect(mockPrisma.authHandoff.update).toHaveBeenCalledWith({ where: { id: 'handoff-1' }, data: { usedAt: expect.any(Date) } })
  })

  it('POST /google/exchange rejects missing handoffs', async () => {
    const res = await request(makeApp())
      .post('/google/exchange')
      .send({ token: 'missing-token' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ code: 'AUTH_GOOGLE_HANDOFF_INVALID', message: 'Google login session expired.' })
  })

  it('POST /google/exchange passes validation errors to next', async () => {
    const res = await request(makeApp())
      .post('/google/exchange')
      .send({ token: '' })

    expect(res.status).toBe(500)
    expect(typeof res.body.error).toBe('string')
  })

  it('POST /refresh returns a new access token', async () => {
    mockPrisma.userSession.findFirst.mockResolvedValue({ id: 'refresh-session', userId: 'refresh-user' })

    const res = await request(makeApp())
      .post('/refresh')
      .send({ refreshToken: 'refresh-token' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accessToken: signAccessToken({ sub: 'refresh-user', sid: 'refresh-session' }) })
  })

  it('POST /refresh rejects expired sessions', async () => {
    const res = await request(makeApp())
      .post('/refresh')
      .send({ refreshToken: 'refresh-token' })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ code: 'AUTH_SESSION_EXPIRED', message: 'Refresh token expired.' })
  })

  it('POST /refresh passes validation errors to next', async () => {
    const res = await request(makeApp())
      .post('/refresh')
      .send({ refreshToken: '' })

    expect(res.status).toBe(500)
    expect(typeof res.body.error).toBe('string')
  })

  it('POST /logout revokes the authenticated session', async () => {
    const res = await request(makeApp())
      .post('/logout')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(mockPrisma.userSession.update).toHaveBeenCalledWith({ where: { id: 'auth-session' }, data: { revokedAt: expect.any(Date) } })
  })

  it('POST /logout passes database errors to next', async () => {
    mockPrisma.userSession.update.mockRejectedValueOnce(new Error('logout failed'))

    const res = await request(makeApp())
      .post('/logout')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'logout failed' })
  })

  it('GET /me returns the authenticated user', async () => {
    const res = await request(makeApp())
      .get('/me')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ user: { id: 'auth-user', name: 'Auth User', email: 'auth@example.com', status: 'active' } })
  })

  it('GET /me passes database errors to next', async () => {
    mockPrisma.user.findUniqueOrThrow.mockRejectedValueOnce(new Error('me failed'))

    const res = await request(makeApp())
      .get('/me')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'me failed' })
  })
})
