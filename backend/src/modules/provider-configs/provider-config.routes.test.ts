import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: {
      findUnique: vi.fn(),
    },
    providerConfig: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

vi.mock('../../utils/crypto.js', () => ({
  encryptText: vi.fn((value: string) => `encrypted:${value}`),
}))

import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { encryptText } from '../../utils/crypto.js'
import { providerConfigRouter } from './provider-config.routes.js'

const mockPrisma = prisma as unknown as {
  userSession: { findUnique: ReturnType<typeof vi.fn> }
  providerConfig: {
    create: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    deleteMany: ReturnType<typeof vi.fn>
  }
}

const mockEncryptText = vi.mocked(encryptText)
const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bearer ' + token }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', providerConfigRouter)
  app.use((err: any, req: any, res: any, next: any) => res.status(500).json({ error: err.message }))
  return app
}

describe('providerConfigRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
  })

  it('POST /google creates a provider config', async () => {
    mockPrisma.providerConfig.create.mockResolvedValue({
      id: 'config-1',
      provider: 'google_drive',
      redirectUri: 'https://example.com/callback',
      scopes: ['scope-1'],
      status: 'active',
    })

    const res = await request(makeApp())
      .post('/google')
      .set(authHeader)
      .send({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://example.com/callback',
        scopes: ['scope-1'],
      })

    expect(res.status).toBe(201)
    expect(mockEncryptText).toHaveBeenNthCalledWith(1, 'client-id')
    expect(mockEncryptText).toHaveBeenNthCalledWith(2, 'client-secret')
    expect(mockPrisma.providerConfig.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        provider: 'google_drive',
        clientIdEncrypted: 'encrypted:client-id',
        clientSecretEncrypted: 'encrypted:client-secret',
        redirectUri: 'https://example.com/callback',
        scopes: ['scope-1'],
      },
    })
    expect(res.body).toEqual({
      id: 'config-1',
      provider: 'google_drive',
      redirectUri: 'https://example.com/callback',
      scopes: ['scope-1'],
      status: 'active',
    })
  })

  it('POST /google handles validation errors', async () => {
    const res = await request(makeApp())
      .post('/google')
      .set(authHeader)
      .send({ clientId: '', clientSecret: '', redirectUri: 'bad-url', scopes: [] })

    expect(res.status).toBe(500)
    expect(mockPrisma.providerConfig.create).not.toHaveBeenCalled()
    expect(typeof res.body.error).toBe('string')
  })

  it('POST /google passes database errors to next', async () => {
    mockPrisma.providerConfig.create.mockRejectedValue(new Error('db error'))

    const res = await request(makeApp())
      .post('/google')
      .set(authHeader)
      .send({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://example.com/callback',
        scopes: ['scope-1'],
      })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'db error' })
  })

  it('GET / returns configs', async () => {
    const configs = [{
      id: 'config-1',
      provider: 'google_drive',
      redirectUri: 'https://example.com/callback',
      scopes: ['scope-1'],
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }]
    mockPrisma.providerConfig.findMany.mockResolvedValue(configs)

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ configs: [{ ...configs[0], createdAt: '2026-01-01T00:00:00.000Z' }] })
    expect(mockPrisma.providerConfig.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { id: true, provider: true, redirectUri: true, scopes: true, status: true, createdAt: true },
    })
  })

  it('GET / passes database errors to next', async () => {
    mockPrisma.providerConfig.findMany.mockRejectedValue(new Error('find failed'))

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'find failed' })
  })

  it('DELETE /:id deletes the provider config', async () => {
    mockPrisma.providerConfig.deleteMany.mockResolvedValue({ count: 1 })

    const res = await request(makeApp())
      .delete('/config-1')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(mockPrisma.providerConfig.deleteMany).toHaveBeenCalledWith({ where: { id: 'config-1', userId: 'user-1' } })
  })

  it('DELETE /:id passes database errors to next', async () => {
    mockPrisma.providerConfig.deleteMany.mockRejectedValue(new Error('delete failed'))

    const res = await request(makeApp())
      .delete('/config-1')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'delete failed' })
  })
})
