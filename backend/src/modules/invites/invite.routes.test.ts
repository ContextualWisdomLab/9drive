import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: {
      findUnique: vi.fn(),
    },
    user: {
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    workspaceInvite: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    file: {
      findFirstOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
    folder: {
      findFirstOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { inviteRouter } from './invite.routes.js'

const mockPrisma = prisma as unknown as {
  userSession: { findUnique: ReturnType<typeof vi.fn> }
  user: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
  }
  workspaceInvite: {
    findMany: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    upsert: ReturnType<typeof vi.fn>
  }
  file: {
    findFirstOrThrow: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
  }
  folder: {
    findFirstOrThrow: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
  }
}

const authToken = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bea' + 'rer ' + authToken }

function makeInvite(overrides: Partial<any> = {}) {
  return {
    id: 'invite-1',
    inviterId: 'user-1',
    inviteeEmail: 'friend@example.com',
    targetType: 'file',
    targetId: 'file-1',
    role: 'viewer',
    status: 'pending',
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', inviteRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }))
  return app
}

describe('inviteRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ email: 'owner@example.com' })
    mockPrisma.user.findMany.mockResolvedValue([])
    mockPrisma.user.findUnique.mockResolvedValue(null)
    mockPrisma.workspaceInvite.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.file.findFirstOrThrow.mockResolvedValue({ id: 'file-1' })
    mockPrisma.file.findMany.mockResolvedValue([])
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue({ id: 'folder-1' })
    mockPrisma.folder.findMany.mockResolvedValue([])
    mockPrisma.workspaceInvite.upsert.mockResolvedValue(makeInvite())
  })

  it('GET / returns sent and received invites, auto-accepts registered users, and resolves targets', async () => {
    const sent = [makeInvite()]
    const received = [makeInvite({ id: 'invite-2', inviterId: 'user-2', inviteeEmail: 'owner@example.com', targetType: 'folder', targetId: 'folder-1', role: 'editor' })]
    mockPrisma.workspaceInvite.findMany.mockResolvedValueOnce(sent).mockResolvedValueOnce(received)
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'user-2', name: 'Friend', email: 'friend@example.com' }])
    mockPrisma.file.findMany.mockResolvedValue([{ id: 'file-1', name: 'Report.pdf', mimeType: 'application/pdf', sizeBytes: 123n, folderId: 'folder-a' }])
    mockPrisma.folder.findMany.mockResolvedValue([{ id: 'folder-1', name: 'Shared Folder' }])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body.sent).toHaveLength(1)
    expect(res.body.received).toHaveLength(1)
    expect(res.body.invites).toEqual(res.body.sent)
    expect(res.body.sent[0]).toEqual(expect.objectContaining({
      id: 'invite-1',
      email: 'friend@example.com',
      status: 'accepted',
      user: { id: 'user-2', name: 'Friend', email: 'friend@example.com' },
      target: { id: 'file-1', name: 'Report.pdf', type: 'file', mimeType: 'application/pdf', sizeBytes: '123', folderId: 'folder-a' },
    }))
    expect(res.body.sent[0].acceptedAt).toEqual(expect.any(String))
    expect(res.body.received[0]).toEqual(expect.objectContaining({
      id: 'invite-2',
      status: 'pending',
      user: null,
      target: { id: 'folder-1', name: 'Shared Folder', type: 'folder' },
    }))
    expect(mockPrisma.workspaceInvite.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['invite-1'] } },
      data: { status: 'accepted', acceptedAt: expect.any(Date) },
    })
  })

  it('GET / keeps pending invites unchanged when no users match invitee emails', async () => {
    mockPrisma.workspaceInvite.findMany.mockResolvedValueOnce([makeInvite()]).mockResolvedValueOnce([])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body.sent[0]).toEqual(expect.objectContaining({ status: 'pending', user: null, acceptedAt: null }))
    expect(mockPrisma.workspaceInvite.updateMany).not.toHaveBeenCalled()
  })

  it('GET / passes errors to next', async () => {
    mockPrisma.user.findUniqueOrThrow.mockRejectedValue(new Error('invite list failed'))

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'invite list failed' })
  })

  it('POST / creates a pending file invite for an unregistered user', async () => {
    mockPrisma.workspaceInvite.upsert.mockResolvedValue(makeInvite())
    mockPrisma.file.findMany.mockResolvedValue([{ id: 'file-1', name: 'Report.pdf', mimeType: 'application/pdf', sizeBytes: 123n, folderId: null }])

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ email: 'Friend@Example.com', role: 'viewer', targetType: 'file', targetId: 'file-1' })

    expect(res.status).toBe(201)
    expect(mockPrisma.file.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'file-1', userId: 'user-1', status: 'active' } })
    expect(mockPrisma.workspaceInvite.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { inviterId_inviteeEmail_targetType_targetId: { inviterId: 'user-1', inviteeEmail: 'friend@example.com', targetType: 'file', targetId: 'file-1' } },
      create: expect.objectContaining({ inviteeEmail: 'friend@example.com', status: 'pending', acceptedAt: null }),
      update: expect.objectContaining({ status: 'pending', acceptedAt: null, revokedAt: null }),
    }))
    expect(res.body.invite).toEqual(expect.objectContaining({
      email: 'friend@example.com',
      status: 'pending',
      user: null,
      target: { id: 'file-1', name: 'Report.pdf', type: 'file', mimeType: 'application/pdf', sizeBytes: '123', folderId: null },
    }))
  })

  it('POST / creates an accepted folder invite for an existing user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-2', name: 'Friend', email: 'friend@example.com' })
    mockPrisma.workspaceInvite.upsert.mockResolvedValue(makeInvite({
      id: 'invite-2',
      inviteeEmail: 'friend@example.com',
      targetType: 'folder',
      targetId: 'folder-1',
      role: 'editor',
      status: 'accepted',
      acceptedAt: new Date('2026-01-03T00:00:00.000Z'),
    }))
    mockPrisma.folder.findMany.mockResolvedValue([{ id: 'folder-1', name: 'Shared Folder' }])

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ email: 'friend@example.com', role: 'editor', targetType: 'folder', targetId: 'folder-1' })

    expect(res.status).toBe(201)
    expect(mockPrisma.folder.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'folder-1', userId: 'user-1', deletedAt: null } })
    expect(mockPrisma.workspaceInvite.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: 'accepted', acceptedAt: expect.any(Date) }),
      update: expect.objectContaining({ status: 'accepted', acceptedAt: expect.any(Date), revokedAt: null }),
    }))
    expect(res.body.invite).toEqual(expect.objectContaining({
      status: 'accepted',
      user: { id: 'user-2', name: 'Friend', email: 'friend@example.com' },
      target: { id: 'folder-1', name: 'Shared Folder', type: 'folder' },
    }))
  })

  it('POST / rejects self-invites', async () => {
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ email: 'friend@example.com' })

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ email: 'friend@example.com', role: 'viewer', targetType: 'file', targetId: 'file-1' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'INVITE_SELF_NOT_ALLOWED', message: 'You cannot invite yourself.' })
    expect(mockPrisma.workspaceInvite.upsert).not.toHaveBeenCalled()
  })

  it('POST / passes target ownership errors to next', async () => {
    mockPrisma.file.findFirstOrThrow.mockRejectedValue(new Error('target not found'))

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ email: 'friend@example.com', role: 'viewer', targetType: 'file', targetId: 'missing-file' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'target not found' })
  })

  it('POST / passes validation errors to next', async () => {
    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ email: 'bad-email', role: 'viewer', targetType: 'file', targetId: '' })

    expect(res.status).toBe(500)
    expect(typeof res.body.error).toBe('string')
  })

  it('POST / passes database errors to next', async () => {
    mockPrisma.workspaceInvite.upsert.mockRejectedValue(new Error('invite create failed'))

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ email: 'friend@example.com', role: 'viewer', targetType: 'file', targetId: 'file-1' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'invite create failed' })
  })

  it('DELETE /:id revokes an invite', async () => {
    const res = await request(makeApp())
      .delete('/invite-1')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(mockPrisma.workspaceInvite.updateMany).toHaveBeenCalledWith({
      where: { id: 'invite-1', inviterId: 'user-1', revokedAt: null },
      data: { status: 'revoked', revokedAt: expect.any(Date) },
    })
  })

  it('DELETE /:id returns 404 when the invite is missing', async () => {
    mockPrisma.workspaceInvite.updateMany.mockResolvedValue({ count: 0 })

    const res = await request(makeApp())
      .delete('/missing-invite')
      .set(authHeader)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ code: 'INVITE_NOT_FOUND', message: 'Invite not found.' })
  })

  it('DELETE /:id passes errors to next', async () => {
    mockPrisma.workspaceInvite.updateMany.mockRejectedValue(new Error('invite revoke failed'))

    const res = await request(makeApp())
      .delete('/invite-1')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'invite revoke failed' })
  })
})
