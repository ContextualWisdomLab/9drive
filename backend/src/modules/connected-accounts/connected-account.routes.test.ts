import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const oauthMocks = vi.hoisted(() => ({
  generateAuthUrl: vi.fn(),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
  userinfoGet: vi.fn(),
}))

vi.mock('../../config/env.js', () => ({
  env: {
    DATABASE_URL: 'mysql://localhost/test',
    APP_PORT: 4000,
    FRONTEND_URL: 'https://frontend.example.com',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    TOKEN_ENCRYPTION_KEY: 'y'.repeat(32),
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_DAYS: 30,
    MAX_UPLOAD_BYTES: 1024,
  },
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: { findUnique: vi.fn() },
    connectedAccount: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      upsert: vi.fn(),
      findFirstOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    providerConfig: { findFirstOrThrow: vi.fn() },
    oauthState: { create: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    s3StorageConfig: { upsert: vi.fn() },
    user: { upsert: vi.fn() },
    authHandoff: { create: vi.fn() },
  },
}))

vi.mock('../../utils/crypto.js', () => ({
  decryptText: vi.fn((value: string) => `decrypted:${value}`),
  encryptText: vi.fn((value: string) => `encrypted:${value}`),
  hashToken: vi.fn((value: string) => `hashed:${value}`),
  randomToken: vi.fn(),
}))

vi.mock('../../utils/password.js', () => ({
  hashPassword: vi.fn(),
}))

vi.mock('../google/google.service.js', () => ({
  createOAuthClient: vi.fn().mockReturnValue({
    generateAuthUrl: oauthMocks.generateAuthUrl,
    getToken: oauthMocks.getToken,
    setCredentials: oauthMocks.setCredentials,
  }),
  syncGoogleQuota: vi.fn(),
}))

vi.mock('../s3/s3.service.js', () => ({
  testS3Connection: vi.fn(),
  syncS3Quota: vi.fn(),
}))

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn() },
    oauth2: vi.fn().mockReturnValue({
      userinfo: { get: oauthMocks.userinfoGet },
    }),
  },
}))

import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { hashPassword } from '../../utils/password.js'
import { signAccessToken } from '../../utils/jwt.js'
import { connectedAccountRouter } from './connected-account.routes.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
import { syncS3Quota, testS3Connection } from '../s3/s3.service.js'

const mockPrisma = prisma as any
const mockEncryptText = vi.mocked(encryptText)
const mockHashToken = vi.mocked(hashToken)
const mockRandomToken = vi.mocked(randomToken)
const mockHashPassword = vi.mocked(hashPassword)
const mockCreateOAuthClient = vi.mocked(createOAuthClient)
const mockSyncGoogleQuota = vi.mocked(syncGoogleQuota)
const mockSyncS3Quota = vi.mocked(syncS3Quota)
const mockTestS3Connection = vi.mocked(testS3Connection)
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bearer ' + token }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', connectedAccountRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }))
  return app
}

function makeStorageAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'storage-1',
    totalBytes: 100n,
    usedBytes: 40n,
    availableBytes: 60n,
    trashBytes: 5n,
    lastSyncedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    userId: 'user-1',
    provider: 'google_drive',
    providerAccountId: 'provider-account-1',
    providerConfigId: 'config-1',
    email: 'user@example.com',
    displayName: 'Drive Account',
    accessTokenEncrypted: 'encrypted:access',
    refreshTokenEncrypted: 'encrypted:refresh',
    status: 'connected',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    storageAccount: makeStorageAccount(),
    ...overrides,
  }
}

