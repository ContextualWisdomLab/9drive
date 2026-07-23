import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: {
      findUnique: vi.fn(),
    },
    connectedAccount: {
      findMany: vi.fn(),
    },
    uploadRoutingPolicy: {
      upsert: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}))

import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { storageRouter } from './storage.routes.js'

const mockPrisma = prisma as unknown as {
  userSession: { findUnique: ReturnType<typeof vi.fn> }
  connectedAccount: { findMany: ReturnType<typeof vi.fn> }
  uploadRoutingPolicy: { upsert: ReturnType<typeof vi.fn> }
  $queryRaw: ReturnType<typeof vi.fn>
}

const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bearer ' + token }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', storageRouter)
  app.use((err: any, req: any, res: any, next: any) => res.status(500).json({ error: err.message }))
  return app
}

describe('storageRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
  })

  it('GET /summary aggregates accounts with storage data', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([
      {
        id: 'account-1',
        provider: 'google_drive',
        email: 'one@example.com',
        status: 'connected',
        storageAccount: {
          totalBytes: 100n,
          usedBytes: 40n,
          availableBytes: 60n,
          lastSyncedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        id: 'account-2',
        provider: 'google_drive',
        email: 'two@example.com',
        status: 'connected',
        storageAccount: {
          totalBytes: 50n,
          usedBytes: 10n,
          availableBytes: 40n,
          lastSyncedAt: null,
        },
      },
    ])

    const res = await request(makeApp())
      .get('/summary')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      totalBytes: '150',
      usedBytes: '50',
      availableBytes: '100',
      accounts: [
        {
          id: 'account-1',
          provider: 'google_drive',
          email: 'one@example.com',
          status: 'connected',
          totalBytes: '100',
          usedBytes: '40',
          availableBytes: '60',
          lastSyncedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'account-2',
          provider: 'google_drive',
          email: 'two@example.com',
          status: 'connected',
          totalBytes: '50',
          usedBytes: '10',
          availableBytes: '40',
          lastSyncedAt: null,
        },
      ],
    })
  })

  it('GET /summary handles accounts without storage data', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([
      {
        id: 'account-1',
        provider: 'google_drive',
        email: 'one@example.com',
        status: 'connected',
        storageAccount: null,
      },
    ])

    const res = await request(makeApp())
      .get('/summary')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      totalBytes: '0',
      usedBytes: '0',
      availableBytes: '0',
      accounts: [
        {
          id: 'account-1',
          provider: 'google_drive',
          email: 'one@example.com',
          status: 'connected',
          totalBytes: null,
          usedBytes: '0',
          availableBytes: null,
          lastSyncedAt: null,
        },
      ],
    })
  })

  it('GET /summary returns empty totals for no accounts', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([])

    const res = await request(makeApp())
      .get('/summary')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ totalBytes: '0', usedBytes: '0', availableBytes: '0', accounts: [] })
  })

  it('GET /summary passes database errors to next', async () => {
    mockPrisma.connectedAccount.findMany.mockRejectedValue(new Error('summary failed'))

    const res = await request(makeApp())
      .get('/summary')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'summary failed' })
  })

  it('GET /routing-policy returns a policy with array priorityAccountIds', async () => {
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValue({
      id: 'policy-1',
      mode: 'priority',
      priorityAccountIds: ['account-1', 'account-2'],
      roundRobinCursor: 3,
    })

    const res = await request(makeApp())
      .get('/routing-policy')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      policy: {
        id: 'policy-1',
        mode: 'priority',
        priorityAccountIds: ['account-1', 'account-2'],
        roundRobinCursor: 3,
      },
    })
    expect(mockPrisma.uploadRoutingPolicy.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: { userId: 'user-1', mode: 'most_available', priorityAccountIds: [] },
      update: {},
    })
  })

  it('GET /routing-policy normalizes non-array priorityAccountIds', async () => {
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValue({
      id: 'policy-1',
      mode: 'most_available',
      priorityAccountIds: 'invalid',
      roundRobinCursor: 0,
    })

    const res = await request(makeApp())
      .get('/routing-policy')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      policy: {
        id: 'policy-1',
        mode: 'most_available',
        priorityAccountIds: [],
        roundRobinCursor: 0,
      },
    })
  })

  it('GET /routing-policy passes database errors to next', async () => {
    mockPrisma.uploadRoutingPolicy.upsert.mockRejectedValue(new Error('policy failed'))

    const res = await request(makeApp())
      .get('/routing-policy')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'policy failed' })
  })

  it('PATCH /routing-policy updates most_available mode without priority ids', async () => {
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValue({
      id: 'policy-1',
      mode: 'most_available',
      priorityAccountIds: [],
      roundRobinCursor: 0,
    })

    const res = await request(makeApp())
      .patch('/routing-policy')
      .set(authHeader)
      .send({ mode: 'most_available' })

    expect(res.status).toBe(200)
    expect(mockPrisma.connectedAccount.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.uploadRoutingPolicy.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: { userId: 'user-1', mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 },
      update: { mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 },
    })
    expect(res.body.policy.mode).toBe('most_available')
  })

  it('PATCH /routing-policy updates round_robin mode and filters valid priority ids', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([{ id: 'account-1' }])
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValue({
      id: 'policy-2',
      mode: 'round_robin',
      priorityAccountIds: ['account-1'],
      roundRobinCursor: 2,
    })

    const res = await request(makeApp())
      .patch('/routing-policy')
      .set(authHeader)
      .send({ mode: 'round_robin', priorityAccountIds: ['account-1', 'account-2', 'account-1'] })

    expect(res.status).toBe(200)
    expect(mockPrisma.connectedAccount.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['account-1', 'account-2'] }, userId: 'user-1', status: 'connected' },
      select: { id: true },
    })
    expect(mockPrisma.uploadRoutingPolicy.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: { userId: 'user-1', mode: 'round_robin', priorityAccountIds: ['account-1'], roundRobinCursor: 0 },
      update: { mode: 'round_robin', priorityAccountIds: ['account-1'] },
    })
    expect(res.body).toEqual({
      policy: {
        id: 'policy-2',
        mode: 'round_robin',
        priorityAccountIds: ['account-1'],
        roundRobinCursor: 2,
      },
    })
  })

  it('PATCH /routing-policy updates priority mode', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([{ id: 'account-3' }])
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValue({
      id: 'policy-3',
      mode: 'priority',
      priorityAccountIds: ['account-3'],
      roundRobinCursor: 0,
    })

    const res = await request(makeApp())
      .patch('/routing-policy')
      .set(authHeader)
      .send({ mode: 'priority', priorityAccountIds: ['account-3'] })

    expect(res.status).toBe(200)
    expect(mockPrisma.uploadRoutingPolicy.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: { userId: 'user-1', mode: 'priority', priorityAccountIds: ['account-3'], roundRobinCursor: 0 },
      update: { mode: 'priority', priorityAccountIds: ['account-3'], roundRobinCursor: 0 },
    })
    expect(res.body.policy.mode).toBe('priority')
  })

  it('PATCH /routing-policy handles validation errors', async () => {
    const res = await request(makeApp())
      .patch('/routing-policy')
      .set(authHeader)
      .send({ mode: 'invalid-mode' })

    expect(res.status).toBe(500)
    expect(mockPrisma.uploadRoutingPolicy.upsert).not.toHaveBeenCalled()
    expect(typeof res.body.error).toBe('string')
  })

  it('PATCH /routing-policy passes database errors to next', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValue([{ id: 'account-1' }])
    mockPrisma.uploadRoutingPolicy.upsert.mockRejectedValue(new Error('update failed'))

    const res = await request(makeApp())
      .patch('/routing-policy')
      .set(authHeader)
      .send({ mode: 'priority', priorityAccountIds: ['account-1'] })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'update failed' })
  })

  it('GET /breakdown returns rows and normalizes null/string/number bytes', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { kind: 'photo', bytes: null },
      { kind: 'video', bytes: 12 },
      { kind: 'document', bytes: '34' },
      { kind: 'other', bytes: 999 },
    ])

    const res = await request(makeApp())
      .get('/breakdown')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ photo: '0', video: '12', document: '34' })
  })

  it('GET /breakdown returns zeroes for empty rows', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([])

    const res = await request(makeApp())
      .get('/breakdown')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ photo: '0', video: '0', document: '0' })
  })

  it('GET /breakdown passes database errors to next', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('breakdown failed'))

    const res = await request(makeApp())
      .get('/breakdown')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'breakdown failed' })
  })
})
