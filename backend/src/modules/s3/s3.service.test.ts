import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockFindFirstOrThrow,
  mockStorageAccountUpsert,
  mockDecryptText,
  mockSend,
  mockS3Client,
  mockUploadDone,
  mockUpload,
  mockHeadBucketCommand,
  mockDeleteObjectCommand,
  mockGetObjectCommand,
  mockListObjectsV2Command,
} = vi.hoisted(() => {
  const mockFindFirstOrThrow = vi.fn()
  const mockStorageAccountUpsert = vi.fn()
  const mockDecryptText = vi.fn()
  const mockSend = vi.fn()
  const mockS3Client = vi.fn().mockImplementation(() => ({ send: mockSend }))
  const mockUploadDone = vi.fn()
  const mockUpload = vi.fn().mockImplementation(() => ({ done: mockUploadDone }))
  const mockHeadBucketCommand = vi.fn().mockImplementation((params: unknown) => ({ type: 'HeadBucket', params }))
  const mockDeleteObjectCommand = vi.fn().mockImplementation((params: unknown) => ({ type: 'DeleteObject', params }))
  const mockGetObjectCommand = vi.fn().mockImplementation((params: unknown) => ({ type: 'GetObject', params }))
  const mockListObjectsV2Command = vi.fn().mockImplementation((params: unknown) => ({ type: 'ListObjectsV2', params }))

  return {
    mockFindFirstOrThrow,
    mockStorageAccountUpsert,
    mockDecryptText,
    mockSend,
    mockS3Client,
    mockUploadDone,
    mockUpload,
    mockHeadBucketCommand,
    mockDeleteObjectCommand,
    mockGetObjectCommand,
    mockListObjectsV2Command,
  }
})

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    s3StorageConfig: { findFirstOrThrow: mockFindFirstOrThrow },
    storageAccount: { upsert: mockStorageAccountUpsert },
  },
}))

vi.mock('../../utils/crypto.js', () => ({
  decryptText: mockDecryptText,
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: mockS3Client,
  HeadBucketCommand: mockHeadBucketCommand,
  DeleteObjectCommand: mockDeleteObjectCommand,
  GetObjectCommand: mockGetObjectCommand,
  ListObjectsV2Command: mockListObjectsV2Command,
}))

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: mockUpload,
}))

import {
  buildS3ObjectKey,
  createS3Client,
  deleteS3Object,
  getS3ConfigForAccount,
  streamS3File,
  syncS3Quota,
  testS3Connection,
  uploadS3Object,
} from './s3.service.js'

function createConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'config-1',
    userId: 'user-1',
    connectedAccountId: 'account-1',
    accessKeyIdEncrypted: 'encrypted-access-key',
    secretAccessKeyEncrypted: 'encrypted-secret-key',
    region: 'us-east-1',
    endpoint: null,
    forcePathStyle: false,
    bucket: 'bucket-1',
    prefix: '/uploads/',
    quotaBytes: 1000n,
    status: 'active',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  } as any
}

function createFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    userId: 'user-1',
    connectedAccountId: 'account-1',
    provider: 's3',
    providerFileId: 'object-key',
    name: 'my "file".txt',
    mimeType: 'text/plain',
    sizeBytes: 50n,
    status: 'active',
    folderId: null,
    deletedAt: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    connectedAccount: {
      id: 'account-1',
    },
    ...overrides,
  } as any
}

function createRes() {
  const res = {} as any
  res.status = vi.fn().mockReturnValue(res)
  res.setHeader = vi.fn()
  res.end = vi.fn()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDecryptText.mockImplementation((value: string) => `decrypted:${value}`)
  mockFindFirstOrThrow.mockResolvedValue(createConfig())
  mockStorageAccountUpsert.mockResolvedValue({ id: 'storage-1' })
})

describe('createS3Client', () => {
  it('creates an S3 client with decrypted credentials and forcePathStyle when endpoint is set', () => {
    createS3Client(createConfig({ endpoint: 'https://s3.example.com', forcePathStyle: false }))

    expect(mockS3Client).toHaveBeenCalledWith({
      region: 'us-east-1',
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'decrypted:encrypted-access-key',
        secretAccessKey: 'decrypted:encrypted-secret-key',
      },
    })
  })

  it('creates an S3 client without an endpoint when none is configured', () => {
    createS3Client(createConfig({ endpoint: null, forcePathStyle: false }))

    expect(mockS3Client).toHaveBeenCalledWith({
      region: 'us-east-1',
      endpoint: undefined,
      forcePathStyle: false,
      credentials: {
        accessKeyId: 'decrypted:encrypted-access-key',
        secretAccessKey: 'decrypted:encrypted-secret-key',
      },
    })
  })
})

