import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { Readable } from 'node:stream'

const {
  driveFilesDeleteMock,
  driveFilesGetMock,
  driveFilesUpdateMock,
  drivePermissionsCreateMock,
  authClientMock,
  archiveMock,
  archiveState,
} = vi.hoisted(() => {
  const driveFilesDeleteMock = vi.fn()
  const driveFilesGetMock = vi.fn()
  const driveFilesUpdateMock = vi.fn()
  const drivePermissionsCreateMock = vi.fn()
  const authClientMock = {
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
    getRequestHeaders: vi.fn().mockResolvedValue({ Authorization: '******' }),
  }
  const archiveState: { res?: { end: () => void } } = {}
  const archiveHandlers: Record<string, ((...args: any[]) => void) | undefined> = {}
  const archiveMock = {
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      archiveHandlers[event] = handler
      return archiveMock
    }),
    removeAllListeners: vi.fn(() => {
      Object.keys(archiveHandlers).forEach((key) => delete archiveHandlers[key])
      return archiveMock
    }),
    pipe: vi.fn((res: { end: () => void }) => {
      archiveState.res = res
      return archiveMock
    }),
    append: vi.fn(),
    finalize: vi.fn().mockImplementation(async () => {
      archiveState.res?.end()
    }),
  }

  return {
    driveFilesDeleteMock,
    driveFilesGetMock,
    driveFilesUpdateMock,
    drivePermissionsCreateMock,
    authClientMock,
    archiveMock,
    archiveState,
  }
})

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: { findUnique: vi.fn() },
    file: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    fileShare: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    filePreviewToken: { findFirst: vi.fn(), create: vi.fn() },
    folder: { findFirst: vi.fn(), findFirstOrThrow: vi.fn() },
    connectedAccount: { findMany: vi.fn() },
  },
}))

vi.mock('../../utils/audit.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/crypto.js', () => ({
  hashToken: vi.fn((value: string) => `hash:${value}`),
  randomToken: vi.fn(() => 'generated-token'),
}))

vi.mock('../google/google.service.js', () => ({
  getAuthedGoogleClient: vi.fn().mockResolvedValue(authClientMock),
  syncGoogleAppFolderFiles: vi.fn().mockResolvedValue({ created: 0, updated: 0, deleted: 0 }),
  syncGoogleQuota: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../s3/s3.service.js', () => ({
  deleteS3Object: vi.fn().mockResolvedValue(undefined),
  syncS3Quota: vi.fn().mockResolvedValue(undefined),
  createS3Client: vi.fn().mockReturnValue({ send: vi.fn().mockResolvedValue({ Body: Readable.from(['s3-data']) }) }),
  getS3ConfigForAccount: vi.fn().mockResolvedValue({ bucket: 'test-bucket', region: 'us-east-1' }),
}))

vi.mock('./stream-file.js', () => ({
  streamProviderFile: vi.fn().mockImplementation((_file, _range, res, _options) => res.status(200).end()),
}))

vi.mock('./stream-google-file.js', () => ({
  googleDownloadExportMimeTypes: {
    'application/vnd.google-apps.document': { extension: '.pdf', mimeType: 'application/pdf' },
  },
  normalizeHeaders: vi.fn((headers: Record<string, string>) => headers),
  withExtension: vi.fn((name: string, ext: string) => `${name}${ext}`),
}))

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn() },
    drive: vi.fn().mockReturnValue({
      files: {
        delete: driveFilesDeleteMock,
        get: driveFilesGetMock,
        update: driveFilesUpdateMock,
      },
      permissions: {
        create: drivePermissionsCreateMock,
      },
    }),
  },
}))

vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => input),
}))

vi.mock('archiver', () => ({
  ZipArchive: vi.fn().mockImplementation(() => archiveMock),
  default: vi.fn().mockImplementation(() => archiveMock),
}))

import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { hashToken } from '../../utils/crypto.js'
import { createAuditLog } from '../../utils/audit.js'
import { getAuthedGoogleClient, syncGoogleAppFolderFiles, syncGoogleQuota } from '../google/google.service.js'
import { createS3Client, deleteS3Object, getS3ConfigForAccount, syncS3Quota } from '../s3/s3.service.js'
import { streamProviderFile } from './stream-file.js'
import { normalizeHeaders, withExtension } from './stream-google-file.js'
import { fileRouter } from './file.routes.js'

