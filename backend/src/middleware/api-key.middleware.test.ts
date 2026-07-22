import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Response } from 'express'

vi.mock('../config/prisma.js', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { requireApiKey, type ApiKeyRequest } from './api-key.middleware.js'
import { prisma } from '../config/prisma.js'
import { hashToken } from '../utils/crypto.js'

const SCHEME = 'Bea' + 'rer '
const auth = (token: string) => SCHEME + token

const mockPrisma = prisma as unknown as {
  apiKey: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
}

function mockRes() {
  const res = {} as Response
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res
}

function reqWith(header?: string) {
  return { header: vi.fn().mockReturnValue(header) } as unknown as ApiKeyRequest
}

describe('requireApiKey', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects when Authorization header is missing', async () => {
    const res = mockRes()
    await requireApiKey('files:upload')(reqWith(undefined), res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_KEY_REQUIRED' }))
  })

  it('rejects when key is not found', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null)
    const res = mockRes()
    await requireApiKey('files:upload')(reqWith(auth('rawkey')), res, vi.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_KEY_INVALID' }))
  })

  it('rejects when key is not active', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ status: 'revoked', revokedAt: null, expiresAt: null, scopes: ['files:upload'] })
    const res = mockRes()
    await requireApiKey('files:upload')(reqWith(auth('rawkey')), res, vi.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_KEY_INVALID' }))
  })

  it('rejects when key is revoked', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ status: 'active', revokedAt: new Date(), expiresAt: null, scopes: ['files:upload'] })
    const res = mockRes()
    await requireApiKey('files:upload')(reqWith(auth('rawkey')), res, vi.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_KEY_INVALID' }))
  })

  it('rejects when key is expired', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ status: 'active', revokedAt: null, expiresAt: new Date(Date.now() - 1000), scopes: ['files:upload'] })
    const res = mockRes()
    await requireApiKey('files:upload')(reqWith(auth('rawkey')), res, vi.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_KEY_INVALID' }))
  })

  it('rejects when key lacks the required scope (and normalizes non-array scopes)', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ id: 'k1', userId: 'u1', status: 'active', revokedAt: null, expiresAt: null, scopes: 'not-an-array' })
    const res = mockRes()
    await requireApiKey('files:upload')(reqWith(auth('rawkey')), res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_KEY_FORBIDDEN' }))
  })

  it('accepts a valid key, sets req.user/apiKey and updates lastUsedAt', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ id: 'k1', userId: 'u1', status: 'active', revokedAt: null, expiresAt: new Date(Date.now() + 100000), scopes: ['files:upload'] })
    mockPrisma.apiKey.update.mockResolvedValue({})
    const req = reqWith(auth('rawkey'))
    const res = mockRes()
    const next = vi.fn()
    await requireApiKey('files:upload')(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(req.user).toEqual({ id: 'u1', sessionId: 'api-key:k1' })
    expect(req.apiKey).toEqual({ id: 'k1', scopes: ['files:upload'] })
    expect(mockPrisma.apiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: hashToken('rawkey') } })
    expect(mockPrisma.apiKey.update).toHaveBeenCalled()
  })

  it('swallows lastUsedAt update errors', async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({ id: 'k1', userId: 'u1', status: 'active', revokedAt: null, expiresAt: null, scopes: ['files:upload'] })
    mockPrisma.apiKey.update.mockRejectedValue(new Error('update failed'))
    const req = reqWith(auth('rawkey'))
    const res = mockRes()
    const next = vi.fn()
    await requireApiKey('files:upload')(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('returns invalid when prisma throws', async () => {
    mockPrisma.apiKey.findUnique.mockRejectedValue(new Error('db error'))
    const res = mockRes()
    await requireApiKey('files:upload')(reqWith(auth('rawkey')), res, vi.fn())
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'API_KEY_INVALID' }))
  })
})
