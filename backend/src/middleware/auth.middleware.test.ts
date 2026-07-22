import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Response } from 'express'

vi.mock('../config/prisma.js', () => ({
  prisma: {
    userSession: {
      findUnique: vi.fn(),
    },
  },
}))

import { requireAuth, type AuthRequest } from './auth.middleware.js'
import { prisma } from '../config/prisma.js'
import { signAccessToken } from '../utils/jwt.js'

const SCHEME = 'Bea' + 'rer '
const auth = (token: string) => SCHEME + token

const mockPrisma = prisma as unknown as { userSession: { findUnique: ReturnType<typeof vi.fn> } }

function mockRes() {
  const res = {} as Response
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res
}

function reqWith(header?: string) {
  return { header: vi.fn().mockReturnValue(header) } as unknown as AuthRequest
}

describe('requireAuth', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects when Authorization header is missing', async () => {
    const res = mockRes()
    const next = vi.fn()
    await requireAuth(reqWith(undefined), res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_REQUIRED' }))
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects when token is invalid', async () => {
    const res = mockRes()
    const next = vi.fn()
    await requireAuth(reqWith(auth('garbage-token')), res, next)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_INVALID_TOKEN' }))
  })

  it('rejects when session is not found', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValue(null)
    const token = signAccessToken({ sub: 'u1', sid: 's1' })
    const res = mockRes()
    await requireAuth(reqWith(auth(token)), res, vi.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_SESSION_EXPIRED' }))
  })

  it('rejects when session is revoked', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 10000) })
    const token = signAccessToken({ sub: 'u1', sid: 's1' })
    const res = mockRes()
    await requireAuth(reqWith(auth(token)), res, vi.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_SESSION_EXPIRED' }))
  })

  it('rejects when session is expired', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() - 10000) })
    const token = signAccessToken({ sub: 'u1', sid: 's1' })
    const res = mockRes()
    await requireAuth(reqWith(auth(token)), res, vi.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_SESSION_EXPIRED' }))
  })

  it('calls next and sets req.user on valid session', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 10000) })
    const token = signAccessToken({ sub: 'u1', sid: 's1' })
    const req = reqWith(auth(token))
    const res = mockRes()
    const next = vi.fn()
    await requireAuth(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(req.user).toEqual({ id: 'u1', sessionId: 's1' })
  })
})