const mockPrisma = prisma as any
const mockCreateAuditLog = vi.mocked(createAuditLog)
const mockGetAuthedGoogleClient = vi.mocked(getAuthedGoogleClient)
const mockSyncGoogleAppFolderFiles = vi.mocked(syncGoogleAppFolderFiles)
const mockSyncGoogleQuota = vi.mocked(syncGoogleQuota)
const mockDeleteS3Object = vi.mocked(deleteS3Object)
const mockSyncS3Quota = vi.mocked(syncS3Quota)
const mockCreateS3Client = vi.mocked(createS3Client)
const mockGetS3ConfigForAccount = vi.mocked(getS3ConfigForAccount)
const mockStreamProviderFile = vi.mocked(streamProviderFile)
const mockHashToken = vi.mocked(hashToken)
const mockNormalizeHeaders = vi.mocked(normalizeHeaders)
const mockWithExtension = vi.mocked(withExtension)

const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bearer ' + token }
const fetchMock = vi.fn()

vi.stubGlobal('fetch', fetchMock)
vi.spyOn(console, 'info').mockImplementation(() => undefined)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', fileRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }))
  return app
}

const BASE_FILE = {
  id: 'file-1',
  userId: 'user-1',
  connectedAccountId: 'account-1',
  folderId: null,
  provider: 'google_drive',
  providerFileId: 'drive-file-id',
  name: 'test.txt',
  mimeType: 'text/plain',
  sizeBytes: 1024n,
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  deletedAt: null,
  connectedAccount: { id: 'account-1', email: 'user@example.com', provider: 'google_drive' },
  folder: null,
}

function makeFile(overrides: Record<string, unknown> = {}) {
  return { ...BASE_FILE, ...overrides }
}