describe('getS3ConfigForAccount', () => {
  it('looks up the active config for an account and user', async () => {
    await getS3ConfigForAccount('account-1', 'user-1')

    expect(mockFindFirstOrThrow).toHaveBeenCalledWith({
      where: { connectedAccountId: 'account-1', status: 'active', userId: 'user-1' },
    })
  })

  it('looks up the active config for an account without a user id filter', async () => {
    await getS3ConfigForAccount('account-1')

    expect(mockFindFirstOrThrow).toHaveBeenCalledWith({
      where: { connectedAccountId: 'account-1', status: 'active' },
    })
  })
})

describe('testS3Connection', () => {
  it('sends a head bucket command', async () => {
    mockSend.mockResolvedValue({})

    await testS3Connection(createConfig())

    expect(mockHeadBucketCommand).toHaveBeenCalledWith({ Bucket: 'bucket-1' })
    expect(mockSend).toHaveBeenCalledWith({ type: 'HeadBucket', params: { Bucket: 'bucket-1' } })
  })

  it('propagates S3 connection errors', async () => {
    const error = new Error('connection failed')
    mockSend.mockRejectedValue(error)

    await expect(testS3Connection(createConfig())).rejects.toBe(error)
  })
})

describe('buildS3ObjectKey', () => {
  it('builds an object key with a normalized prefix', () => {
    expect(buildS3ObjectKey({ prefix: '/uploads/' }, 'user-1', 'file-1', 'report.pdf')).toBe(
      'uploads/user-1/file-1/report.pdf',
    )
  })

  it('replaces path separators in the file name', () => {
    expect(buildS3ObjectKey({ prefix: 'uploads' }, 'user-1', 'file-1', 'dir/sub\\file.txt')).toBe(
      'uploads/user-1/file-1/dir-sub-file.txt',
    )
  })

  it('removes control characters from the file name', () => {
    expect(buildS3ObjectKey({ prefix: 'uploads' }, 'user-1', 'file-1', 'bad\u0000name\u0007.txt')).toBe(
      'uploads/user-1/file-1/badname.txt',
    )
  })

  it('truncates very long file names to 180 characters', () => {
    const longName = 'a'.repeat(250)
    const key = buildS3ObjectKey({ prefix: 'uploads' }, 'user-1', 'file-1', longName)

    expect(key).toBe(`uploads/user-1/file-1/${'a'.repeat(180)}`)
  })

  it('falls back to file when sanitization empties the name', () => {
    expect(buildS3ObjectKey({ prefix: 'uploads' }, 'user-1', 'file-1', '\u0000\u0001')).toBe(
      'uploads/user-1/file-1/file',
    )
  })
})

describe('uploadS3Object', () => {
  it('uploads an object and waits for completion', async () => {
    const body = Readable.from(['hello'])
    mockUploadDone.mockResolvedValue(undefined)

    await uploadS3Object(createConfig(), 'uploads/object-key', body, 'text/plain')

    expect(mockUpload).toHaveBeenCalledWith({
      client: { send: mockSend },
      params: {
        Bucket: 'bucket-1',
        Key: 'uploads/object-key',
        Body: body,
        ContentType: 'text/plain',
      },
    })
    expect(mockUploadDone).toHaveBeenCalledTimes(1)
  })
})

describe('deleteS3Object', () => {
  it('deletes the stored object', async () => {
    mockSend.mockResolvedValue({})

    await deleteS3Object(createFile())

    expect(mockDeleteObjectCommand).toHaveBeenCalledWith({ Bucket: 'bucket-1', Key: 'object-key' })
    expect(mockSend).toHaveBeenCalledWith({ type: 'DeleteObject', params: { Bucket: 'bucket-1', Key: 'object-key' } })
  })
})

