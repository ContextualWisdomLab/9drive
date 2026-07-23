import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: {
      findUnique: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { auditLogRouter } from './audit-log.routes.js'

const mockPrisma = prisma as unknown as {
  userSession: { findUnique: ReturnType<typeof vi.fn> }
  auditLog: { findMany: ReturnType<typeof vi.fn> }
}

const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bearer ' + token }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', auditLogRouter)
  app.use((err: any, req: any, res: any, next: any) => res.status(500).json({ error: err.message }))
  return app
}

describe('auditLogRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
  })

  it('returns 401 without an access token', async () => {
    const res = await request(makeApp()).get('/')

    expect(res.status).toBe(401)
    expect(res.body).toEqual(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled()
  })

  it('returns logs for the authenticated user', async () => {
    const logs = [{ id: 'log-1', action: 'file.created', createdAt: '2026-01-01T00:00:00.000Z' }]
    mockPrisma.auditLog.findMany.mockResolvedValue(logs)

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ logs })
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  })

  it('passes database errors to next', async () => {
    mockPrisma.auditLog.findMany.mockRejectedValue(new Error('db error'))

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'db error' })
  })
})