function webStreamFrom(text: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe('fileRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    archiveMock.removeAllListeners()
    archiveState.res = undefined
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
    driveFilesDeleteMock.mockResolvedValue({})
    driveFilesGetMock.mockResolvedValue({ data: { webViewLink: 'https://drive.link/view', webContentLink: 'https://drive.link/download' } })
    driveFilesUpdateMock.mockResolvedValue({ data: {} })
    drivePermissionsCreateMock.mockResolvedValue({})
    mockGetAuthedGoogleClient.mockResolvedValue(authClientMock as any)
    mockStreamProviderFile.mockImplementation((_file, _range, res, _options) => res.status(200).end())
    mockCreateAuditLog.mockResolvedValue(undefined)
    mockDeleteS3Object.mockResolvedValue(undefined)
    mockSyncGoogleQuota.mockResolvedValue(undefined)
    mockSyncS3Quota.mockResolvedValue(undefined)
    mockSyncGoogleAppFolderFiles.mockResolvedValue({ created: 0, updated: 0, deleted: 0 })
    mockGetS3ConfigForAccount.mockResolvedValue({ bucket: 'test-bucket', region: 'us-east-1' } as any)
    mockCreateS3Client.mockReturnValue({ send: vi.fn().mockResolvedValue({ Body: Readable.from(['s3-data']) }) } as any)
    authClientMock.getAccessToken.mockResolvedValue('access-token')
    authClientMock.getRequestHeaders.mockResolvedValue({ Authorization: '******' })
    fetchMock.mockReset()
  })

  it('GET /preview/:token streams an active preview file', async () => {
    mockPrisma.filePreviewToken.findFirst.mockResolvedValue({ file: makeFile() })

    const res = await request(makeApp()).get('/preview/preview-token')

    expect(res.status).toBe(200)
    expect(mockHashToken).toHaveBeenCalledWith('preview-token')
    expect(mockPrisma.filePreviewToken.findFirst).toHaveBeenCalledWith({
      where: { tokenHash: 'hash:preview-token', expiresAt: { gt: expect.any(Date) } },
      include: { file: { include: { connectedAccount: true } } },
    })
    expect(mockStreamProviderFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), undefined, expect.anything(), { disposition: 'inline' })
  })

  it('GET /preview/:token returns 404 for missing or inactive previews', async () => {
    mockPrisma.filePreviewToken.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ file: makeFile({ status: 'deleted' }) })

    const missing = await request(makeApp()).get('/preview/missing-token')
    const inactive = await request(makeApp()).get('/preview/inactive-token')

    expect(missing.status).toBe(404)
    expect(inactive.status).toBe(404)
    expect(missing.body.code).toBe('PREVIEW_NOT_FOUND')
    expect(inactive.body.code).toBe('PREVIEW_NOT_FOUND')
  })

  it('GET /preview/:token passes database errors to next', async () => {
    mockPrisma.filePreviewToken.findFirst.mockRejectedValue(new Error('preview failed'))

    const res = await request(makeApp()).get('/preview/fail')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'preview failed' })
  })

  it('GET / applies all list filters and stringifies sizes', async () => {
    mockPrisma.file.findMany.mockResolvedValue([makeFile()])

    const res = await request(makeApp())
      .get('/')
      .set(authHeader)
      .query({
        folderId: 'folder-1',
        q: 'report',
        kind: 'image',
        accountId: 'account-1',
        minSize: '100',
        maxSize: '200',
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-01-31T23:59:59.000Z',
      })

    expect(res.status).toBe(200)
    expect(mockPrisma.file.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        status: 'active',
        folderId: 'folder-1',
        name: { contains: 'report' },
        connectedAccountId: 'account-1',
        mimeType: { in: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'] },
        sizeBytes: { gte: 100n, lte: 200n },
        createdAt: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-01-31T23:59:59.000Z'),
        },
      },
      include: {
        connectedAccount: { select: { id: true, email: true, provider: true } },
        folder: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
    expect(res.body.files[0].sizeBytes).toBe('1024')
  })

  it.each([
    ['image', ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']],
    ['video', ['video/mp4', 'video/mpeg', 'video/ogg', 'video/quicktime', 'video/webm']],
    ['pdf', ['application/pdf']],
    ['doc', ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']],
    ['archive', ['application/zip', 'application/x-rar-compressed', 'application/x-tar', 'application/x-7z-compressed']],
  ])('GET / maps %s kind filters', async (kind, mimeTypes) => {
    mockPrisma.file.findMany.mockResolvedValue([])

    const res = await request(makeApp()).get('/').set(authHeader).query({ kind })

    expect(res.status).toBe(200)
    expect(mockPrisma.file.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ mimeType: { in: mimeTypes } }),
    }))
  })

  it('GET / supports no filters and forwards errors', async () => {
    mockPrisma.file.findMany.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('list failed'))

    const ok = await request(makeApp()).get('/').set(authHeader)
    const failed = await request(makeApp()).get('/').set(authHeader)

    expect(ok.status).toBe(200)
    expect(mockPrisma.file.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { userId: 'user-1', status: 'active' } }))
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'list failed' })
  })

  it('PATCH /batch moves files and validates the folder', async () => {
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue({ id: 'folder-2' })
    mockPrisma.file.updateMany.mockResolvedValue({ count: 2 })

    const res = await request(makeApp())
      .patch('/batch')
      .set(authHeader)
      .send({ fileIds: ['file-1', 'file-2'], folderId: 'folder-2' })

    expect(res.status).toBe(200)
    expect(mockPrisma.folder.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'folder-2', userId: 'user-1', deletedAt: null } })
    expect(mockPrisma.file.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['file-1', 'file-2'] }, userId: 'user-1', status: 'active' },
      data: { folderId: 'folder-2' },
    })
    expect(mockCreateAuditLog).toHaveBeenCalledWith('user-1', 'MOVE_FILES', 'file', undefined, { count: 2, folderId: 'folder-2' })
    expect(res.body).toEqual({ status: 'ok', moved: 2 })
  })

  it('PATCH /batch handles missing folders and update errors', async () => {
    mockPrisma.folder.findFirstOrThrow.mockRejectedValueOnce(new Error('folder missing'))
    mockPrisma.file.updateMany.mockRejectedValueOnce(new Error('move failed'))

    const missing = await request(makeApp()).patch('/batch').set(authHeader).send({ fileIds: ['file-1'], folderId: 'folder-9' })
    const failed = await request(makeApp()).patch('/batch').set(authHeader).send({ fileIds: ['file-1'] })

    expect(missing.status).toBe(500)
    expect(missing.body).toEqual({ error: 'folder missing' })
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'move failed' })
  })

  it('DELETE /batch trashes files and logs each deletion', async () => {
    mockPrisma.file.findMany.mockResolvedValue([makeFile(), makeFile({ id: 'file-2', name: 'second.txt' })])
    mockPrisma.file.updateMany.mockResolvedValue({ count: 2 })

    const res = await request(makeApp()).delete('/batch').set(authHeader).send({ fileIds: ['file-1', 'file-2'] })

    expect(res.status).toBe(200)
    expect(mockPrisma.file.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'deleted', deletedAt: expect.any(Date) },
    }))
    expect(mockCreateAuditLog).toHaveBeenNthCalledWith(1, 'user-1', 'TRASH_FILE', 'file', 'file-1', { name: 'test.txt' })
    expect(mockCreateAuditLog).toHaveBeenNthCalledWith(2, 'user-1', 'TRASH_FILE', 'file', 'file-2', { name: 'second.txt' })
    expect(res.body).toEqual({ status: 'ok', deleted: 2 })
  })

  it('DELETE /batch passes trash errors to next', async () => {
    mockPrisma.file.findMany.mockRejectedValue(new Error('trash failed'))

    const res = await request(makeApp()).delete('/batch').set(authHeader).send({ fileIds: ['file-1'] })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'trash failed' })
  })

  it('GET /trash supports q filters and plain trash listing', async () => {
    mockPrisma.file.findMany.mockResolvedValueOnce([makeFile({ status: 'deleted', deletedAt: new Date('2026-02-01T00:00:00.000Z') })]).mockResolvedValueOnce([])

    const filtered = await request(makeApp()).get('/trash').set(authHeader).query({ q: 'test' })
    const plain = await request(makeApp()).get('/trash').set(authHeader)

    expect(filtered.status).toBe(200)
    expect(mockPrisma.file.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { userId: 'user-1', status: 'deleted', name: { contains: 'test' } },
    }))
    expect(plain.status).toBe(200)
    expect(mockPrisma.file.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { userId: 'user-1', status: 'deleted' },
    }))
  })

  it('GET /trash passes errors to next', async () => {
    mockPrisma.file.findMany.mockRejectedValue(new Error('trash list failed'))

    const res = await request(makeApp()).get('/trash').set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'trash list failed' })
  })

  it('POST /batch/restore restores files and logs each one', async () => {
    mockPrisma.file.findMany.mockResolvedValue([makeFile({ status: 'deleted' })])
    mockPrisma.file.updateMany.mockResolvedValue({ count: 1 })

    const res = await request(makeApp()).post('/batch/restore').set(authHeader).send({ fileIds: ['file-1'] })

    expect(res.status).toBe(200)
    expect(mockPrisma.file.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'active', deletedAt: null } }))
    expect(mockCreateAuditLog).toHaveBeenCalledWith('user-1', 'RESTORE_FILE', 'file', 'file-1', { name: 'test.txt' })
    expect(res.body).toEqual({ status: 'ok', restored: 1 })
  })

  it('POST /batch/restore passes errors to next', async () => {
    mockPrisma.file.findMany.mockRejectedValue(new Error('restore failed'))

    const res = await request(makeApp()).post('/batch/restore').set(authHeader).send({ fileIds: ['file-1'] })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'restore failed' })
  })

  it('DELETE /batch/permanent deletes mixed providers, syncs quota, and reports failures', async () => {
    const s3File = makeFile({ id: 'file-s3', provider: 's3', connectedAccountId: 'account-s3', providerFileId: 's3-key', connectedAccount: { id: 'account-s3', provider: 's3' } })
    const googleFile = makeFile({ id: 'file-google', providerFileId: 'drive-ok', connectedAccountId: 'account-google', connectedAccount: { id: 'account-google', provider: 'google_drive' } })
    const failedGoogle = makeFile({ id: 'file-fail', providerFileId: 'drive-fail', connectedAccountId: 'account-google', connectedAccount: { id: 'account-google', provider: 'google_drive' } })
    mockPrisma.file.findMany.mockResolvedValue([s3File, googleFile, failedGoogle])
    mockPrisma.file.deleteMany.mockResolvedValue({ count: 2 })
    driveFilesDeleteMock.mockImplementation(async ({ fileId }: { fileId: string }) => {
      if (fileId === 'drive-fail') throw new Error('drive delete failed')
      return {}
    })
    mockSyncS3Quota.mockRejectedValueOnce(new Error('ignore s3 quota failure'))

    const res = await request(makeApp()).delete('/batch/permanent').set(authHeader).send({ fileIds: ['file-s3', 'file-google', 'file-fail'] })

    expect(res.status).toBe(200)
    expect(mockDeleteS3Object).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-s3' }))
    expect(driveFilesDeleteMock).toHaveBeenCalledWith({ fileId: 'drive-ok' })
    expect(mockPrisma.file.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['file-s3', 'file-google'] }, userId: 'user-1' } })
    expect(mockSyncS3Quota).toHaveBeenCalledWith('account-s3')
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('account-google')
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(2)
    expect(res.body).toEqual({
      status: 'ok',
      deleted: 2,
      failed: [{ fileId: 'file-fail', message: 'drive delete failed' }],
    })
  })

  it('DELETE /batch/permanent returns 400 when every delete fails', async () => {
    const s3File = makeFile({ id: 'file-s3', provider: 's3', connectedAccountId: 'account-s3', connectedAccount: { id: 'account-s3', provider: 's3' } })
    const googleFile = makeFile({ id: 'file-google', providerFileId: 'drive-fail', connectedAccountId: 'account-google', connectedAccount: { id: 'account-google', provider: 'google_drive' } })
    mockPrisma.file.findMany.mockResolvedValue([s3File, googleFile])
    mockDeleteS3Object.mockRejectedValueOnce(new Error('s3 delete failed'))
    driveFilesDeleteMock.mockRejectedValueOnce(new Error('drive delete failed'))

    const res = await request(makeApp()).delete('/batch/permanent').set(authHeader).send({ fileIds: ['file-s3', 'file-google'] })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      code: 'FILES_DELETE_FAILED',
      message: 'No files were permanently deleted.',
      deleted: 0,
      failed: [
        { fileId: 'file-s3', message: 's3 delete failed' },
        { fileId: 'file-google', message: 'drive delete failed' },
      ],
    })
  })

  it('DELETE /batch/permanent passes outer errors to next', async () => {
    mockPrisma.file.findMany.mockRejectedValue(new Error('permanent failed'))

    const res = await request(makeApp()).delete('/batch/permanent').set(authHeader).send({ fileIds: ['file-1'] })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'permanent failed' })
  })

  it('GET /shared-links returns only enabled active share links', async () => {
    mockPrisma.fileShare.findMany.mockResolvedValue([
      {
        id: 'share-1',
        token: 'share-token',
        createdAt: new Date('2026-01-05T00:00:00.000Z'),
        expiresAt: null,
        file: makeFile(),
      },
      {
        id: 'share-2',
        token: 'hidden-token',
        createdAt: new Date('2026-01-06T00:00:00.000Z'),
        expiresAt: null,
        file: makeFile({ id: 'file-2', status: 'deleted' }),
      },
    ])

    const res = await request(makeApp()).get('/shared-links').set(authHeader)

    expect(res.status).toBe(200)
    expect(mockPrisma.fileShare.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] },
    }))
    expect(res.body).toEqual({
      shares: [{
        id: 'share-1',
        url: 'http://localhost:5173/public/files/share-token',
        createdAt: '2026-01-05T00:00:00.000Z',
        expiresAt: null,
        file: expect.objectContaining({ id: 'file-1', sizeBytes: '1024' }),
      }],
    })
  })

  it('GET /shared-links passes errors to next', async () => {
    mockPrisma.fileShare.findMany.mockRejectedValue(new Error('shares failed'))

    const res = await request(makeApp()).get('/shared-links').set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'shares failed' })
  })

  it('POST /sync-google syncs a specific account or all accounts', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValueOnce([{ id: 'account-1' }]).mockResolvedValueOnce([{ id: 'account-1' }, { id: 'account-2' }])
    mockSyncGoogleAppFolderFiles.mockResolvedValueOnce({ created: 1, updated: 2, deleted: 3 }).mockResolvedValueOnce({ created: 4, updated: 5, deleted: 6 }).mockResolvedValueOnce({ created: 7, updated: 8, deleted: 9 })

    const single = await request(makeApp()).post('/sync-google').set(authHeader).send({ connectedAccountId: 'account-1' })
    const all = await request(makeApp()).post('/sync-google').set(authHeader).send({})

    expect(single.status).toBe(200)
    expect(mockPrisma.connectedAccount.findMany).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user-1', provider: 'google_drive', status: 'connected', id: 'account-1' },
      select: { id: true },
    })
    expect(single.body.results).toEqual([{ created: 1, updated: 2, deleted: 3 }])
    expect(all.status).toBe(200)
    expect(all.body.results).toEqual([{ created: 4, updated: 5, deleted: 6 }, { created: 7, updated: 8, deleted: 9 }])
  })

  it('POST /sync-google passes errors to next', async () => {
    mockPrisma.connectedAccount.findMany.mockRejectedValue(new Error('sync failed'))

    const res = await request(makeApp()).post('/sync-google').set(authHeader).send({})

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'sync failed' })
  })

  it('GET /:id returns a file and forwards errors', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValueOnce(makeFile()).mockRejectedValueOnce(new Error('lookup failed'))

    const ok = await request(makeApp()).get('/file-1').set(authHeader)
    const failed = await request(makeApp()).get('/file-1').set(authHeader)

    expect(ok.status).toBe(200)
    expect(ok.body.file.sizeBytes).toBe('1024')
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'lookup failed' })
  })

  it('PATCH /:id renames Google Drive files and updates metadata', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValue(makeFile())
    mockPrisma.file.update.mockResolvedValue(makeFile({ name: 'renamed.txt' }))

    const res = await request(makeApp()).patch('/file-1').set(authHeader).send({ name: 'renamed.txt' })

    expect(res.status).toBe(200)
    expect(driveFilesUpdateMock).toHaveBeenCalledWith({ fileId: 'drive-file-id', requestBody: { name: 'renamed.txt' } })
    expect(mockPrisma.file.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'file-1' },
      data: { name: 'renamed.txt' },
    }))
    expect(mockCreateAuditLog).toHaveBeenCalledWith('user-1', 'UPDATE_FILE', 'file', 'file-1', { name: 'renamed.txt', updates: { name: 'renamed.txt' } })
  })

  it('PATCH /:id skips Drive rename for s3 files and validates folder updates', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValueOnce(makeFile({ provider: 's3', connectedAccount: { id: 'account-1', provider: 's3' } })).mockResolvedValueOnce(makeFile())
    mockPrisma.file.update.mockResolvedValueOnce(makeFile({ provider: 's3', connectedAccount: { id: 'account-1', provider: 's3' }, name: 's3-name.txt' })).mockResolvedValueOnce(makeFile({ folderId: 'folder-2', folder: { id: 'folder-2', name: 'Folder 2' } }))
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue({ id: 'folder-2' })

    const s3Res = await request(makeApp()).patch('/file-1').set(authHeader).send({ name: 's3-name.txt' })
    const folderRes = await request(makeApp()).patch('/file-1').set(authHeader).send({ folderId: 'folder-2' })

    expect(s3Res.status).toBe(200)
    expect(driveFilesUpdateMock).not.toHaveBeenCalled()
    expect(folderRes.status).toBe(200)
    expect(mockPrisma.folder.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'folder-2', userId: 'user-1', deletedAt: null } })
    expect(mockPrisma.file.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { folderId: 'folder-2' } }))
  })

  it('PATCH /:id passes update errors to next', async () => {
    mockPrisma.file.findFirstOrThrow.mockRejectedValue(new Error('update failed'))

    const res = await request(makeApp()).patch('/file-1').set(authHeader).send({ name: 'nope' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'update failed' })
  })

  it('POST /:id/share creates or reuses share links', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValue(makeFile())
    mockPrisma.fileShare.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'share-existing', token: 'existing-token' })
    mockPrisma.fileShare.create.mockResolvedValue({ id: 'share-created' })

    const created = await request(makeApp()).post('/file-1/share').set(authHeader)
    const existing = await request(makeApp()).post('/file-1/share').set(authHeader)

    expect(created.status).toBe(201)
    expect(mockPrisma.fileShare.create).toHaveBeenCalledWith({
      data: { fileId: 'file-1', userId: 'user-1', token: 'generated-token', tokenHash: 'hash:generated-token' },
    })
    expect(created.body).toEqual({ url: 'http://localhost:5173/public/files/generated-token', shareId: 'share-created' })
    expect(existing.status).toBe(200)
    expect(existing.body).toEqual({ url: 'http://localhost:5173/public/files/existing-token', shareId: 'share-existing' })
  })

  it('POST /:id/share passes errors to next', async () => {
    mockPrisma.file.findFirstOrThrow.mockRejectedValue(new Error('share failed'))

    const res = await request(makeApp()).post('/file-1/share').set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'share failed' })
  })

  it('POST /:id/public-permission returns URLs for Google Drive files', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValue(makeFile())
    driveFilesGetMock.mockResolvedValue({ data: { webViewLink: 'https://drive.link/public' } })

    const res = await request(makeApp()).post('/file-1/public-permission').set(authHeader)

    expect(res.status).toBe(200)
    expect(drivePermissionsCreateMock).toHaveBeenCalledWith({
      fileId: 'drive-file-id',
      requestBody: { role: 'writer', type: 'anyone' },
    })
    expect(res.body).toEqual({ status: 'ok', url: 'https://drive.link/public' })
  })

  it('POST /:id/public-permission rejects non-Google files and returns Google API errors', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValueOnce(makeFile({ provider: 's3', connectedAccount: { id: 'account-1', provider: 's3' } })).mockResolvedValueOnce(makeFile())
    drivePermissionsCreateMock.mockRejectedValueOnce(new Error('permission failed'))

    const unsupported = await request(makeApp()).post('/file-1/public-permission').set(authHeader)
    const failed = await request(makeApp()).post('/file-1/public-permission').set(authHeader)

    expect(unsupported.status).toBe(400)
    expect(unsupported.body.code).toBe('UNSUPPORTED_PROVIDER')
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ code: 'GOOGLE_API_ERROR', message: 'permission failed' })
  })

  it('DELETE /:id/share disables share links and forwards errors', async () => {
    mockPrisma.fileShare.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(new Error('share delete failed'))

    const ok = await request(makeApp()).delete('/file-1/share').set(authHeader)
    const failed = await request(makeApp()).delete('/file-1/share').set(authHeader)

    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ status: 'ok' })
    expect(mockPrisma.fileShare.updateMany).toHaveBeenNthCalledWith(1, { where: { fileId: 'file-1', userId: 'user-1', enabled: true }, data: { enabled: false } })
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'share delete failed' })
  })

  it('POST /:id/preview-token creates preview URLs and forwards errors', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValueOnce(makeFile()).mockRejectedValueOnce(new Error('preview token failed'))
    mockPrisma.filePreviewToken.create.mockResolvedValue(undefined)

    const ok = await request(makeApp()).post('/file-1/preview-token').set(authHeader).set('host', 'api.example.com')
    const failed = await request(makeApp()).post('/file-1/preview-token').set(authHeader)

    expect(ok.status).toBe(201)
    expect(mockPrisma.filePreviewToken.create).toHaveBeenCalledWith({
      data: {
        fileId: 'file-1',
        userId: 'user-1',
        tokenHash: 'hash:generated-token',
        expiresAt: expect.any(Date),
      },
    })
    expect(ok.body).toEqual({ path: '/files/preview/generated-token', url: 'http://api.example.com/files/preview/generated-token' })
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'preview token failed' })
  })

  it('GET /:id/view-url handles s3, Google success, and swallowed permission failures', async () => {
    mockPrisma.file.findFirstOrThrow
      .mockResolvedValueOnce(makeFile({ provider: 's3', connectedAccount: { id: 'account-1', provider: 's3' } }))
      .mockResolvedValueOnce(makeFile())
      .mockResolvedValueOnce(makeFile({ id: 'file-2', providerFileId: 'drive-file-2' }))
    driveFilesGetMock.mockResolvedValueOnce({ data: { webContentLink: 'https://drive.link/content' } }).mockResolvedValueOnce({ data: { webViewLink: 'https://drive.link/view-2' } })
    drivePermissionsCreateMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('permission failed'))

    const s3Res = await request(makeApp()).get('/file-1/view-url').set(authHeader)
    const googleRes = await request(makeApp()).get('/file-1/view-url').set(authHeader)
    const swallowed = await request(makeApp()).get('/file-2/view-url').set(authHeader)

    expect(s3Res.status).toBe(200)
    expect(s3Res.body).toEqual({ url: null })
    expect(googleRes.status).toBe(200)
    expect(googleRes.body).toEqual({ url: 'https://drive.link/content' })
    expect(swallowed.status).toBe(200)
    expect(swallowed.body).toEqual({ url: 'https://drive.link/view-2' })
  })

  it('GET /:id/view-url passes lookup errors to next', async () => {
    mockPrisma.file.findFirstOrThrow.mockRejectedValue(new Error('view failed'))

    const res = await request(makeApp()).get('/file-1/view-url').set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'view failed' })
  })

  it('GET /:id/download streams provider files and forwards errors', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValueOnce(makeFile()).mockRejectedValueOnce(new Error('download failed'))

    const ok = await request(makeApp()).get('/file-1/download').set(authHeader)
    const failed = await request(makeApp()).get('/file-1/download').set(authHeader)

    expect(ok.status).toBe(200)
    expect(mockStreamProviderFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), undefined, expect.anything(), { disposition: 'attachment' })
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'download failed' })
  })

  it('DELETE /:id trashes a single file and forwards errors', async () => {
    mockPrisma.file.findFirstOrThrow.mockResolvedValueOnce(makeFile()).mockRejectedValueOnce(new Error('delete failed'))
    mockPrisma.file.update.mockResolvedValue({})

    const ok = await request(makeApp()).delete('/file-1').set(authHeader)
    const failed = await request(makeApp()).delete('/file-1').set(authHeader)

    expect(ok.status).toBe(200)
    expect(mockPrisma.file.update).toHaveBeenCalledWith({ where: { id: 'file-1' }, data: { status: 'deleted', deletedAt: expect.any(Date) } })
    expect(mockCreateAuditLog).toHaveBeenCalledWith('user-1', 'TRASH_FILE', 'file', 'file-1', { name: 'test.txt' })
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'delete failed' })
  })

  it('POST /batch-download zips Google export, Google media, and s3 files while skipping failures', async () => {
    const exportFile = makeFile({ id: 'gdoc', providerFileId: 'drive-export', name: 'doc', mimeType: 'application/vnd.google-apps.document' })
    const mediaFile = makeFile({ id: 'gmedia', providerFileId: 'drive-media', name: 'image.png', mimeType: 'image/png' })
    const s3File = makeFile({ id: 's3file', provider: 's3', providerFileId: 'key-1', connectedAccountId: 'account-s3', connectedAccount: { id: 'account-s3', provider: 's3' } })
    const failedFile = makeFile({ id: 'gfail', providerFileId: 'drive-fail', name: 'bad.txt' })
    const s3Send = vi.fn().mockResolvedValue({ Body: Readable.from(['zip-s3']) })
    mockPrisma.file.findMany.mockResolvedValue([exportFile, mediaFile, s3File, failedFile])
    mockCreateS3Client.mockReturnValue({ send: s3Send } as any)
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('drive-fail')) throw new Error('fetch failed')
      return { ok: true, body: webStreamFrom(`body:${url}`) }
    })

    const res = await request(makeApp()).post('/batch-download').set(authHeader).send({ fileIds: ['gdoc', 'gmedia', 's3file', 'gfail'] })

    expect(res.status).toBe(200)
    expect(archiveMock.pipe).toHaveBeenCalled()
    expect(mockNormalizeHeaders).toHaveBeenCalledWith({ Authorization: '******' })
    expect(mockWithExtension).toHaveBeenCalledWith('doc', '.pdf')
    expect(fetchMock).toHaveBeenCalledWith('https://www.googleapis.com/drive/v3/files/drive-export/export?mimeType=application%2Fpdf', { headers: { Authorization: '******' } })
    expect(fetchMock).toHaveBeenCalledWith('https://www.googleapis.com/drive/v3/files/drive-media?alt=media', { headers: { Authorization: '******' } })
    expect(mockGetS3ConfigForAccount).toHaveBeenCalledWith('account-s3')
    expect(s3Send).toHaveBeenCalledWith({ Bucket: 'test-bucket', Key: 'key-1' })
    expect(archiveMock.append).toHaveBeenCalledTimes(3)
    expect(archiveMock.finalize).toHaveBeenCalled()
    const errorHandler = archiveMock.on.mock.calls.find(([event]: [string]) => event === 'error')?.[1]
    expect(() => errorHandler?.(new Error('archive failed'))).toThrow('archive failed')
  })

  it('POST /batch-download returns 404 for empty selections and forwards outer errors', async () => {
    mockPrisma.file.findMany.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('zip failed'))

    const empty = await request(makeApp()).post('/batch-download').set(authHeader).send({ fileIds: ['file-1'] })
    const failed = await request(makeApp()).post('/batch-download').set(authHeader).send({ fileIds: ['file-1'] })

    expect(empty.status).toBe(404)
    expect(empty.body).toEqual({ code: 'FILES_NOT_FOUND', message: 'No files found.' })
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'zip failed' })
  })
})
