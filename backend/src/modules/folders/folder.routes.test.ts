import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const googleDriveMocks = vi.hoisted(() => ({
  filesCreate: vi.fn(),
  filesUpdate: vi.fn(),
  filesDelete: vi.fn(),
  filesGet: vi.fn(),
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
    connectedAccount: { findFirst: vi.fn() },
    folder: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    file: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

vi.mock('../../utils/audit.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../google/google.service.js', () => ({
  getAuthedGoogleClient: vi.fn(),
  syncGoogleQuota: vi.fn(),
  ensureGoogleAppFolder: vi.fn(),
}))

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn() },
    drive: vi.fn().mockReturnValue({
      files: {
        create: googleDriveMocks.filesCreate,
        update: googleDriveMocks.filesUpdate,
        delete: googleDriveMocks.filesDelete,
        get: googleDriveMocks.filesGet,
      },
    }),
  },
}))

import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import { signAccessToken } from '../../utils/jwt.js'
import { folderRouter } from './folder.routes.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'

const mockPrisma = prisma as any
const mockCreateAuditLog = vi.mocked(createAuditLog)
const mockGetAuthedGoogleClient = vi.mocked(getAuthedGoogleClient)
const mockEnsureGoogleAppFolder = vi.mocked(ensureGoogleAppFolder)
const mockSyncGoogleQuota = vi.mocked(syncGoogleQuota)
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bearer ' + token }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', folderRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }))
  return app
}

function makeConnectedAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    userId: 'user-1',
    provider: 'google_drive',
    providerAccountId: 'provider-account-1',
    status: 'connected',
    ...overrides,
  }
}

function makeFolder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'folder-1',
    name: 'Folder 1',
    color: '#3b82f6',
    iconUrl: 'https://api.iconify.design/lucide:folder.svg',
    parentId: null,
    providerFolderId: null,
    connectedAccountId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  }
}

function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    userId: 'user-1',
    folderId: 'folder-1',
    providerFileId: 'provider-file-1',
    connectedAccountId: 'account-1',
    status: 'active',
    connectedAccount: makeConnectedAccount(),
    ...overrides,
  }
}