describe('syncS3Quota', () => {
  it('stores used bytes from a single page and calculates available bytes', async () => {
    mockSend.mockResolvedValue({ Contents: [{ Size: 10 }, { Size: 15 }] })

    await syncS3Quota('account-1')

    expect(mockListObjectsV2Command).toHaveBeenCalledWith({ Bucket: 'bucket-1', ContinuationToken: undefined })
    expect(mockStorageAccountUpsert).toHaveBeenCalledWith({
      where: { connectedAccountId: 'account-1' },
      create: expect.objectContaining({
        totalBytes: 1000n,
        usedBytes: 25n,
        availableBytes: 975n,
        lastSyncedAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        totalBytes: 1000n,
        usedBytes: 25n,
        availableBytes: 975n,
        lastSyncedAt: expect.any(Date),
      }),
    })
  })

  it('accumulates used bytes across multiple pages', async () => {
    mockFindFirstOrThrow.mockResolvedValue(createConfig({ quotaBytes: 50n }))
    mockSend
      .mockResolvedValueOnce({ Contents: [{ Size: 5 }], NextContinuationToken: 'next-page' })
      .mockResolvedValueOnce({ Contents: [{ Size: 7 }, { Size: 8 }] })

    await syncS3Quota('account-1')

    expect(mockListObjectsV2Command).toHaveBeenNthCalledWith(1, { Bucket: 'bucket-1', ContinuationToken: undefined })
    expect(mockListObjectsV2Command).toHaveBeenNthCalledWith(2, { Bucket: 'bucket-1', ContinuationToken: 'next-page' })
    expect(mockStorageAccountUpsert).toHaveBeenCalledWith({
      where: { connectedAccountId: 'account-1' },
      create: expect.objectContaining({ usedBytes: 20n, availableBytes: 30n }),
      update: expect.objectContaining({ usedBytes: 20n, availableBytes: 30n }),
    })
  })

  it('treats empty contents as zero bytes', async () => {
    mockSend.mockResolvedValue({ Contents: undefined })

    await syncS3Quota('account-1')

    expect(mockStorageAccountUpsert).toHaveBeenCalledWith({
      where: { connectedAccountId: 'account-1' },
      create: expect.objectContaining({ usedBytes: 0n }),
      update: expect.objectContaining({ usedBytes: 0n }),
    })
  })

  it('stores null available bytes when quotaBytes is null', async () => {
    mockFindFirstOrThrow.mockResolvedValue(createConfig({ quotaBytes: null }))
    mockSend.mockResolvedValue({ Contents: [{ Size: 3 }] })

    await syncS3Quota('account-1')

    expect(mockStorageAccountUpsert).toHaveBeenCalledWith({
      where: { connectedAccountId: 'account-1' },
      create: expect.objectContaining({ totalBytes: null, usedBytes: 3n, availableBytes: null }),
      update: expect.objectContaining({ totalBytes: null, usedBytes: 3n, availableBytes: null }),
    })
  })
})

describe('streamS3File', () => {
  it('streams a ranged response with headers and attachment disposition', async () => {
    const res = createRes()
    const pipe = vi.fn()
    mockSend.mockResolvedValue({
      ContentRange: 'bytes 0-9/100',
      ContentType: 'application/octet-stream',
      ContentLength: 10,
      Body: { pipe },
    })

    await streamS3File(createFile(), 'bytes=0-9', res, { disposition: 'attachment' })

    expect(mockGetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'bucket-1',
      Key: 'object-key',
      Range: 'bytes=0-9',
    })
    expect(res.status).toHaveBeenCalledWith(206)
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream')
    expect(res.setHeader).toHaveBeenCalledWith('Accept-Ranges', 'bytes')
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '10')
    expect(res.setHeader).toHaveBeenCalledWith('Content-Range', 'bytes 0-9/100')
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="my file.txt"')
    expect(pipe).toHaveBeenCalledWith(res)
  })

  it('uses the file mime type and 200 status when response metadata is absent', async () => {
    const res = createRes()
    const pipe = vi.fn()
    mockSend.mockResolvedValue({
      ContentRange: undefined,
      ContentType: undefined,
      Body: { pipe },
    })

    await streamS3File(createFile({ mimeType: 'text/csv' }), undefined, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv')
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Length', expect.anything())
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Range', expect.anything())
    expect(pipe).toHaveBeenCalledWith(res)
  })

  it('ends the response when the body is missing', async () => {
    const res = createRes()
    mockSend.mockResolvedValue({
      ContentRange: undefined,
      ContentType: undefined,
      ContentLength: undefined,
      Body: undefined,
    })

    await streamS3File(createFile(), undefined, res)

    expect(res.end).toHaveBeenCalledTimes(1)
  })
})
