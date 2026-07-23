import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: {
      findUnique: vi.fn(),
    },
    apiKey: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

vi.mock('../../utils/crypto.js', () => ({
  randomToken: vi.fn(() => 'abcdefghijklmnopqrstuvwxyz123456'),
  hashToken: vi.fn((value: string) => `hashed:${value}`),
}))

import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { apiKeyRouter } from './api-key.routes.js'

const mockPrisma = prisma as unknown as {
  userSession: { findUnique: ReturnType<typeof vi.fn> }
  apiKey: {
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
}

const mockHashToken = vi.mocked(hashToken)
const mockRandomToken = vi.mocked(randomToken)
const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bearer ' + token }

function makeApiKey(overrides: Partial<any> = {}) {
  return {
    id: 'key-1',
    name: 'Primary key',
    keyPrefix: '9d_live_abcdefgh',
    scopes: ['files:upload'],
    status: 'active',
    lastUsedAt: new Date('2026-01-02T00:00:00.000Z'),
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', apiKeyRouter)
  app.use((err: any, req: any, res: any, next: any) => res.status(500).json({ error: err.message }))
  return app
}

describe('apiKeyRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
  })

  it('GET / returns serialized api keys and normalizes non-array scopes', async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([
      makeApiKey({
        id: 'key-1',
        scopes: 'invalid-scopes',
        lastUsedAt: null,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        revokedAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      makeApiKey({ id: 'key-2', name: 'Second key' }),
    ])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      apiKeys: [
        {
          id: 'key-1',
          name: 'Primary key',
          keyPrefix: '9d_live_abcdefgh',
          scopes: [],
          status: 'active',
          lastUsedAt: null,
          expiresAt: '2026-02-01T00:00:00.000Z',
          revokedAt: '2026-03-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'key-2',
          name: 'Second key',
          keyPrefix: '9d_live_abcdefgh',
          scopes: ['files:upload'],
          status: 'active',
          lastUsedAt: '2026-01-02T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith({ where: { userId: 'user-1' }, orderBy: { createdAt: 'desc' } })
  })

  it('GET / passes database errors to next', async () => {
    mockPrisma.apiKey.findMany.mockRejectedValue(new Error('db error'))

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'db error' })
  })

  it('POST / creates an api key without expiry', async () => {
    const created = makeApiKey({ keyPrefix: '9d_live_abcdefgh' })
    mockPrisma.apiKey.create.mockResolvedValue(created)

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: '  Upload key  ' })

    expect(res.status).toBe(201)
    expect(mockRandomToken).toHaveBeenCalledWith(32)
    expect(mockHashToken).toHaveBeenCalledWith('9d_live_abcdefghijklmnopqrstuvwxyz123456')
    expect(mockPrisma.apiKey.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        name: 'Upload key',
        keyPrefix: '9d_live_abcdefgh',
        keyHash: 'hashed:9d_live_abcdefghijklmnopqrstuvwxyz123456',
        scopes: ['files:upload'],
        expiresAt: null,
      },
    })
    expect(res.body).toEqual({
      apiKey: {
        id: 'key-1',
        name: 'Primary key',
        keyPrefix: '9d_live_abcdefgh',
        scopes: ['files:upload'],
        status: 'active',
        lastUsedAt: '2026-01-02T00:00:00.000Z',
        expiresAt: null,
        revokedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      secret: '9d_live_abcdefghijklmnopqrstuvwxyz123456',
    })
  })

  it('POST / creates an api key with expiry', async () => {
    const created = makeApiKey({ expiresAt: new Date('2026-05-01T12:00:00.000Z') })
    mockPrisma.apiKey.create.mockResolvedValue(created)

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Expires soon', expiresAt: '2026-05-01T12:00:00.000Z' })

    expect(res.status).toBe(201)
    expect(mockPrisma.apiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        expiresAt: new Date('2026-05-01T12:00:00.000Z'),
      }),
    })
    expect(res.body.apiKey.expiresAt).toBe('2026-05-01T12:00:00.000Z')
  })

  it('POST / handles validation errors', async () => {
    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: '', expiresAt: 'not-a-date' })

    expect(res.status).toBe(500)
    expect(mockPrisma.apiKey.create).not.toHaveBeenCalled()
    expect(typeof res.body.error).toBe('string')
  })

  it('POST / passes database errors to next', async () => {
    mockPrisma.apiKey.create.mockRejectedValue(new Error('create failed'))

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Upload key' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'create failed' })
  })

  it('DELETE /:id revokes the key', async () => {
    mockPrisma.apiKey.updateMany.mockResolvedValue({ count: 1 })

    const res = await request(makeApp())
      .delete('/key-99')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(mockPrisma.apiKey.updateMany).toHaveBeenCalledWith({
      where: { id: 'key-99', userId: 'user-1', revokedAt: null },
      data: { status: 'revoked', revokedAt: expect.any(Date) },
    })
  })

  it('DELETE /:id passes database errors to next', async () => {
    mockPrisma.apiKey.updateMany.mockRejectedValue(new Error('revoke failed'))

    const res = await request(makeApp())
      .delete('/key-99')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'revoke failed' })
  })
})
