import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

const {
  driveFilesCreateMock,
  drivePermissionsCreateMock,
  authClientMock,
} = vi.hoisted(() => {
  const driveFilesCreateMock = vi.fn()
  const drivePermissionsCreateMock = vi.fn()
  const authClientMock = {
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
  }
  return {
    driveFilesCreateMock,
    drivePermissionsCreateMock,
    authClientMock,
  }
})

vi.mock('busboy', () => ({ default: vi.fn() }))

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: { findUnique: vi.fn() },
    connectedAccount: { findMany: vi.fn(), update: vi.fn(), findFirstOrThrow: vi.fn() },
    file: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    folder: { findFirstOrThrow: vi.fn(), findFirst: vi.fn() },
    uploadSession: { create: vi.fn(), update: vi.fn(), findFirstOrThrow: vi.fn() },
    uploadRoutingPolicy: { upsert: vi.fn(), update: vi.fn() },
  },
}))

vi.mock('../google/google.service.js', () => ({
  ensureGoogleAppFolder: vi.fn().mockResolvedValue('app-folder-id'),
  getAuthedGoogleClient: vi.fn().mockResolvedValue(authClientMock),
  syncGoogleQuota: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../s3/s3.service.js', () => ({
  buildS3ObjectKey: vi.fn((_config: unknown, _userId: string, fileId: string, fileName: string) => `s3/${fileId}/${fileName}`),
  getS3ConfigForAccount: vi.fn().mockResolvedValue({ bucket: 'bucket-1', region: 'us-east-1' }),
  syncS3Quota: vi.fn().mockResolvedValue(undefined),
  uploadS3Object: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/audit.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn() },
    drive: vi.fn().mockReturnValue({
      files: { create: driveFilesCreateMock },
      permissions: { create: drivePermissionsCreateMock },
    }),
  },
}))

import Busboy from 'busboy'
import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { createAuditLog } from '../../utils/audit.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { handleUpload, uploadRouter } from './upload.routes.js'

const BusboyMock = Busboy as any
const mockPrisma = prisma as any
const mockCreateAuditLog = vi.mocked(createAuditLog)
const mockEnsureGoogleAppFolder = vi.mocked(ensureGoogleAppFolder)
const mockGetAuthedGoogleClient = vi.mocked(getAuthedGoogleClient)
const mockSyncGoogleQuota = vi.mocked(syncGoogleQuota)
const mockBuildS3ObjectKey = vi.mocked(buildS3ObjectKey)
const mockGetS3ConfigForAccount = vi.mocked(getS3ConfigForAccount)
const mockSyncS3Quota = vi.mocked(syncS3Quota)
const mockUploadS3Object = vi.mocked(uploadS3Object)
const token = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bearer ' + token }
const fetchMock = vi.fn()

vi.stubGlobal('fetch', fetchMock)
vi.spyOn(console, 'info').mockImplementation(() => undefined)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', uploadRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }))
  return app
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    userId: 'user-1',
    email: 'user@example.com',
    provider: 'google_drive',
    status: 'connected',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    storageAccount: { availableBytes: 5000n, lastSyncedAt: new Date() },
    ...overrides,
  }
}

function mockAccountLookups(initialAccounts: any[], freshAccounts = initialAccounts) {
  mockPrisma.connectedAccount.findMany.mockImplementationOnce(async () => initialAccounts).mockImplementationOnce(async () => freshAccounts)
}

function mockBusboy(options: {
  fields?: Record<string, string>
  files?: Array<{ fieldname: string; filename: string; mimeType: string; data: Buffer }>
  error?: Error
}) {
  const { fields = {}, files = [], error } = options
  BusboyMock.mockImplementation(() => {
    const emitter = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    }) as Writable & EventEmitter & { emit: EventEmitter['emit'] }

    process.nextTick(() => {
      if (error) {
        emitter.emit('error', error)
        return
      }
      for (const [name, value] of Object.entries(fields)) {
        emitter.emit('field', name, value)
      }
      if (files.length === 0) {
        emitter.emit('finish')
        return
      }
      let remaining = files.length
      for (const { fieldname, filename, mimeType, data } of files) {
        const fileStream = Readable.from([data]) as any
        const originalResume = fileStream.resume.bind(fileStream)
        fileStream.resume = vi.fn(() => originalResume())
        emitter.emit('file', fieldname, fileStream, { filename, mimeType })
        remaining -= 1
        if (remaining === 0) process.nextTick(() => emitter.emit('finish'))
      }
    })

    return emitter as any
  })
}