describe('connectedAccountRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
    mockRandomToken.mockReturnValue('random-token')
    mockHashPassword.mockResolvedValue('hashed-password')
    oauthMocks.generateAuthUrl.mockReturnValue('https://oauth-url')
    oauthMocks.getToken.mockResolvedValue({ tokens: { access_token: 'access-token', refresh_token: 'refresh-token', expiry_date: Date.now() + 3600_000 } })
    oauthMocks.setCredentials.mockImplementation(() => undefined)
    oauthMocks.userinfoGet.mockResolvedValue({ data: { id: 'provider-account-1', email: 'google@example.com', name: 'Google User', picture: 'https://avatar.example.com/user.png' } })
    mockSyncGoogleQuota.mockResolvedValue({ id: 'quota-google', totalBytes: null, usedBytes: 0n, availableBytes: null, trashBytes: null } as any)
    mockSyncS3Quota.mockResolvedValue({ id: 'quota-s3', totalBytes: null, usedBytes: 0n, availableBytes: null, trashBytes: null } as any)
    mockTestS3Connection.mockResolvedValue(undefined)
  })

  it('GET / returns connected accounts without auto-sync when quotas are already synced', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([
      makeAccount(),
      makeAccount({ id: 'account-2', provider: 's3', email: 'bucket (S3)', storageAccount: makeStorageAccount({ usedBytes: 10n }) }),
    ])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body.accounts).toEqual([
      expect.objectContaining({ id: 'account-1', email: 'user@example.com' }),
      expect.objectContaining({ id: 'account-2', email: 'bucket (S3)' }),
    ])
    expect(res.body.accounts[0].storageAccount).toEqual({
      id: 'storage-1',
      totalBytes: '100',
      usedBytes: '40',
      availableBytes: '60',
      trashBytes: '5',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(res.body.accounts[0].accessTokenEncrypted).toBeUndefined()
    expect(mockSyncGoogleQuota).not.toHaveBeenCalled()
    expect(mockSyncS3Quota).not.toHaveBeenCalled()
  })

  it('GET / auto-syncs accounts missing quota timestamps and re-fetches', async () => {
    mockPrisma.connectedAccount.findMany
      .mockResolvedValueOnce([
        makeAccount({ id: 'google-missing', storageAccount: makeStorageAccount({ lastSyncedAt: null }) }),
        makeAccount({ id: 's3-missing', provider: 's3', storageAccount: makeStorageAccount({ lastSyncedAt: null }) }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'google-missing', storageAccount: makeStorageAccount({ lastSyncedAt: new Date('2026-01-02T00:00:00.000Z') }) }),
        makeAccount({ id: 's3-missing', provider: 's3', storageAccount: makeStorageAccount({ usedBytes: 7n, lastSyncedAt: new Date('2026-01-02T00:00:00.000Z') }) }),
      ])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('google-missing')
    expect(mockSyncS3Quota).toHaveBeenCalledWith('s3-missing')
    expect(mockPrisma.connectedAccount.findMany).toHaveBeenCalledTimes(2)
  })

  it('GET / returns an empty list when no accounts exist', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accounts: [] })
  })

  it('GET / serializes null storage values and null storage accounts', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([
      makeAccount({ id: 'null-storage-values', storageAccount: makeStorageAccount({ totalBytes: null, availableBytes: null, trashBytes: null }) }),
      makeAccount({ id: 'no-storage-account', storageAccount: null }),
    ])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body.accounts[0].storageAccount).toEqual({
      id: 'storage-1',
      totalBytes: null,
      usedBytes: '40',
      availableBytes: null,
      trashBytes: null,
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(res.body.accounts[1].storageAccount).toBeNull()
  })

  it('GET / passes list errors to next', async () => {
    mockPrisma.connectedAccount.findMany.mockRejectedValueOnce(new Error('accounts failed'))

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'accounts failed' })
  })

  it('POST /s3 creates a new S3 account, validates it, syncs quota and returns 201', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockResolvedValue({ id: 'config-1' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null)
    mockPrisma.connectedAccount.create.mockResolvedValue(makeAccount({ id: 's3-account', provider: 's3', email: 'bucket-a (S3)', displayName: 'Backups', storageAccount: undefined }))
    mockPrisma.s3StorageConfig.upsert.mockResolvedValue({ id: 's3-config-1', connectedAccountId: 's3-account' })
    mockSyncS3Quota.mockResolvedValueOnce({ id: 'quota-s3', totalBytes: 500n, usedBytes: 10n, availableBytes: 490n, trashBytes: 0n } as any)

    const res = await request(makeApp())
      .post('/s3')
      .set(authHeader)
      .send({
        name: 'Backups',
        bucket: 'bucket-a',
        region: 'us-east-1',
        endpoint: '',
        accessKeyId: 'key-id',
        secretAccessKey: 'secret-key',
        quotaBytes: '500',
      })

    expect(res.status).toBe(201)
    expect(mockPrisma.connectedAccount.create).toHaveBeenCalled()
    expect(mockTestS3Connection).toHaveBeenCalledWith(expect.objectContaining({ connectedAccountId: 's3-account' }))
    expect(mockSyncS3Quota).toHaveBeenCalledWith('s3-account')
    expect(res.body.account.storageAccount).toEqual({
      id: 'quota-s3',
      totalBytes: '500',
      usedBytes: '10',
      availableBytes: '490',
      trashBytes: '0',
    })
    expect(mockEncryptText).toHaveBeenCalledWith('s3')
    expect(mockPrisma.connectedAccount.delete).not.toHaveBeenCalled()
  })

  it('POST /s3 deletes a newly created account when connection testing fails', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockResolvedValue({ id: 'config-1' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null)
    mockPrisma.connectedAccount.create.mockResolvedValue(makeAccount({ id: 'new-s3-account', provider: 's3', email: 'bucket-b (S3)', storageAccount: undefined }))
    mockPrisma.s3StorageConfig.upsert.mockResolvedValue({ id: 's3-config-2', connectedAccountId: 'new-s3-account' })
    mockTestS3Connection.mockRejectedValueOnce(new Error('bad s3 credentials'))
    mockPrisma.connectedAccount.delete.mockResolvedValue({})

    const res = await request(makeApp())
      .post('/s3')
      .set(authHeader)
      .send({
        name: 'Broken',
        bucket: 'bucket-b',
        region: 'us-east-1',
        endpoint: '',
        accessKeyId: 'key-id',
        secretAccessKey: 'secret-key',
      })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'bad s3 credentials' })
    expect(mockPrisma.connectedAccount.delete).toHaveBeenCalledWith({ where: { id: 'new-s3-account' } })
  })

  it('POST /s3 returns null quota fields when the synced quota omits them', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockResolvedValue({ id: 'config-1' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null)
    mockPrisma.connectedAccount.create.mockResolvedValue(makeAccount({ id: 's3-null-quota', provider: 's3', email: 'bucket-null (S3)', storageAccount: undefined }))
    mockPrisma.s3StorageConfig.upsert.mockResolvedValue({ id: 's3-config-null', connectedAccountId: 's3-null-quota' })
    mockSyncS3Quota.mockResolvedValueOnce({ id: 'quota-null', totalBytes: null, usedBytes: 0n, availableBytes: null, trashBytes: null } as any)

    const res = await request(makeApp())
      .post('/s3')
      .set(authHeader)
      .send({
        name: 'Null Quota',
        bucket: 'bucket-null',
        region: 'us-east-1',
        endpoint: '',
        accessKeyId: 'key-id',
        secretAccessKey: 'secret-key',
      })

    expect(res.status).toBe(201)
    expect(res.body.account.storageAccount).toEqual({
      id: 'quota-null',
      totalBytes: null,
      usedBytes: '0',
      availableBytes: null,
      trashBytes: null,
    })
  })

  it('POST /s3 does not delete an existing account when the updated connection test fails', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockResolvedValue({ id: 'config-1' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue({ id: 'existing-s3-account' })
    mockPrisma.connectedAccount.update.mockResolvedValue(makeAccount({ id: 'existing-s3-account', provider: 's3', email: 'bucket-c (S3)', storageAccount: undefined }))
    mockPrisma.s3StorageConfig.upsert.mockResolvedValue({ id: 's3-config-3', connectedAccountId: 'existing-s3-account' })
    mockTestS3Connection.mockRejectedValueOnce(new Error('still broken'))

    const res = await request(makeApp())
      .post('/s3')
      .set(authHeader)
      .send({
        name: 'Updated',
        bucket: 'bucket-c',
        region: 'us-east-1',
        endpoint: 'https://s3.example.com',
        accessKeyId: 'key-id',
        secretAccessKey: 'secret-key',
      })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'still broken' })
    expect(mockPrisma.connectedAccount.delete).not.toHaveBeenCalled()
  })

  it('POST /s3 passes validation errors to next', async () => {
    const res = await request(makeApp())
      .post('/s3')
      .set(authHeader)
      .send({ name: '', bucket: '', region: '', accessKeyId: '', secretAccessKey: '' })

    expect(res.status).toBe(500)
    expect(mockPrisma.providerConfig.findFirstOrThrow).not.toHaveBeenCalled()
    expect(typeof res.body.error).toBe('string')
  })

  it('POST /s3 passes missing provider config errors to next', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockRejectedValueOnce(new Error('provider config missing'))

    const res = await request(makeApp())
      .post('/s3')
      .set(authHeader)
      .send({
        name: 'Backups',
        bucket: 'bucket-a',
        region: 'us-east-1',
        endpoint: '',
        accessKeyId: 'key-id',
        secretAccessKey: 'secret-key',
      })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'provider config missing' })
  })

  it('GET /google/connect-url uses a specific providerConfigId when provided', async () => {
    mockRandomToken.mockReturnValueOnce('connect-state-token')
    mockPrisma.providerConfig.findFirstOrThrow.mockResolvedValue({ id: 'config-specific', scopes: ['scope-a'] })
    mockPrisma.oauthState.create.mockResolvedValue({})

    const res = await request(makeApp())
      .get('/google/connect-url?providerConfigId=config-specific')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ url: 'https://oauth-url' })
    expect(mockPrisma.providerConfig.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 'config-specific', OR: [{ userId: 'user-1' }, { userId: null }], provider: 'google_drive', status: 'active' },
    })
    expect(mockPrisma.oauthState.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', providerConfigId: 'config-specific', flow: 'connect', stateHash: 'hashed:connect-state-token' }),
    })
    expect(oauthMocks.generateAuthUrl).toHaveBeenCalledWith(expect.objectContaining({ state: 'connect-state-token', scope: ['scope-a'] }))
  })

  it('GET /google/connect-url falls back to the latest global provider config', async () => {
    mockRandomToken.mockReturnValueOnce('global-state-token')
    mockPrisma.providerConfig.findFirstOrThrow.mockResolvedValue({ id: 'config-global', scopes: ['scope-b'] })
    mockPrisma.oauthState.create.mockResolvedValue({})

    const res = await request(makeApp())
      .get('/google/connect-url')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockPrisma.providerConfig.findFirstOrThrow).toHaveBeenCalledWith({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
  })

  it('GET /google/connect-url passes errors to next', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockRejectedValueOnce(new Error('connect url failed'))

    const res = await request(makeApp())
      .get('/google/connect-url')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'connect url failed' })
  })

  it('GET /google/connect redirects to the generated URL', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockResolvedValue({ id: 'config-global', scopes: ['scope-b'] })
    mockPrisma.oauthState.create.mockResolvedValue({})

    const res = await request(makeApp())
      .get('/google/connect')
      .set(authHeader)

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://oauth-url')
  })

  it('GET /google/connect passes errors to next', async () => {
    mockPrisma.providerConfig.findFirstOrThrow.mockRejectedValueOnce(new Error('connect redirect failed'))

    const res = await request(makeApp())
      .get('/google/connect')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'connect redirect failed' })
  })

  it('GET /google/callback connects a Google Drive account in connect flow', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-1',
      flow: 'connect',
      userId: 'user-1',
      user: { id: 'user-1' },
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null)
    mockPrisma.connectedAccount.upsert.mockResolvedValue(makeAccount({ id: 'connected-google', email: 'google@example.com' }))
    mockPrisma.oauthState.update.mockResolvedValue({})

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=oauth-state-token')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${env.FRONTEND_URL}/google-connected?status=success`)
    expect(mockHashToken).toHaveBeenCalledWith('oauth-state-token')
    expect(oauthMocks.getToken).toHaveBeenCalledWith('oauth-code')
    expect(oauthMocks.setCredentials).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'access-token' }))
    expect(mockPrisma.connectedAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_provider_providerAccountId: { userId: 'user-1', provider: 'google_drive', providerAccountId: 'provider-account-1' } },
    }))
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('connected-google')
  })

  it('GET /google/callback returns 400 for a used or expired oauth state', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-2',
      flow: 'connect',
      userId: 'user-1',
      providerConfigId: 'config-1',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=stale-state')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
  })

  it('GET /google/callback returns 400 when Google does not return an access token', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-3',
      flow: 'connect',
      userId: 'user-1',
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    oauthMocks.getToken.mockResolvedValueOnce({ tokens: { refresh_token: 'refresh-only' } })

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=no-access-token')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })
  })

  it('GET /google/callback returns 400 when Google profile data is incomplete', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-4',
      flow: 'connect',
      userId: 'user-1',
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    oauthMocks.userinfoGet.mockResolvedValueOnce({ data: { id: '', email: '' } })

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=bad-profile')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'GOOGLE_PROFILE_FAILED', message: 'Google profile missing id or email.' })
  })

  it('GET /google/callback returns 400 in connect flow when no refresh token exists anywhere', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-5',
      flow: 'connect',
      userId: 'user-1',
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    oauthMocks.getToken.mockResolvedValueOnce({ tokens: { access_token: 'access-token' } })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null)

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=missing-refresh')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'GOOGLE_OAUTH_FAILED', message: 'Google did not return required tokens.' })
  })

  it('GET /google/callback completes login flow and redirects with a handoff token', async () => {
    mockRandomToken
      .mockReturnValueOnce('generated-password-token')
      .mockReturnValueOnce('handoff-token')
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-6',
      flow: 'login',
      userId: null,
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    mockPrisma.user.upsert.mockResolvedValue({ id: 'user-42', email: 'google@example.com', name: 'Google User' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null)
    mockPrisma.connectedAccount.upsert.mockResolvedValue(makeAccount({ id: 'login-google', userId: 'user-42', email: 'google@example.com' }))
    mockPrisma.oauthState.update.mockResolvedValue({})
    mockPrisma.authHandoff.create.mockResolvedValue({})

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=login-state')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${env.FRONTEND_URL}/google-auth?token=handoff-token`)
    expect(mockHashPassword).toHaveBeenCalledWith('generated-password-token')
    expect(mockPrisma.user.upsert).toHaveBeenCalledWith({
      where: { email: 'google@example.com' },
      create: { email: 'google@example.com', name: 'Google User', passwordHash: 'hashed-password' },
      update: { name: 'Google User' },
    })
    expect(mockPrisma.authHandoff.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-42', tokenHash: 'hashed:handoff-token' }),
    })
  })

  it('GET /google/callback uses email fallback, existing refresh token and default expiry in login flow', async () => {
    mockRandomToken
      .mockReturnValueOnce('generated-password-token')
      .mockReturnValueOnce('handoff-token-2')
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-6b',
      flow: 'login',
      userId: null,
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    mockPrisma.user.upsert.mockResolvedValue({ id: 'user-43', email: 'alias@example.com', name: 'alias' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue({ refreshTokenEncrypted: 'encrypted:existing-refresh' })
    mockPrisma.connectedAccount.upsert.mockResolvedValue(makeAccount({ id: 'login-google-2', userId: 'user-43', email: 'alias@example.com' }))
    mockPrisma.oauthState.update.mockResolvedValue({})
    mockPrisma.authHandoff.create.mockResolvedValue({})
    oauthMocks.getToken.mockResolvedValueOnce({ tokens: { access_token: 'access-token' } })
    oauthMocks.userinfoGet.mockResolvedValueOnce({ data: { id: 'provider-account-2', email: 'alias@example.com', name: '', picture: 'https://avatar.example.com/user2.png' } })

    const before = Date.now()
    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=login-fallbacks')
    const after = Date.now()

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${env.FRONTEND_URL}/google-auth?token=handoff-token-2`)
    expect(mockPrisma.user.upsert).toHaveBeenCalledWith({
      where: { email: 'alias@example.com' },
      create: { email: 'alias@example.com', name: 'alias', passwordHash: 'hashed-password' },
      update: { name: 'alias' },
    })
    const loginUpsert = mockPrisma.connectedAccount.upsert.mock.calls.at(-1)?.[0]
    expect(loginUpsert.create.refreshTokenEncrypted).toBe('encrypted:existing-refresh')
    expect(loginUpsert.update.refreshTokenEncrypted).toBe('encrypted:existing-refresh')
    expect(loginUpsert.create.tokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(loginUpsert.create.tokenExpiresAt.getTime()).toBeLessThanOrEqual(after + 3600_000)
    expect(loginUpsert.update.tokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(loginUpsert.update.tokenExpiresAt.getTime()).toBeLessThanOrEqual(after + 3600_000)
  })

  it('GET /google/callback falls back to the generic Google User name when the profile name is absent', async () => {
    mockRandomToken
      .mockReturnValueOnce('generated-password-token')
      .mockReturnValueOnce('handoff-token-3')
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-6c',
      flow: 'login',
      userId: null,
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    mockPrisma.user.upsert.mockResolvedValue({ id: 'user-44', email: '@example.com', name: 'Google User' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue({ refreshTokenEncrypted: 'encrypted:existing-refresh' })
    mockPrisma.connectedAccount.upsert.mockResolvedValue(makeAccount({ id: 'login-google-3', userId: 'user-44', email: '@example.com' }))
    mockPrisma.oauthState.update.mockResolvedValue({})
    mockPrisma.authHandoff.create.mockResolvedValue({})
    oauthMocks.getToken.mockResolvedValueOnce({ tokens: { access_token: 'access-token' } })
    oauthMocks.userinfoGet.mockResolvedValueOnce({ data: { id: 'provider-account-3', email: '@example.com', name: '', picture: 'https://avatar.example.com/user3.png' } })

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=login-generic-name')

    expect(res.status).toBe(302)
    expect(mockPrisma.user.upsert).toHaveBeenCalledWith({
      where: { email: '@example.com' },
      create: { email: '@example.com', name: 'Google User', passwordHash: 'hashed-password' },
      update: { name: 'Google User' },
    })
  })

  it('GET /google/callback redirects to frontend error in login flow when refresh token is unavailable', async () => {
    mockRandomToken.mockReturnValueOnce('generated-password-token')
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-7',
      flow: 'login',
      userId: null,
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    mockPrisma.user.upsert.mockResolvedValue({ id: 'user-99', email: 'google@example.com', name: 'Google User' })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue(null)
    oauthMocks.getToken.mockResolvedValueOnce({ tokens: { access_token: 'access-token' } })

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=login-missing-refresh')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${env.FRONTEND_URL}/google-auth?status=error`)
    expect(consoleErrorSpy).toHaveBeenCalledWith('Google login failed: no refresh token received and no existing account. Has refresh_token:', false)
    expect(mockPrisma.connectedAccount.upsert).not.toHaveBeenCalled()
  })

  it('GET /google/callback returns 400 for unsupported oauth flows', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-8',
      flow: 'something-else',
      userId: null,
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=bad-flow')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'GOOGLE_OAUTH_STATE_INVALID', message: 'OAuth state expired.' })
  })

  it('GET /google/callback reuses an existing refresh token and default expiry in connect flow', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockResolvedValue({
      id: 'oauth-state-8b',
      flow: 'connect',
      userId: 'user-1',
      providerConfigId: 'config-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      providerConfig: { id: 'config-1', scopes: ['scope-1'] },
    })
    mockPrisma.connectedAccount.findUnique.mockResolvedValue({ refreshTokenEncrypted: 'encrypted:existing-refresh' })
    mockPrisma.connectedAccount.upsert.mockResolvedValue(makeAccount({ id: 'connected-google-2', email: 'google@example.com' }))
    mockPrisma.oauthState.update.mockResolvedValue({})
    oauthMocks.getToken.mockResolvedValueOnce({ tokens: { access_token: 'access-token' } })

    const before = Date.now()
    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=connect-fallbacks')
    const after = Date.now()

    expect(res.status).toBe(302)
    const connectUpsert = mockPrisma.connectedAccount.upsert.mock.calls.at(-1)?.[0]
    expect(connectUpsert.create.refreshTokenEncrypted).toBe('encrypted:existing-refresh')
    expect(connectUpsert.update.refreshTokenEncrypted).toBe('encrypted:existing-refresh')
    expect(connectUpsert.create.tokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(connectUpsert.create.tokenExpiresAt.getTime()).toBeLessThanOrEqual(after + 3600_000)
    expect(connectUpsert.update.tokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(connectUpsert.update.tokenExpiresAt.getTime()).toBeLessThanOrEqual(after + 3600_000)
  })

  it('GET /google/callback redirects to frontend error on exceptions', async () => {
    mockPrisma.oauthState.findUniqueOrThrow.mockRejectedValueOnce(new Error('oauth exploded'))

    const res = await request(makeApp())
      .get('/google/callback?code=oauth-code&state=boom')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${env.FRONTEND_URL}/google-connected?status=error`)
    expect(consoleErrorSpy).toHaveBeenCalledWith('Google OAuth callback failed:', expect.any(Error))
  })

  it('POST /:id/sync-quota syncs a Google Drive account', async () => {
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount({ id: 'google-account', provider: 'google_drive' }))
    mockSyncGoogleQuota.mockResolvedValueOnce({ id: 'quota-google-1', totalBytes: 300n, usedBytes: 10n, availableBytes: 290n, trashBytes: 0n } as any)

    const res = await request(makeApp())
      .post('/google-account/sync-quota')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('google-account')
    expect(res.body.quota).toEqual({
      id: 'quota-google-1',
      totalBytes: '300',
      usedBytes: '10',
      availableBytes: '290',
      trashBytes: '0',
    })
  })

  it('POST /:id/sync-quota syncs an S3 account', async () => {
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount({ id: 's3-account-sync', provider: 's3' }))
    mockSyncS3Quota.mockResolvedValueOnce({ id: 'quota-s3-1', totalBytes: 200n, usedBytes: 20n, availableBytes: 180n, trashBytes: 1n } as any)

    const res = await request(makeApp())
      .post('/s3-account-sync/sync-quota')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockSyncS3Quota).toHaveBeenCalledWith('s3-account-sync')
    expect(res.body.quota).toEqual({
      id: 'quota-s3-1',
      totalBytes: '200',
      usedBytes: '20',
      availableBytes: '180',
      trashBytes: '1',
    })
  })

  it('POST /:id/sync-quota serializes null quota values', async () => {
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount({ id: 'google-null-quota', provider: 'google_drive' }))
    mockSyncGoogleQuota.mockResolvedValueOnce({ id: 'quota-google-null', totalBytes: null, usedBytes: 0n, availableBytes: null, trashBytes: null } as any)

    const res = await request(makeApp())
      .post('/google-null-quota/sync-quota')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body.quota).toEqual({
      id: 'quota-google-null',
      totalBytes: null,
      usedBytes: '0',
      availableBytes: null,
      trashBytes: null,
    })
  })

  it('POST /:id/sync-quota passes errors to next', async () => {
    mockPrisma.connectedAccount.findFirstOrThrow.mockRejectedValueOnce(new Error('quota failed'))

    const res = await request(makeApp())
      .post('/missing-account/sync-quota')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'quota failed' })
  })

  it('DELETE /:id disconnects an account', async () => {
    mockPrisma.connectedAccount.updateMany.mockResolvedValue({ count: 1 })

    const res = await request(makeApp())
      .delete('/account-1')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(mockPrisma.connectedAccount.updateMany).toHaveBeenCalledWith({ where: { id: 'account-1', userId: 'user-1' }, data: { status: 'disconnected' } })
  })

  it('DELETE /:id passes errors to next', async () => {
    mockPrisma.connectedAccount.updateMany.mockRejectedValueOnce(new Error('disconnect failed'))

    const res = await request(makeApp())
      .delete('/account-1')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'disconnect failed' })
  })

  it('wires the OAuth client factory mock', () => {
    expect(mockCreateOAuthClient).toBeDefined()
  })
})