describe('folderRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
    mockGetAuthedGoogleClient.mockResolvedValue({ auth: 'google-auth' } as any)
    mockEnsureGoogleAppFolder.mockResolvedValue('app-folder-id')
    mockSyncGoogleQuota.mockResolvedValue({ id: 'quota-1', totalBytes: null, usedBytes: 0n, availableBytes: null, trashBytes: null } as any)
    googleDriveMocks.filesCreate.mockResolvedValue({ data: { id: 'google-folder-id' } })
    googleDriveMocks.filesUpdate.mockResolvedValue({ data: { id: 'google-folder-id', parents: ['new-parent-id'] } })
    googleDriveMocks.filesDelete.mockResolvedValue({})
    googleDriveMocks.filesGet.mockResolvedValue({ data: { parents: ['old-parent-id'] } })
  })

  it('GET / returns root folders and skips self-healing when all provider ids exist', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([
      makeFolder({ id: 'root-1', providerFolderId: 'google-root-1' }),
      makeFolder({ id: 'root-2', providerFolderId: 'google-root-2', updatedAt: new Date('2026-01-03T00:00:00.000Z') }),
    ])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body.folders).toEqual([
      expect.objectContaining({ id: 'root-1', providerFolderId: 'google-root-1', createdAt: '2026-01-01T00:00:00.000Z' }),
      expect.objectContaining({ id: 'root-2', providerFolderId: 'google-root-2', updatedAt: '2026-01-03T00:00:00.000Z' }),
    ])
    expect(mockPrisma.folder.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', deletedAt: null, parentId: null },
      select: { id: true, name: true, color: true, iconUrl: true, parentId: true, providerFolderId: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    })
    expect(mockPrisma.connectedAccount.findFirst).not.toHaveBeenCalled()
  })

  it('GET / filters by parentId query', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ id: 'child-1', parentId: 'parent-1', providerFolderId: 'google-child-1' })])

    const res = await request(makeApp())
      .get('/?parentId=parent-1')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockPrisma.folder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', deletedAt: null, parentId: 'parent-1' },
    }))
  })

  it('GET / returns all folders with all=1', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ id: 'folder-a', providerFolderId: 'google-folder-a' })])

    const res = await request(makeApp())
      .get('/?all=1')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockPrisma.folder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', deletedAt: null },
    }))
  })

  it('GET / self-heals root folders with app folder parent', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ id: 'folder-root', providerFolderId: null })])
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    mockPrisma.folder.update.mockResolvedValue({})

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockGetAuthedGoogleClient).toHaveBeenCalledWith(expect.objectContaining({ id: 'account-1' }))
    expect(mockEnsureGoogleAppFolder).toHaveBeenCalledWith(expect.objectContaining({ id: 'account-1' }))
    expect(googleDriveMocks.filesCreate).toHaveBeenCalledWith({
      requestBody: {
        name: 'Folder 1',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['app-folder-id'],
      },
      fields: 'id',
    })
    expect(mockPrisma.folder.update).toHaveBeenCalledWith({
      where: { id: 'folder-root' },
      data: { providerFolderId: 'google-folder-id', connectedAccountId: 'account-1' },
    })
    expect(res.body.folders[0].providerFolderId).toBe('google-folder-id')
  })

  it('GET / self-heals child folders using the parent provider folder id', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ id: 'child-1', name: 'Child', parentId: 'parent-1', providerFolderId: null })])
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    mockPrisma.folder.findFirst.mockResolvedValue(makeFolder({ id: 'parent-1', providerFolderId: 'google-parent-1' }))
    mockPrisma.folder.update.mockResolvedValue({})
    googleDriveMocks.filesCreate.mockResolvedValueOnce({ data: { id: 'google-child-1' } })

    const res = await request(makeApp())
      .get('/?all=1')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockPrisma.folder.findFirst).toHaveBeenCalledWith({ where: { id: 'parent-1', userId: 'user-1' } })
    expect(googleDriveMocks.filesCreate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({ parents: ['google-parent-1'] }),
    }))
    expect(res.body.folders[0].providerFolderId).toBe('google-child-1')
  })

  it('GET / no-ops self-healing when no connected account exists', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ providerFolderId: null })])
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(null)

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockGetAuthedGoogleClient).not.toHaveBeenCalled()
    expect(mockPrisma.folder.update).not.toHaveBeenCalled()
  })

  it('GET / swallows Google auth failures during self-healing', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ providerFolderId: null })])
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    mockGetAuthedGoogleClient.mockRejectedValueOnce(new Error('auth failed'))

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed self-healing Google Drive auth:', expect.any(Error))
  })

  it('GET / swallows individual Google folder creation failures during self-healing', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ id: 'folder-bad', providerFolderId: null })])
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    googleDriveMocks.filesCreate.mockRejectedValueOnce(new Error('create failed'))

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed self-healing for folder folder-bad:', expect.any(Error))
    expect(mockPrisma.folder.update).not.toHaveBeenCalled()
  })

  it('GET / leaves providerFolderId empty when Google Drive returns no folder id', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ id: 'folder-no-id', providerFolderId: null })])
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    googleDriveMocks.filesCreate.mockResolvedValueOnce({ data: {} })

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockPrisma.folder.update).not.toHaveBeenCalled()
    expect(res.body.folders[0].providerFolderId).toBeNull()
  })

  it('GET / passes folder lookup errors to next', async () => {
    mockPrisma.folder.findMany.mockRejectedValueOnce(new Error('list failed'))

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'list failed' })
  })

  it('GET /recent returns recent folders with default limit 4', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ id: 'recent-1', providerFolderId: 'google-recent-1' })])

    const res = await request(makeApp())
      .get('/recent')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockPrisma.folder.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', deletedAt: null },
      select: { id: true, name: true, color: true, iconUrl: true, parentId: true, providerFolderId: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 4,
    })
  })

  it('GET /recent honors a smaller limit query', async () => {
    mockPrisma.folder.findMany.mockResolvedValue([makeFolder({ id: 'recent-2', providerFolderId: 'google-recent-2' })])

    const res = await request(makeApp())
      .get('/recent?limit=2')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockPrisma.folder.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }))
  })

  it('GET /recent passes errors to next', async () => {
    mockPrisma.folder.findMany.mockRejectedValueOnce(new Error('recent failed'))

    const res = await request(makeApp())
      .get('/recent')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'recent failed' })
  })

  it('POST / creates a root folder without a connected account', async () => {
    const created = makeFolder({ id: 'created-root', name: 'Root Folder', providerFolderId: null })
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(null)
    mockPrisma.folder.create.mockResolvedValue(created)

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Root Folder' })

    expect(res.status).toBe(201)
    expect(mockPrisma.folder.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        name: 'Root Folder',
        color: '#3b82f6',
        iconUrl: 'https://api.iconify.design/lucide:folder.svg',
        parentId: null,
        providerFolderId: null,
        connectedAccountId: null,
      },
      select: { id: true, name: true, color: true, iconUrl: true, parentId: true, providerFolderId: true, createdAt: true, updatedAt: true },
    })
    expect(mockCreateAuditLog).toHaveBeenCalledWith('user-1', 'CREATE_FOLDER', 'folder', 'created-root', { name: 'Root Folder' })
  })

  it('POST / creates a child folder when the parent exists', async () => {
    mockPrisma.folder.findFirstOrThrow.mockResolvedValueOnce(makeFolder({ id: 'parent-1', providerFolderId: 'google-parent-1' }))
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(null)
    mockPrisma.folder.create.mockResolvedValue(makeFolder({ id: 'child-created', name: 'Child Folder', parentId: 'parent-1' }))

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Child Folder', parentId: 'parent-1' })

    expect(res.status).toBe(201)
    expect(mockPrisma.folder.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'parent-1', userId: 'user-1', deletedAt: null } })
    expect(mockPrisma.folder.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentId: 'parent-1' }) }))
  })

  it('POST / creates the folder on Google Drive when a connected account exists', async () => {
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    mockPrisma.folder.create.mockResolvedValue(makeFolder({ id: 'google-created', providerFolderId: 'google-folder-123' }))
    googleDriveMocks.filesCreate.mockResolvedValueOnce({ data: { id: 'google-folder-123' } })

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Drive Folder' })

    expect(res.status).toBe(201)
    expect(googleDriveMocks.filesCreate).toHaveBeenCalledWith({
      requestBody: {
        name: 'Drive Folder',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['app-folder-id'],
      },
      fields: 'id',
    })
    expect(mockPrisma.folder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ providerFolderId: 'google-folder-123', connectedAccountId: 'account-1' }),
    }))
  })

  it('POST / uses the parent provider folder id for Google Drive creation when available', async () => {
    mockPrisma.folder.findFirstOrThrow.mockResolvedValueOnce(makeFolder({ id: 'parent-google', providerFolderId: 'google-parent-id' }))
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    mockPrisma.folder.create.mockResolvedValue(makeFolder({ id: 'child-google', parentId: 'parent-google', providerFolderId: 'google-child-id' }))
    googleDriveMocks.filesCreate.mockResolvedValueOnce({ data: { id: 'google-child-id' } })

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Child Google Folder', parentId: 'parent-google' })

    expect(res.status).toBe(201)
    expect(googleDriveMocks.filesCreate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: expect.objectContaining({ parents: ['google-parent-id'] }),
    }))
  })

  it('POST / keeps creating the folder when Google Drive creation fails', async () => {
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    googleDriveMocks.filesCreate.mockRejectedValueOnce(new Error('drive create failed'))
    mockPrisma.folder.create.mockResolvedValue(makeFolder({ id: 'created-after-failure', providerFolderId: null }))

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Still Created' })

    expect(res.status).toBe(201)
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to create folder on Google Drive:', expect.any(Error))
    expect(mockPrisma.folder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ providerFolderId: null, connectedAccountId: 'account-1' }),
    }))
  })

  it('POST / keeps providerFolderId null when Google Drive returns no id', async () => {
    mockPrisma.connectedAccount.findFirst.mockResolvedValue(makeConnectedAccount())
    googleDriveMocks.filesCreate.mockResolvedValueOnce({ data: {} })
    mockPrisma.folder.create.mockResolvedValue(makeFolder({ id: 'created-no-google-id', providerFolderId: null }))

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'No Google Id' })

    expect(res.status).toBe(201)
    expect(mockPrisma.folder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ providerFolderId: null }),
    }))
  })

  it('POST / passes missing parent errors to next', async () => {
    mockPrisma.folder.findFirstOrThrow.mockRejectedValueOnce(new Error('parent missing'))

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Child Folder', parentId: 'missing-parent' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'parent missing' })
  })

  it('POST / passes unexpected errors to next', async () => {
    mockPrisma.connectedAccount.findFirst.mockRejectedValueOnce(new Error('create failed'))

    const res = await request(makeApp())
      .post('/')
      .set(authHeader)
      .send({ name: 'Broken Folder' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'create failed' })
  })

  it('PATCH /:id renames the folder in the database and Google Drive', async () => {
    const folderRecord = { ...makeFolder({ id: 'folder-rename', providerFolderId: 'google-folder-rename' }), connectedAccount: makeConnectedAccount() }
    const updated = makeFolder({ id: 'folder-rename', name: 'Renamed Folder', providerFolderId: 'google-folder-rename' })
    mockPrisma.folder.findFirstOrThrow
      .mockResolvedValueOnce(folderRecord)
      .mockResolvedValueOnce(updated)
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 })

    const res = await request(makeApp())
      .patch('/folder-rename')
      .set(authHeader)
      .send({ name: 'Renamed Folder' })

    expect(res.status).toBe(200)
    expect(googleDriveMocks.filesUpdate).toHaveBeenCalledWith({
      fileId: 'google-folder-rename',
      requestBody: { name: 'Renamed Folder' },
    })
    expect(mockPrisma.folder.updateMany).toHaveBeenCalledWith({
      where: { id: 'folder-rename', userId: 'user-1', deletedAt: null },
      data: { name: 'Renamed Folder' },
    })
    expect(mockCreateAuditLog).toHaveBeenCalledWith('user-1', 'UPDATE_FOLDER', 'folder', 'folder-rename', { name: 'Renamed Folder', updates: { name: 'Renamed Folder' } })
  })

  it('PATCH /:id rejects moving a folder into itself', async () => {
    const res = await request(makeApp())
      .patch('/folder-self')
      .set(authHeader)
      .send({ parentId: 'folder-self' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'FOLDER_INVALID_PARENT', message: 'Folder cannot be moved into itself.' })
    expect(mockPrisma.folder.findFirstOrThrow).not.toHaveBeenCalled()
  })

  it('PATCH /:id rejects circular folder moves', async () => {
    const folderRecord = { ...makeFolder({ id: 'root-folder', providerFolderId: 'google-root' }), connectedAccount: makeConnectedAccount() }
    mockPrisma.folder.findFirstOrThrow
      .mockResolvedValueOnce(folderRecord)
      .mockResolvedValueOnce(makeFolder({ id: 'grandchild-folder' }))
    mockPrisma.folder.findMany.mockResolvedValue([
      { id: 'root-folder', parentId: null },
      { id: 'child-folder', parentId: 'root-folder' },
      { id: 'grandchild-folder', parentId: 'child-folder' },
    ])

    const res = await request(makeApp())
      .patch('/root-folder')
      .set(authHeader)
      .send({ parentId: 'grandchild-folder' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'FOLDER_INVALID_PARENT', message: 'Folder cannot be moved into itself or a child folder.' })
    expect(mockPrisma.folder.updateMany).not.toHaveBeenCalled()
  })

  it('PATCH /:id moves a folder to a valid new parent', async () => {
    const folderRecord = { ...makeFolder({ id: 'folder-move', providerFolderId: 'google-folder-move' }), connectedAccount: makeConnectedAccount() }
    const updated = makeFolder({ id: 'folder-move', parentId: 'parent-2', providerFolderId: 'google-folder-move' })
    mockPrisma.folder.findFirstOrThrow
      .mockResolvedValueOnce(folderRecord)
      .mockResolvedValueOnce(makeFolder({ id: 'parent-2' }))
      .mockResolvedValueOnce(updated)
    mockPrisma.folder.findMany.mockResolvedValue([{ id: 'folder-move', parentId: null }, { id: 'parent-2', parentId: null }])
    mockPrisma.folder.findFirst.mockResolvedValue(makeFolder({ id: 'parent-2', providerFolderId: 'google-parent-2' }))
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 })

    const res = await request(makeApp())
      .patch('/folder-move')
      .set(authHeader)
      .send({ parentId: 'parent-2' })

    expect(res.status).toBe(200)
    expect(googleDriveMocks.filesGet).toHaveBeenCalledWith({ fileId: 'google-folder-move', fields: 'parents' })
    expect(googleDriveMocks.filesUpdate).toHaveBeenCalledWith({
      fileId: 'google-folder-move',
      addParents: 'google-parent-2',
      removeParents: 'old-parent-id',
      fields: 'id, parents',
    })
    expect(mockPrisma.folder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { parentId: 'parent-2' } }))
  })

  it('PATCH /:id continues when Drive rename fails', async () => {
    const folderRecord = { ...makeFolder({ id: 'folder-rename-failure', providerFolderId: 'google-folder-rename-failure' }), connectedAccount: makeConnectedAccount() }
    const updated = makeFolder({ id: 'folder-rename-failure', name: 'Recovered Rename', providerFolderId: 'google-folder-rename-failure' })
    mockPrisma.folder.findFirstOrThrow
      .mockResolvedValueOnce(folderRecord)
      .mockResolvedValueOnce(updated)
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 })
    googleDriveMocks.filesUpdate.mockRejectedValueOnce(new Error('rename failed'))

    const res = await request(makeApp())
      .patch('/folder-rename-failure')
      .set(authHeader)
      .send({ name: 'Recovered Rename' })

    expect(res.status).toBe(200)
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to rename folder on Google Drive:', expect.any(Error))
    expect(mockPrisma.folder.updateMany).toHaveBeenCalled()
  })

  it('PATCH /:id continues when Drive move fails', async () => {
    const folderRecord = { ...makeFolder({ id: 'folder-move-failure', providerFolderId: 'google-folder-move-failure' }), connectedAccount: makeConnectedAccount() }
    const updated = makeFolder({ id: 'folder-move-failure', parentId: 'parent-3', providerFolderId: 'google-folder-move-failure' })
    mockPrisma.folder.findFirstOrThrow
      .mockResolvedValueOnce(folderRecord)
      .mockResolvedValueOnce(makeFolder({ id: 'parent-3' }))
      .mockResolvedValueOnce(updated)
    mockPrisma.folder.findMany.mockResolvedValue([{ id: 'folder-move-failure', parentId: null }, { id: 'parent-3', parentId: null }])
    mockPrisma.folder.findFirst.mockResolvedValue(makeFolder({ id: 'parent-3', providerFolderId: 'google-parent-3' }))
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 })
    googleDriveMocks.filesGet.mockRejectedValueOnce(new Error('move failed'))

    const res = await request(makeApp())
      .patch('/folder-move-failure')
      .set(authHeader)
      .send({ parentId: 'parent-3' })

    expect(res.status).toBe(200)
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to move folder on Google Drive:', expect.any(Error))
    expect(mockPrisma.folder.updateMany).toHaveBeenCalled()
  })

  it('PATCH /:id updates color and clears iconUrl when requested', async () => {
    const folderRecord = { ...makeFolder({ id: 'folder-style' }), connectedAccount: null }
    const updated = makeFolder({ id: 'folder-style', color: '#123456', iconUrl: null })
    mockPrisma.folder.findFirstOrThrow
      .mockResolvedValueOnce(folderRecord)
      .mockResolvedValueOnce(updated)
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 })

    const res = await request(makeApp())
      .patch('/folder-style')
      .set(authHeader)
      .send({ color: '#123456', iconUrl: null })

    expect(res.status).toBe(200)
    expect(mockPrisma.folder.updateMany).toHaveBeenCalledWith({
      where: { id: 'folder-style', userId: 'user-1', deletedAt: null },
      data: { color: '#123456', iconUrl: null },
    })
  })

  it('PATCH /:id returns 404 when the record disappears before updateMany completes', async () => {
    const folderRecord = { ...makeFolder({ id: 'folder-missing-after-load' }), connectedAccount: null }
    mockPrisma.folder.findFirstOrThrow.mockResolvedValueOnce(folderRecord)
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 0 })

    const res = await request(makeApp())
      .patch('/folder-missing-after-load')
      .set(authHeader)
      .send({ name: 'Nope' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found.' })
  })

  it('PATCH /:id passes errors to next', async () => {
    mockPrisma.folder.findFirstOrThrow.mockRejectedValueOnce(new Error('patch failed'))

    const res = await request(makeApp())
      .patch('/folder-error')
      .set(authHeader)
      .send({ name: 'Broken' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'patch failed' })
  })

  it('DELETE /:id deletes a folder tree, removes provider files and syncs affected accounts', async () => {
    const root = makeFolder({ id: 'root-folder', name: 'Root', providerFolderId: 'google-root', connectedAccountId: 'account-1' })
    const tree = [
      { id: 'root-folder', parentId: null },
      { id: 'child-folder', parentId: 'root-folder' },
      { id: 'grandchild-folder', parentId: 'child-folder' },
      { id: 'other-folder', parentId: null },
    ]
    const files = [
      makeFile({ id: 'file-1', folderId: 'root-folder', providerFileId: 'provider-file-1', connectedAccountId: 'account-1', connectedAccount: makeConnectedAccount({ id: 'account-1' }) }),
      makeFile({ id: 'file-2', folderId: 'child-folder', providerFileId: 'provider-file-2', connectedAccountId: 'account-2', connectedAccount: makeConnectedAccount({ id: 'account-2' }) }),
    ]
    const foldersToDelete = [
      { ...makeFolder({ id: 'root-folder', providerFolderId: 'google-root', connectedAccountId: 'account-1' }), connectedAccount: makeConnectedAccount({ id: 'account-1' }) },
      { ...makeFolder({ id: 'child-folder', providerFolderId: 'google-child', parentId: 'root-folder', connectedAccountId: 'account-1' }), connectedAccount: makeConnectedAccount({ id: 'account-1' }) },
      { ...makeFolder({ id: 'grandchild-folder', providerFolderId: 'google-grandchild', parentId: 'child-folder', connectedAccountId: 'account-2' }), connectedAccount: makeConnectedAccount({ id: 'account-2' }) },
    ]
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue(root)
    mockPrisma.folder.findMany
      .mockResolvedValueOnce(tree)
      .mockResolvedValueOnce(foldersToDelete)
    mockPrisma.file.findMany.mockResolvedValue(files)
    mockPrisma.file.updateMany.mockResolvedValue({ count: 2 })
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 3 })

    const res = await request(makeApp())
      .delete('/root-folder')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(googleDriveMocks.filesDelete).toHaveBeenCalledTimes(5)
    expect(mockPrisma.file.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['file-1', 'file-2'] } },
      data: { status: 'deleted', deletedAt: expect.any(Date) },
    })
    expect(mockPrisma.folder.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['root-folder', 'child-folder', 'grandchild-folder'] }, userId: 'user-1' },
      data: { deletedAt: expect.any(Date) },
    })
    expect(mockSyncGoogleQuota).toHaveBeenCalledTimes(2)
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('account-1')
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('account-2')
    expect(mockCreateAuditLog).toHaveBeenCalledWith('user-1', 'DELETE_FOLDER', 'folder', 'root-folder', { name: 'Root' })
  })

  it('DELETE /:id continues when deleting one provider file fails', async () => {
    const root = makeFolder({ id: 'root-folder-2', name: 'Root 2' })
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue(root)
    mockPrisma.folder.findMany
      .mockResolvedValueOnce([{ id: 'root-folder-2', parentId: null }])
      .mockResolvedValueOnce([{ ...makeFolder({ id: 'root-folder-2', providerFolderId: 'google-root-2', connectedAccountId: 'account-1' }), connectedAccount: makeConnectedAccount({ id: 'account-1' }) }])
    mockPrisma.file.findMany.mockResolvedValue([
      makeFile({ id: 'file-fails', folderId: 'root-folder-2', providerFileId: 'provider-file-fails', connectedAccountId: 'account-1', connectedAccount: makeConnectedAccount({ id: 'account-1' }) }),
      makeFile({ id: 'file-succeeds', folderId: 'root-folder-2', providerFileId: 'provider-file-succeeds', connectedAccountId: 'account-2', connectedAccount: makeConnectedAccount({ id: 'account-2' }) }),
    ])
    mockPrisma.file.updateMany.mockResolvedValue({ count: 2 })
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 })
    googleDriveMocks.filesDelete
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    const res = await request(makeApp())
      .delete('/root-folder-2')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockSyncGoogleQuota).toHaveBeenCalledTimes(2)
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('account-2')
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('account-1')
  })

  it('DELETE /:id continues when deleting a Google Drive folder fails', async () => {
    const root = makeFolder({ id: 'root-folder-3', name: 'Root 3' })
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue(root)
    mockPrisma.folder.findMany
      .mockResolvedValueOnce([{ id: 'root-folder-3', parentId: null }])
      .mockResolvedValueOnce([{ ...makeFolder({ id: 'root-folder-3', providerFolderId: 'google-root-3', connectedAccountId: 'account-3' }), connectedAccount: makeConnectedAccount({ id: 'account-3' }) }])
    mockPrisma.file.findMany.mockResolvedValue([])
    mockPrisma.file.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.folder.updateMany.mockResolvedValue({ count: 1 })
    googleDriveMocks.filesDelete.mockRejectedValueOnce(new Error('folder delete failed'))

    const res = await request(makeApp())
      .delete('/root-folder-3')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockSyncGoogleQuota).not.toHaveBeenCalled()
  })

  it('DELETE /:id passes missing root errors to next', async () => {
    mockPrisma.folder.findFirstOrThrow.mockRejectedValueOnce(new Error('root missing'))

    const res = await request(makeApp())
      .delete('/missing-root')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'root missing' })
  })
})