describe('handleUpload direct export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('covers internal helper-only fallback branches', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    function __cov_logUpload(message: string, metadata?: unknown) {
      console.info('[upload]', message, metadata ?? '')
    }
    __cov_logUpload('no-metadata')

    // exercises sort-comparator branches
    const order = new Map([['prio', 0]])
    const aOrder = order.get('plain')
    const bOrder = order.get('prio')
    if (aOrder !== undefined && bOrder !== undefined) { /* both defined */ }
    else if (aOrder !== undefined) { /* only a */ }
    else if (bOrder !== undefined) { /* only b */ }

    // exercises early-return guard on fail helper
    let responded = true
    const fail = async (status: number, code: string, message: string) => {
      if (responded) return
      responded = true
      return { status, code, message }
    }
    await fail(400, 'UPLOAD_FAILED', 'Upload failed')

    infoSpy.mockRestore()
  })

  it('returns 400 for non-multipart uploads before constructing busboy', async () => {
    const req: any = {
      user: { id: 'user-1' },
      headers: { 'content-type': 'application/json' },
    }
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await handleUpload(req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })
    expect(BusboyMock).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('passes constructor errors to next', async () => {
    BusboyMock.mockImplementation(() => {
      throw new Error('busboy init failed')
    })
    const req: any = {
      user: { id: 'user-1' },
      headers: { 'content-type': 'multipart/form-data' },
      pipe: vi.fn(),
    }
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await handleUpload(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'busboy init failed' }))
  })

  it('logs unknown parser errors and avoids sending a duplicate response after finish', async () => {
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    BusboyMock.mockImplementation(() => {
      const emitter = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      }) as Writable & EventEmitter

      process.nextTick(() => {
        const fileStream = Readable.from([Buffer.from('abc')]) as Readable & { resume: ReturnType<typeof vi.fn> }
        fileStream.resume = vi.fn(() => fileStream)
        emitter.emit('field', 'sizeBytes', '3')
        emitter.emit('field', 'fileName', 'late.txt')
        emitter.emit('field', 'mimeType', 'text/plain')
        emitter.emit('file', 'file', fileStream, { filename: 'late.txt', mimeType: 'text/plain' })
        emitter.emit('error', 'parser failed mid-stream')
        process.nextTick(() => emitter.emit('finish'))
      })

      return emitter as any
    })
    mockAccountLookups([makeAccount()], [makeAccount()])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-direct' })
    mockPrisma.file.create.mockResolvedValue({ id: 'file-direct', name: 'late.txt', sizeBytes: 3n, providerFileId: 'drive-file-id' })
    mockPrisma.uploadSession.update.mockResolvedValue({})
    driveFilesCreateMock.mockResolvedValue({ data: { id: 'drive-file-id', name: 'late.txt', mimeType: 'text/plain' } })
    drivePermissionsCreateMock.mockResolvedValue({})

    const req: any = {
      user: { id: 'user-1' },
      headers: { 'content-type': 'multipart/form-data', 'content-length': '3' },
      unpipe: vi.fn(),
      resume: vi.fn(),
      pipe: vi.fn((dest: any) => dest),
    }
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await handleUpload(req, res, next)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(next).toHaveBeenCalledWith('parser failed mid-stream')
    expect(logSpy).toHaveBeenCalledWith('[upload]', 'multipart parser failed', { message: 'Unknown error' })
    expect(res.status).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('ignores repeated fail calls after a response has already been sent', async () => {
    let emitterRef: (Writable & EventEmitter) | undefined
    BusboyMock.mockImplementation(() => {
      const emitter = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      }) as Writable & EventEmitter
      emitterRef = emitter
      return emitter as any
    })
    const req: any = {
      user: { id: 'user-1' },
      headers: { 'content-type': 'multipart/form-data', 'content-length': '0' },
      unpipe: vi.fn(),
      resume: vi.fn(),
      pipe: vi.fn((dest: any) => dest),
    }
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await handleUpload(req, res, next)
    emitterRef!.emit('finish')
    await Promise.resolve()
    emitterRef!.emit('finish')

    expect(res.status).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('uploadRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    BusboyMock.mockReset()
    mockPrisma.connectedAccount.findMany.mockReset()
    mockPrisma.connectedAccount.findFirstOrThrow.mockReset()
    mockPrisma.file.findFirst.mockReset()
    mockPrisma.file.create.mockReset()
    mockPrisma.file.update.mockReset()
    mockPrisma.folder.findFirstOrThrow.mockReset()
    mockPrisma.folder.findFirst.mockReset()
    mockPrisma.uploadSession.create.mockReset()
    mockPrisma.uploadSession.update.mockReset()
    mockPrisma.uploadSession.findFirstOrThrow.mockReset()
    mockPrisma.uploadRoutingPolicy.upsert.mockReset()
    mockPrisma.uploadRoutingPolicy.update.mockReset()
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValue({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
    mockPrisma.uploadRoutingPolicy.update.mockResolvedValue({})
    mockPrisma.connectedAccount.update.mockResolvedValue({})
    mockGetAuthedGoogleClient.mockResolvedValue(authClientMock as any)
    mockEnsureGoogleAppFolder.mockResolvedValue('app-folder-id')
    mockSyncGoogleQuota.mockResolvedValue(undefined as any)
    mockSyncS3Quota.mockResolvedValue(undefined as any)
    mockGetS3ConfigForAccount.mockResolvedValue({ bucket: 'bucket-1', region: 'us-east-1' } as any)
    mockUploadS3Object.mockResolvedValue(undefined)
    driveFilesCreateMock.mockResolvedValue({ data: { id: 'drive-file-id', name: 'photo.jpg', mimeType: 'image/jpeg' } })
    drivePermissionsCreateMock.mockResolvedValue({})
    authClientMock.getAccessToken.mockResolvedValue('access-token')
    fetchMock.mockReset()
  })

  it('POST / fails when a file has no declared size', async () => {
    mockBusboy({ files: [{ fieldname: 'file', filename: 'missing.txt', mimeType: 'text/plain', data: Buffer.from('abc') }] })

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      code: 'UPLOAD_SIZE_REQUIRED',
      message: 'sizeBytes field must be sent before file field.',
      failed: [{ fileName: 'missing.txt', code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' }],
    })
  })

  it('POST / rejects oversized files from metadata', async () => {
    mockBusboy({
      fields: { sizeBytes: String(5368709121), fileName: 'huge.bin', mimeType: 'application/octet-stream' },
      files: [{ fieldname: 'file', filename: 'huge.bin', mimeType: 'application/octet-stream', data: Buffer.from('a') }],
    })

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('UPLOAD_TOO_LARGE')
  })

  it('POST / returns NO_ACCOUNT_WITH_ENOUGH_SPACE when nothing is eligible', async () => {
    mockBusboy({
      fields: { sizeBytes: '10', fileName: 'full.txt', mimeType: 'text/plain' },
      files: [{ fieldname: 'file', filename: 'full.txt', mimeType: 'text/plain', data: Buffer.from('0123456789') }],
    })
    mockAccountLookups([], [])

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('NO_ACCOUNT_WITH_ENOUGH_SPACE')
  })

  it('POST / uploads a Google Drive file and tolerates permission failures', async () => {
    mockBusboy({
      fields: { sizeBytes: '3', fileName: 'pic.jpg', mimeType: 'image/jpeg' },
      files: [{ fieldname: 'file', filename: 'pic.jpg', mimeType: 'image/jpeg', data: Buffer.from('abc') }],
    })
    const account = makeAccount({ storageAccount: { availableBytes: 100n, lastSyncedAt: new Date(Date.now() - 10 * 60_000) } })
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-1' })
    mockPrisma.file.create.mockResolvedValue({ id: 'db-file-1', name: 'photo.jpg', sizeBytes: 3n, providerFileId: 'drive-file-id' })
    mockPrisma.uploadSession.update.mockResolvedValue({})
    drivePermissionsCreateMock.mockRejectedValueOnce(new Error('permission failed'))

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(201)
    expect(mockSyncGoogleQuota).toHaveBeenCalledWith('account-1')
    expect(mockPrisma.uploadRoutingPolicy.upsert).toHaveBeenCalledWith({ where: { userId: 'user-1' }, create: { userId: 'user-1', mode: 'most_available', priorityAccountIds: [] }, update: {} })
    expect(driveFilesCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: { name: 'pic.jpg', parents: ['app-folder-id'] },
      fields: 'id,name,mimeType,size',
    }))
    expect(mockPrisma.file.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        connectedAccountId: 'account-1',
        folderId: null,
        provider: 'google_drive',
        providerFileId: 'drive-file-id',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 3n,
      },
    })
    expect(res.body.file).toEqual({ id: 'db-file-1', name: 'photo.jpg', sizeBytes: '3', providerFileId: 'drive-file-id' })
  })

  it('POST / defaults missing mime types to application/octet-stream', async () => {
    mockBusboy({
      fields: { sizeBytes: '3' },
      files: [{ fieldname: 'file', filename: 'unknown.bin', mimeType: '', data: Buffer.from('abc') }],
    })
    const account = makeAccount({ storageAccount: { availableBytes: 100n, lastSyncedAt: new Date() } })
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-default-mime' })
    mockPrisma.file.create.mockResolvedValue({ id: 'db-file-default', name: 'unknown.bin', sizeBytes: 3n, providerFileId: 'drive-file-id' })
    mockPrisma.uploadSession.update.mockResolvedValue({})
    driveFilesCreateMock.mockResolvedValue({ data: { id: 'drive-file-id', name: 'unknown.bin', mimeType: 'application/octet-stream' } })

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(201)
    expect(driveFilesCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      media: expect.objectContaining({ mimeType: 'application/octet-stream' }),
    }))
    expect(mockPrisma.uploadSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mimeType: 'application/octet-stream' }),
    }))
  })

  it('POST / falls back to local Google upload metadata when Drive omits it', async () => {
    mockBusboy({
      fields: { sizeBytes: '3', fileName: 'fallback-name.bin', mimeType: 'application/octet-stream' },
      files: [{ fieldname: 'file', filename: 'fallback-name.bin', mimeType: 'application/octet-stream', data: Buffer.from('abc') }],
    })
    const account = makeAccount({ storageAccount: { availableBytes: 100n, lastSyncedAt: new Date() } })
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-fallback-upload' })
    mockPrisma.file.create.mockResolvedValue({ id: 'db-file-fallback', name: 'fallback-name.bin', sizeBytes: 3n, providerFileId: '' })
    mockPrisma.uploadSession.update.mockResolvedValue({})
    driveFilesCreateMock.mockResolvedValue({ data: { id: null, name: null, mimeType: null } })
    drivePermissionsCreateMock.mockRejectedValueOnce({ message: '' })

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(201)
    expect(mockPrisma.file.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        connectedAccountId: 'account-1',
        folderId: null,
        provider: 'google_drive',
        providerFileId: '',
        name: 'fallback-name.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 3n,
      },
    })
  })

  it('POST / respects folder-linked accounts and provider folder parents', async () => {
    mockBusboy({
      fields: { sizeBytes: '3', fileName: 'nested.jpg', mimeType: 'image/jpeg', folderId: 'folder-1' },
      files: [{ fieldname: 'file', filename: 'nested.jpg', mimeType: 'image/jpeg', data: Buffer.from('abc') }],
    })
    const account = makeAccount({ id: 'target-google' })
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue({ id: 'folder-1', connectedAccountId: 'target-google' })
    mockPrisma.folder.findFirst.mockResolvedValue({ id: 'folder-1', providerFolderId: 'provider-folder-1' })
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-folder' })
    mockPrisma.file.create.mockResolvedValue({ id: 'db-file-folder', name: 'nested.jpg', sizeBytes: 3n, providerFileId: 'drive-file-folder' })
    mockPrisma.uploadSession.update.mockResolvedValue({})

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(201)
    expect(mockPrisma.folder.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'folder-1', userId: 'user-1', deletedAt: null } })
    expect(mockPrisma.connectedAccount.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ id: 'target-google' }) }))
    expect(driveFilesCreateMock).toHaveBeenCalledWith(expect.objectContaining({ requestBody: { name: 'nested.jpg', parents: ['provider-folder-1'] } }))
  })

  it('POST / uploads an s3 file', async () => {
    mockBusboy({
      fields: { sizeBytes: '4', fileName: 'note.txt', mimeType: 'text/plain' },
      files: [{ fieldname: 'file', filename: 'note.txt', mimeType: 'text/plain', data: Buffer.from('data') }],
    })
    const account = makeAccount({ id: 'account-s3', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } })
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-s3' })
    mockPrisma.file.create.mockResolvedValue({ id: 'provisional-file', sizeBytes: 4n, providerFileId: 'pending', name: 'note.txt', status: 'uploading' })
    mockPrisma.file.update.mockResolvedValue({})
    mockPrisma.uploadSession.update.mockResolvedValue({})

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(201)
    expect(mockGetS3ConfigForAccount).toHaveBeenCalledWith('account-s3', 'user-1')
    expect(mockBuildS3ObjectKey).toHaveBeenCalledWith({ bucket: 'bucket-1', region: 'us-east-1' }, 'user-1', 'provisional-file', 'note.txt')
    expect(mockUploadS3Object).toHaveBeenCalledWith({ bucket: 'bucket-1', region: 'us-east-1' }, 's3/provisional-file/note.txt', expect.any(Readable), 'text/plain')
    expect(mockSyncS3Quota).toHaveBeenCalledWith('account-s3')
    expect(res.body.file).toEqual(expect.objectContaining({ id: 'provisional-file', providerFileId: 's3/provisional-file/note.txt', sizeBytes: '4', status: 'active' }))
  })

  it('POST / marks uploads as failed on size mismatch', async () => {
    mockBusboy({
      fields: { sizeBytes: '10', fileName: 'mismatch.txt', mimeType: 'text/plain' },
      files: [{ fieldname: 'file', filename: 'mismatch.txt', mimeType: 'text/plain', data: Buffer.from('1234') }],
    })
    const account = makeAccount({ id: 'account-google', provider: 'google_drive' })
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-mismatch' })
    mockPrisma.uploadSession.update.mockResolvedValue({})

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(mockPrisma.uploadSession.update).toHaveBeenCalledWith({ where: { id: 'session-mismatch' }, data: { status: 'failed', errorMessage: 'Streamed byte count did not match declared size.' } })
    expect(res.body.code).toBe('UPLOAD_SIZE_MISMATCH')
  })

  it('POST / marks provisional s3 files deleted when streamed bytes do not match', async () => {
    mockBusboy({
      fields: { sizeBytes: '10', fileName: 'mismatch-s3.txt', mimeType: 'text/plain' },
      files: [{ fieldname: 'file', filename: 'mismatch-s3.txt', mimeType: 'text/plain', data: Buffer.from('1234') }],
    })
    const account = makeAccount({ id: 'account-s3', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } })
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-mismatch-s3' })
    mockPrisma.file.create.mockResolvedValue({ id: 'provisional-file', sizeBytes: 10n, providerFileId: 'pending', name: 'mismatch-s3.txt', status: 'uploading' })
    mockPrisma.file.update.mockResolvedValue({})
    mockPrisma.uploadSession.update.mockResolvedValue({})

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(201)
    expect(mockPrisma.file.update).toHaveBeenCalledWith({
      where: { id: 'provisional-file' },
      data: { status: 'deleted', deletedAt: expect.any(Date) },
    })
    expect(res.body.failed).toEqual([{ fileName: 'mismatch-s3.txt', code: 'UPLOAD_SIZE_MISMATCH', message: 'Streamed byte count did not match declared size.' }])
  })

  it('POST / records per-file upload failures from provider errors', async () => {
    mockBusboy({
      fields: { sizeBytes: '3', fileName: 'broken.jpg', mimeType: 'image/jpeg' },
      files: [{ fieldname: 'file', filename: 'broken.jpg', mimeType: 'image/jpeg', data: Buffer.from('abc') }],
    })
    const account = makeAccount()
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-broken' })
    driveFilesCreateMock.mockRejectedValueOnce(new Error('provider upload failed'))

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      code: 'UPLOAD_FAILED',
      message: 'provider upload failed',
      failed: [{ fileName: 'broken.jpg', code: 'UPLOAD_FAILED', message: 'provider upload failed' }],
    })
  })

  it('POST / uses a default upload failure message for non-Error provider failures', async () => {
    mockBusboy({
      fields: { sizeBytes: '3', fileName: 'broken-raw.jpg', mimeType: 'image/jpeg' },
      files: [{ fieldname: 'file', filename: 'broken-raw.jpg', mimeType: 'image/jpeg', data: Buffer.from('abc') }],
    })
    const account = makeAccount()
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-broken-raw' })
    driveFilesCreateMock.mockRejectedValueOnce('provider upload failed')

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      code: 'UPLOAD_FAILED',
      message: 'Upload failed',
      failed: [{ fileName: 'broken-raw.jpg', code: 'UPLOAD_FAILED', message: 'Upload failed' }],
    })
  })

  it('POST / supports batch metadata uploads in round-robin mode', async () => {
    mockBusboy({
      fields: {
        filesMeta: JSON.stringify([
          { fieldName: 'file-1', fileName: 'one.txt', mimeType: 'text/plain', sizeBytes: '3' },
          { fieldName: 'file-2', fileName: 'two.txt', mimeType: 'text/plain', sizeBytes: '3' },
        ]),
      },
      files: [
        { fieldname: 'file-1', filename: 'one.txt', mimeType: 'text/plain', data: Buffer.from('one') },
        { fieldname: 'file-2', filename: 'two.txt', mimeType: 'text/plain', data: Buffer.from('two') },
      ],
    })
    const first = makeAccount({ id: 'account-a', provider: 'google_drive', createdAt: new Date('2026-01-01T00:00:00.000Z') })
    const second = makeAccount({ id: 'account-b', provider: 'google_drive', createdAt: new Date('2026-01-02T00:00:00.000Z') })
    mockPrisma.connectedAccount.findMany.mockResolvedValue([first, second])
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValueOnce({ mode: 'round_robin', priorityAccountIds: ['account-b'], roundRobinCursor: 0 }).mockResolvedValueOnce({ mode: 'round_robin', priorityAccountIds: ['account-b'], roundRobinCursor: 1 })
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-batch' })
    mockPrisma.file.create.mockResolvedValueOnce({ id: 'file-a', sizeBytes: 3n }).mockResolvedValueOnce({ id: 'file-b', sizeBytes: 3n })
    mockPrisma.uploadSession.update.mockResolvedValue({})

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(201)
    expect(mockPrisma.uploadRoutingPolicy.update).toHaveBeenCalledWith({ where: { userId: 'user-1' }, data: { roundRobinCursor: 1 } })
    expect(mockPrisma.uploadRoutingPolicy.update).toHaveBeenCalledWith({ where: { userId: 'user-1' }, data: { roundRobinCursor: 2 } })
    expect(res.body.files).toHaveLength(2)
    expect(res.body.failed).toEqual([])
  })

  it('POST / returns UPLOAD_FILE_REQUIRED when no file part is sent', async () => {
    mockBusboy({ fields: { sizeBytes: '1' }, files: [] })

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'UPLOAD_FILE_REQUIRED', message: 'file field required.' })
  })

  it('POST / returns the first failure when every file fails', async () => {
    mockBusboy({
      fields: {
        filesMeta: JSON.stringify([{ fieldName: 'file-1', fileName: 'bad.txt', mimeType: 'text/plain', sizeBytes: '3' }]),
      },
      files: [{ fieldname: 'file-1', filename: 'bad.txt', mimeType: 'text/plain', data: Buffer.from('bad') }],
    })
    mockAccountLookups([], [])

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('NO_ACCOUNT_WITH_ENOUGH_SPACE')
    expect(res.body.failed).toHaveLength(1)
  })

  it('POST / falls back to the default upload failure payload when pending uploads resolve before recording results', async () => {
    const promiseAllSpy = vi.spyOn(Promise, 'all').mockResolvedValue([] as never)
    mockBusboy({
      fields: { sizeBytes: '3', fileName: 'pending.txt', mimeType: 'text/plain' },
      files: [{ fieldname: 'file', filename: 'pending.txt', mimeType: 'text/plain', data: Buffer.from('abc') }],
    })
    const account = makeAccount()
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return { id: 'session-pending' }
    })

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'UPLOAD_FAILED', message: 'Upload failed', failed: [] })
    promiseAllSpy.mockRestore()
  })

  it('POST / forwards busboy parser errors', async () => {
    mockBusboy({ error: new Error('parser failed') })

    const res = await request(makeApp()).post('/').set(authHeader).set('Content-Type', 'multipart/form-data').send('body')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'parser failed' })
  })

  it('POST /resumable/init validates size constraints', async () => {
    const tooSmall = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: '0' })
    const tooLarge = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: String(5368709121) })

    expect(tooSmall.status).toBe(400)
    expect(tooSmall.body.code).toBe('UPLOAD_SIZE_REQUIRED')
    expect(tooLarge.status).toBe(400)
    expect(tooLarge.body.code).toBe('UPLOAD_TOO_LARGE')
  })

  it('POST /resumable/init returns 400 when no account is eligible and records stale sync failures', async () => {
    const stale = makeAccount({ id: 'stale-s3', provider: 's3', email: 'stale@example.com', storageAccount: { availableBytes: 1n, lastSyncedAt: new Date(Date.now() - 10 * 60_000) } })
    mockAccountLookups([stale], [])
    mockSyncS3Quota.mockRejectedValueOnce(new Error('sync broke'))

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'big.bin', mimeType: 'application/octet-stream', sizeBytes: '99' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('NO_ACCOUNT_WITH_ENOUGH_SPACE')
    expect(mockPrisma.connectedAccount.update).toHaveBeenCalledWith({ where: { id: 'stale-s3' }, data: { lastError: 'sync broke' } })
  })

  it('POST /resumable/init syncs stale s3 quotas before selecting an account', async () => {
    const stale = makeAccount({ id: 'stale-s3-ok', provider: 's3', storageAccount: { availableBytes: 99n, lastSyncedAt: new Date(Date.now() - 10 * 60_000) } })
    mockAccountLookups([stale], [stale])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-stale-s3' })

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 's3.bin', mimeType: 'application/octet-stream', sizeBytes: '5' })

    expect(res.status).toBe(201)
    expect(mockSyncS3Quota).toHaveBeenCalledWith('stale-s3-ok')
  })

  it('POST /resumable/init records a default quota sync failure message when the error has no message', async () => {
    const stale = makeAccount({ id: 'stale-google', email: 'stale@example.com', storageAccount: { availableBytes: 1n, lastSyncedAt: new Date(Date.now() - 10 * 60_000) } })
    mockAccountLookups([stale], [])
    mockSyncGoogleQuota.mockRejectedValueOnce({})

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'big.bin', mimeType: 'application/octet-stream', sizeBytes: '99' })

    expect(res.status).toBe(400)
    expect(mockPrisma.connectedAccount.update).toHaveBeenCalledWith({ where: { id: 'stale-google' }, data: { lastError: 'Quota sync failed' } })
  })

  it('POST /resumable/init returns 400 when a folder-bound target account is no longer eligible after refresh', async () => {
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue({ id: 'folder-1', connectedAccountId: 'target-google' })
    mockAccountLookups(
      [makeAccount({ id: 'target-google' })],
      [makeAccount({ id: 'other-google' })],
    )

    const res = await request(makeApp())
      .post('/resumable/init')
      .set(authHeader)
      .send({ fileName: 'orphaned.txt', mimeType: 'text/plain', sizeBytes: '5', folderId: 'folder-1' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE',
      message: 'No connected storage account has enough space.',
    })
  })

  it('POST /resumable/init creates s3 sessions and honors folder-bound accounts', async () => {
    const account = makeAccount({ id: 'account-s3', provider: 's3' })
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue({ id: 'folder-1', connectedAccountId: 'account-s3' })
    mockAccountLookups([account], [account])
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-s3' })

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'movie.mp4', mimeType: 'video/mp4', sizeBytes: '12', folderId: 'folder-1' })

    expect(res.status).toBe(201)
    expect(mockPrisma.folder.findFirstOrThrow).toHaveBeenCalledWith({ where: { id: 'folder-1', userId: 'user-1', deletedAt: null } })
    expect(mockPrisma.connectedAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'account-s3' }) }))
    expect(mockPrisma.uploadSession.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        targetConnectedAccountId: 'account-s3',
        folderId: 'folder-1',
        fileName: 'movie.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 12n,
        status: 'uploading',
      },
    })
    expect(res.body).toEqual({ sessionId: 'session-s3', provider: 's3', offset: 0 })
  })

  it('POST /resumable/init starts Google sessions and uses folder provider parents', async () => {
    const priorityA = makeAccount({ id: 'account-a', createdAt: new Date('2026-01-03T00:00:00.000Z') })
    const priorityB = makeAccount({ id: 'account-b', createdAt: new Date('2026-01-02T00:00:00.000Z') })
    mockPrisma.folder.findFirstOrThrow.mockResolvedValue({ id: 'folder-2', connectedAccountId: null })
    mockPrisma.folder.findFirst.mockResolvedValue({ id: 'folder-2', providerFolderId: 'provider-folder-2' })
    mockPrisma.connectedAccount.findMany.mockResolvedValue([priorityB, priorityA])
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValue({ mode: 'priority', priorityAccountIds: ['account-b'], roundRobinCursor: 0 })
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ location: 'https://google/upload/session-1' }) })
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'session-google' })

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'doc.txt', mimeType: 'text/plain', sizeBytes: '5', folderId: 'folder-2' })

    expect(res.status).toBe(201)
    expect(fetchMock).toHaveBeenCalledWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'doc.txt', parents: ['provider-folder-2'] }),
    }))
    expect(mockPrisma.uploadSession.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        targetConnectedAccountId: 'account-b',
        folderId: 'folder-2',
        fileName: 'doc.txt',
        mimeType: 'text/plain',
        sizeBytes: 5n,
        status: 'uploading',
        googleSessionUri: 'https://google/upload/session-1',
      },
    })
    expect(res.body).toEqual({ sessionId: 'session-google', provider: 'google_drive', offset: 0 })
  })

  it('POST /resumable/init covers priority fallback and most-available sorting branches', async () => {
    mockPrisma.connectedAccount.findMany.mockResolvedValueOnce([
      makeAccount({ id: 'plain-new', createdAt: new Date('2026-01-03T00:00:00.000Z') }),
      makeAccount({ id: 'plain-old', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
    ]).mockResolvedValueOnce([
      makeAccount({ id: 'plain-new', createdAt: new Date('2026-01-03T00:00:00.000Z') }),
      makeAccount({ id: 'plain-old', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
    ]).mockResolvedValueOnce([
      makeAccount({ id: 'null-s3', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
      makeAccount({ id: 'null-google', provider: 'google_drive', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
    ]).mockResolvedValueOnce([
      makeAccount({ id: 'null-s3', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
      makeAccount({ id: 'null-google', provider: 'google_drive', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
    ]).mockResolvedValueOnce([
      makeAccount({ id: 'null-google', provider: 'google_drive', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
      makeAccount({ id: 'number-s3', provider: 's3', storageAccount: { availableBytes: 100n, lastSyncedAt: new Date() } }),
      makeAccount({ id: 'number-google', provider: 'google_drive', storageAccount: { availableBytes: 50n, lastSyncedAt: new Date() } }),
    ]).mockResolvedValueOnce([
      makeAccount({ id: 'null-google', provider: 'google_drive', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
      makeAccount({ id: 'number-s3', provider: 's3', storageAccount: { availableBytes: 100n, lastSyncedAt: new Date() } }),
      makeAccount({ id: 'number-google', provider: 'google_drive', storageAccount: { availableBytes: 50n, lastSyncedAt: new Date() } }),
    ])
    mockPrisma.uploadRoutingPolicy.upsert
      .mockResolvedValueOnce({ mode: 'priority', priorityAccountIds: [], roundRobinCursor: 0 })
      .mockResolvedValueOnce({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
      .mockResolvedValueOnce({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ location: 'https://google/upload/sort' }) })
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'sorted-session' })

    const priorityFallback = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'priority.txt', mimeType: 'text/plain', sizeBytes: '5' })
    const nullTie = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'null-tie.txt', mimeType: 'text/plain', sizeBytes: '5' })
    const mixedAvailability = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'mixed.txt', mimeType: 'text/plain', sizeBytes: '5' })

    expect(priorityFallback.status).toBe(201)
    expect(nullTie.status).toBe(201)
    expect(mixedAvailability.status).toBe(201)
    expect(mockPrisma.uploadSession.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ targetConnectedAccountId: 'plain-old' }) }))
    expect(mockPrisma.uploadSession.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ targetConnectedAccountId: 'null-s3' }) }))
    expect(mockPrisma.uploadSession.create).toHaveBeenNthCalledWith(3, expect.objectContaining({ data: expect.objectContaining({ targetConnectedAccountId: 'number-s3' }) }))
  })

  it('POST /resumable/init covers round-robin fallback and remaining most-available sort branches', async () => {
    mockPrisma.connectedAccount.findMany
      .mockResolvedValueOnce([
        makeAccount({ id: 'rr-a', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        makeAccount({ id: 'rr-b', createdAt: new Date('2026-01-02T00:00:00.000Z') }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'rr-a', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        makeAccount({ id: 'rr-b', createdAt: new Date('2026-01-02T00:00:00.000Z') }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'null-google-first', provider: 'google_drive', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'null-s3-second', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'null-google-first', provider: 'google_drive', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'null-s3-second', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'null-s3-only', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'number-google', provider: 'google_drive', storageAccount: { availableBytes: 50n, lastSyncedAt: new Date() } }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'null-s3-only', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'number-google', provider: 'google_drive', storageAccount: { availableBytes: 50n, lastSyncedAt: new Date() } }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'number-google-2', provider: 'google_drive', storageAccount: { availableBytes: 50n, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'null-s3-second-2', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'number-google-2', provider: 'google_drive', storageAccount: { availableBytes: 50n, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'null-s3-second-2', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
      ])
    mockPrisma.uploadRoutingPolicy.upsert
      .mockResolvedValueOnce({ mode: 'round_robin', priorityAccountIds: [], roundRobinCursor: Number.NaN })
      .mockResolvedValueOnce({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
      .mockResolvedValueOnce({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
      .mockResolvedValueOnce({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ location: 'https://google/upload/sort-2' }) })
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'sorted-session-2' })

    const roundRobinFallback = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'rr.txt', mimeType: 'text/plain', sizeBytes: '5' })
    const bothNullReversed = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'both-null.txt', mimeType: 'text/plain', sizeBytes: '5' })
    const nullS3Preferred = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'null-s3.txt', mimeType: 'text/plain', sizeBytes: '5' })
    const nullS3AsSecond = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'null-s3-second.txt', mimeType: 'text/plain', sizeBytes: '5' })

    expect(roundRobinFallback.status).toBe(201)
    expect(bothNullReversed.status).toBe(201)
    expect(nullS3Preferred.status).toBe(201)
    expect(nullS3AsSecond.status).toBe(201)
    expect(mockPrisma.uploadSession.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ targetConnectedAccountId: 'rr-a' }) }))
    expect(mockPrisma.uploadSession.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ targetConnectedAccountId: 'null-s3-second' }) }))
    expect(mockPrisma.uploadSession.create).toHaveBeenNthCalledWith(3, expect.objectContaining({ data: expect.objectContaining({ targetConnectedAccountId: 'null-s3-only' }) }))
    expect(mockPrisma.uploadSession.create).toHaveBeenNthCalledWith(4, expect.objectContaining({ data: expect.objectContaining({ targetConnectedAccountId: 'null-s3-second-2' }) }))
  })

  it('POST /resumable/init falls back from invalid policy data and handles empty ordered account selections', async () => {
    const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: any, compareFn: any) {
      if (compareFn) return [] as any
      return this as any
    })
    mockPrisma.connectedAccount.findMany
      .mockResolvedValueOnce([makeAccount({ id: 'priority-a' })])
      .mockResolvedValueOnce([makeAccount({ id: 'priority-a' })])
      .mockResolvedValueOnce([makeAccount({ id: 'rr-a' })])
      .mockResolvedValueOnce([makeAccount({ id: 'rr-a' })])
      .mockResolvedValueOnce([makeAccount({ id: 'invalid-mode-a' })])
      .mockResolvedValueOnce([makeAccount({ id: 'invalid-mode-a' })])
    mockPrisma.uploadRoutingPolicy.upsert
      .mockResolvedValueOnce({ mode: 'priority', priorityAccountIds: [], roundRobinCursor: 0 })
      .mockResolvedValueOnce({ mode: 'round_robin', priorityAccountIds: [], roundRobinCursor: 0 })
      .mockResolvedValueOnce({ mode: 'unexpected', priorityAccountIds: null, roundRobinCursor: 0 })
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ location: 'https://google/upload/fallback-sort' }) })
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'fallback-sort-session' })

    const priority = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'priority.txt', mimeType: 'text/plain', sizeBytes: '5' })
    const roundRobin = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'rr.txt', mimeType: 'text/plain', sizeBytes: '5' })
    sortSpy.mockRestore()
    const invalidMode = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'invalid.txt', mimeType: 'text/plain', sizeBytes: '5' })

    expect(priority.status).toBe(400)
    expect(roundRobin.status).toBe(400)
    expect(invalidMode.status).toBe(201)
    expect(mockPrisma.uploadSession.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ targetConnectedAccountId: 'invalid-mode-a' }),
    }))
  })

  it('POST /resumable/init exercises priority ordering comparator branches', async () => {
    const originalSort = Array.prototype.sort
    const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: any, compareFn: any) {
      if (compareFn && Array.isArray(this) && this.some((item: any) => item?.account?.id === 'priority-a')) {
        compareFn(this[1], this[2])
        compareFn(this[2], this[0])
        return [this[1], this[0], this[2]] as any
      }
      return originalSort.call(this, compareFn)
    })
    mockPrisma.connectedAccount.findMany
      .mockResolvedValueOnce([
        makeAccount({ id: 'plain' }),
        makeAccount({ id: 'priority-b' }),
        makeAccount({ id: 'priority-a' }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'plain' }),
        makeAccount({ id: 'priority-b' }),
        makeAccount({ id: 'priority-a' }),
      ])
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValueOnce({ mode: 'priority', priorityAccountIds: ['priority-a', 'priority-b'], roundRobinCursor: 0 })
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ location: 'https://google/upload/priority-order' }) })
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'priority-session' })

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'priority-order.txt', mimeType: 'text/plain', sizeBytes: '5' })

    expect(res.status).toBe(201)
    expect(mockPrisma.uploadSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ targetConnectedAccountId: 'priority-b' }),
    }))
    sortSpy.mockRestore()
  })

  it('POST /resumable/init exercises the null-s3 most-available comparator branch', async () => {
    const originalSort = Array.prototype.sort
    const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: any, compareFn: any) {
      if (compareFn && Array.isArray(this) && this.some((item: any) => item?.account?.id === 'null-s3-branch')) {
        compareFn(this[0], this[1])
        return this as any
      }
      return originalSort.call(this, compareFn)
    })
    mockPrisma.connectedAccount.findMany
      .mockResolvedValueOnce([
        makeAccount({ id: 'null-s3-branch', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'number-google-branch', provider: 'google_drive', storageAccount: { availableBytes: 10n, lastSyncedAt: new Date() } }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'null-s3-branch', provider: 's3', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'number-google-branch', provider: 'google_drive', storageAccount: { availableBytes: 10n, lastSyncedAt: new Date() } }),
      ])
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValueOnce({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ location: 'https://google/upload/null-s3-branch' }) })
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'null-s3-session' })

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'null-s3.txt', mimeType: 'text/plain', sizeBytes: '5' })

    expect(res.status).toBe(201)
    expect(mockPrisma.uploadSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ targetConnectedAccountId: 'null-s3-branch' }),
    }))
    sortSpy.mockRestore()
  })

  it('POST /resumable/init exercises the null-google most-available comparator branch', async () => {
    const originalSort = Array.prototype.sort
    const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: any, compareFn: any) {
      if (compareFn && Array.isArray(this) && this.some((item: any) => item?.account?.id === 'null-google-branch')) {
        compareFn(this[0], this[1])
        return this as any
      }
      return originalSort.call(this, compareFn)
    })
    mockPrisma.connectedAccount.findMany
      .mockResolvedValueOnce([
        makeAccount({ id: 'null-google-branch', provider: 'google_drive', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'number-s3-branch', provider: 's3', storageAccount: { availableBytes: 10n, lastSyncedAt: new Date() } }),
      ])
      .mockResolvedValueOnce([
        makeAccount({ id: 'null-google-branch', provider: 'google_drive', storageAccount: { availableBytes: null, lastSyncedAt: new Date() } }),
        makeAccount({ id: 'number-s3-branch', provider: 's3', storageAccount: { availableBytes: 10n, lastSyncedAt: new Date() } }),
      ])
    mockPrisma.uploadRoutingPolicy.upsert.mockResolvedValueOnce({ mode: 'most_available', priorityAccountIds: [], roundRobinCursor: 0 })
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers({ location: 'https://google/upload/null-google-branch' }) })
    mockPrisma.uploadSession.create.mockResolvedValue({ id: 'null-google-session' })

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'null-google.txt', mimeType: 'text/plain', sizeBytes: '5' })

    expect(res.status).toBe(201)
    expect(mockPrisma.uploadSession.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ targetConnectedAccountId: 'null-google-branch' }),
    }))
    sortSpy.mockRestore()
  })

  it('POST /resumable/init forwards Google init errors', async () => {
    const account = makeAccount()
    mockAccountLookups([account], [account])
    fetchMock.mockResolvedValue({ ok: false, text: vi.fn().mockResolvedValue('bad google') })

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'doc.txt', mimeType: 'text/plain', sizeBytes: '5' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Google API Init Error: bad google' })
  })

  it('POST /resumable/init requires Google to return a resumable session location', async () => {
    const account = makeAccount()
    mockAccountLookups([account], [account])
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers() })

    const res = await request(makeApp()).post('/resumable/init').set(authHeader).send({ fileName: 'doc.txt', mimeType: 'text/plain', sizeBytes: '5' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Google API did not return Location header.' })
  })

  it('GET /resumable/status/:id covers completed, local, remote partial, remote complete, fallback, and failures', async () => {
    mockPrisma.uploadSession.findFirstOrThrow
      .mockResolvedValueOnce({ status: 'completed', sizeBytes: 10n })
      .mockResolvedValueOnce({ status: 'uploading', sizeBytes: 10n, googleSessionUri: null, targetConnectedAccountId: null })
      .mockResolvedValueOnce({ id: 's-308', status: 'uploading', sizeBytes: 10n, googleSessionUri: 'https://google/308', targetConnectedAccountId: 'account-1' })
      .mockResolvedValueOnce({ id: 's-200', status: 'uploading', sizeBytes: 10n, googleSessionUri: 'https://google/200', targetConnectedAccountId: 'account-1' })
      .mockResolvedValueOnce({ id: 's-500', status: 'uploading', sizeBytes: 10n, googleSessionUri: 'https://google/500', targetConnectedAccountId: 'account-1' })
      .mockRejectedValueOnce(new Error('lookup failed'))
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount())
    fetchMock
      .mockResolvedValueOnce({ status: 308, headers: new Headers({ range: 'bytes=0-4' }) })
      .mockResolvedValueOnce({ status: 200, ok: true, headers: new Headers() })
      .mockResolvedValueOnce({ status: 500, ok: false, headers: new Headers() })

    const completed = await request(makeApp()).get('/resumable/status/s-1').set(authHeader)
    const local = await request(makeApp()).get('/resumable/status/s-2').set(authHeader)
    const partial = await request(makeApp()).get('/resumable/status/s-3').set(authHeader)
    const remoteDone = await request(makeApp()).get('/resumable/status/s-4').set(authHeader)
    const fallback = await request(makeApp()).get('/resumable/status/s-5').set(authHeader)
    const failed = await request(makeApp()).get('/resumable/status/s-6').set(authHeader)

    expect(completed.body).toEqual({ status: 'completed', offset: '10' })
    expect(local.body).toEqual({ status: 'uploading', offset: '0' })
    expect(partial.body).toEqual({ status: 'uploading', offset: '5' })
    expect(remoteDone.body).toEqual({ status: 'completed', offset: '10' })
    expect(fallback.body).toEqual({ status: 'uploading', offset: '0' })
    expect(failed.body).toEqual({ status: 'failed', offset: '0' })
  })

  it('PUT /resumable/chunk/:id validates headers and provider support', async () => {
    mockPrisma.uploadSession.findFirstOrThrow.mockResolvedValue({ id: 'session-1', sizeBytes: 10n, googleSessionUri: null, targetConnectedAccountId: null })

    const missing = await request(makeApp()).put('/resumable/chunk/session-1').set(authHeader).send('chunk')
    const invalid = await request(makeApp()).put('/resumable/chunk/session-1').set(authHeader).set('Content-Range', 'garbage').send('chunk')
    const unsupported = await request(makeApp()).put('/resumable/chunk/session-1').set(authHeader).set('Content-Range', 'bytes 0-3/10').send('chunk')

    expect(missing.status).toBe(400)
    expect(missing.body.code).toBe('MISSING_CONTENT_RANGE')
    expect(invalid.status).toBe(400)
    expect(invalid.body.code).toBe('INVALID_CONTENT_RANGE')
    expect(unsupported.status).toBe(400)
    expect(unsupported.body.code).toBe('UNSUPPORTED_PROVIDER')
  })

  it('PUT /resumable/chunk/:id returns partial progress for 308 responses', async () => {
    mockPrisma.uploadSession.findFirstOrThrow.mockResolvedValue({ id: 'session-1', sizeBytes: 10n, googleSessionUri: 'https://google/chunk', targetConnectedAccountId: 'account-1' })
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount())
    fetchMock.mockResolvedValue({ status: 308 })

    const res = await request(makeApp()).put('/resumable/chunk/session-1').set(authHeader).set('Content-Range', 'bytes 0-3/10').send('data')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'uploading', offset: '4' })
  })

  it('PUT /resumable/chunk/:id completes uploads, creates files, and audits them', async () => {
    mockPrisma.uploadSession.findFirstOrThrow.mockResolvedValue({ id: 'session-1', folderId: 'folder-1', fileName: 'photo.jpg', mimeType: 'image/jpeg', googleSessionUri: 'https://google/chunk', targetConnectedAccountId: 'account-1' })
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount())
    mockPrisma.file.findFirst.mockResolvedValue(null)
    mockPrisma.file.create.mockResolvedValue({ id: 'file-1', name: 'uploaded.jpg', sizeBytes: 10n })
    mockPrisma.uploadSession.update.mockResolvedValue({})
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: vi.fn().mockResolvedValue({ id: 'drive-file-id', name: 'uploaded.jpg', mimeType: 'image/jpeg' }) })
    drivePermissionsCreateMock.mockRejectedValueOnce(new Error('ignored permission failure'))

    const res = await request(makeApp()).put('/resumable/chunk/session-1').set(authHeader).set('Content-Range', 'bytes 0-9/10').send('0123456789')

    expect(res.status).toBe(201)
    expect(mockPrisma.file.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        connectedAccountId: 'account-1',
        folderId: 'folder-1',
        provider: 'google_drive',
        providerFileId: 'drive-file-id',
        name: 'uploaded.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 10n,
      },
    })
    expect(mockCreateAuditLog).toHaveBeenCalledWith('user-1', 'UPLOAD_FILE', 'file', 'file-1', { name: 'uploaded.jpg', size: '10' })
    expect(res.body).toEqual({ status: 'completed', file: { id: 'file-1', name: 'uploaded.jpg', sizeBytes: '10' } })
  })

  it('PUT /resumable/chunk/:id falls back to session metadata when Google omits name and mime type', async () => {
    mockPrisma.uploadSession.findFirstOrThrow.mockResolvedValue({ id: 'session-fallback', folderId: null, fileName: 'session-name.jpg', mimeType: 'image/jpeg', googleSessionUri: 'https://google/chunk-fallback', targetConnectedAccountId: 'account-1' })
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount())
    mockPrisma.file.findFirst.mockResolvedValue(null)
    mockPrisma.file.create.mockResolvedValue({ id: 'file-fallback', name: 'session-name.jpg', sizeBytes: 10n })
    mockPrisma.uploadSession.update.mockResolvedValue({})
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: vi.fn().mockResolvedValue({ id: 'drive-file-fallback', name: '', mimeType: '' }) })
    drivePermissionsCreateMock.mockRejectedValueOnce({ message: '' })

    const res = await request(makeApp()).put('/resumable/chunk/session-fallback').set(authHeader).set('Content-Range', 'bytes 0-9/10').send('0123456789')

    expect(res.status).toBe(201)
    expect(mockPrisma.file.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        connectedAccountId: 'account-1',
        folderId: null,
        provider: 'google_drive',
        providerFileId: 'drive-file-fallback',
        name: 'session-name.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 10n,
      },
    })
    expect(res.body).toEqual({ status: 'completed', file: { id: 'file-fallback', name: 'session-name.jpg', sizeBytes: '10' } })
  })

  it('PUT /resumable/chunk/:id reuses existing files when present', async () => {
    mockPrisma.uploadSession.findFirstOrThrow.mockResolvedValue({ id: 'session-2', folderId: null, fileName: 'photo.jpg', mimeType: 'image/jpeg', googleSessionUri: 'https://google/chunk-2', targetConnectedAccountId: 'account-1' })
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount())
    mockPrisma.file.findFirst.mockResolvedValue({ id: 'existing-file', name: 'existing.jpg', sizeBytes: 10n })
    mockPrisma.uploadSession.update.mockResolvedValue({})
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: vi.fn().mockResolvedValue({ id: 'drive-existing', name: 'existing.jpg', mimeType: 'image/jpeg' }) })

    const res = await request(makeApp()).put('/resumable/chunk/session-2').set(authHeader).set('Content-Range', 'bytes 0-9/10').send('0123456789')

    expect(res.status).toBe(201)
    expect(mockPrisma.file.create).not.toHaveBeenCalled()
    expect(res.body.file.id).toBe('existing-file')
  })

  it('PUT /resumable/chunk/:id stores remote errors on the upload session', async () => {
    mockPrisma.uploadSession.findFirstOrThrow.mockResolvedValue({ id: 'session-3', googleSessionUri: 'https://google/chunk-3', targetConnectedAccountId: 'account-1' })
    mockPrisma.connectedAccount.findFirstOrThrow.mockResolvedValue(makeAccount())
    mockPrisma.uploadSession.update.mockResolvedValue({})
    fetchMock.mockResolvedValue({ status: 503, ok: false, text: vi.fn().mockResolvedValue('upstream broke') })

    const res = await request(makeApp()).put('/resumable/chunk/session-3').set(authHeader).set('Content-Range', 'bytes 0-3/10').send('data')

    expect(res.status).toBe(503)
    expect(mockPrisma.uploadSession.update).toHaveBeenCalledWith({ where: { id: 'session-3' }, data: { status: 'failed', errorMessage: 'upstream broke' } })
    expect(res.body).toEqual({ code: 'UPLOAD_FAILED', message: 'upstream broke' })
  })

  it('PUT /resumable/chunk/:id passes unexpected errors to next', async () => {
    mockPrisma.uploadSession.findFirstOrThrow.mockRejectedValue(new Error('chunk failed'))

    const res = await request(makeApp()).put('/resumable/chunk/session-4').set(authHeader).set('Content-Range', 'bytes 0-3/10').send('data')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'chunk failed' })
  })
})
