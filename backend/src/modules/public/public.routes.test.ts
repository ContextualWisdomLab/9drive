import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    fileShare: {
      findFirst: vi.fn(),
    },
  },
}))

vi.mock('../../utils/crypto.js', () => ({
  hashToken: vi.fn((value: string) => `hashed:${value}`),
}))

vi.mock('../files/stream-file.js', () => ({
  streamProviderFile: vi.fn((file: any, range: string | undefined, res: any, options: any) => {
    res.status(206).json({ id: file.id, range: range ?? null, disposition: options.disposition })
  }),
}))

import { prisma } from '../../config/prisma.js'
import { hashToken } from '../../utils/crypto.js'
import { streamProviderFile } from '../files/stream-file.js'
import { publicRouter } from './public.routes.js'

const mockPrisma = prisma as unknown as {
  fileShare: { findFirst: ReturnType<typeof vi.fn> }
}

const mockHashToken = vi.mocked(hashToken)
const mockStreamProviderFile = vi.mocked(streamProviderFile)

function makeSharedFile(overrides: Partial<any> = {}) {
  return {
    id: 'file-1',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 123n,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'active',
    provider: 'google_drive',
    connectedAccount: { id: 'account-1' },
    ...overrides,
  }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', publicRouter)
  app.use((err: any, req: any, res: any, next: any) => res.status(500).json({ error: err.message }))
  return app
}

describe('publicRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET /files/:token returns public file metadata', async () => {
    mockPrisma.fileShare.findFirst.mockResolvedValue({ file: makeSharedFile() })

    const res = await request(makeApp()).get('/files/share-token')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      file: {
        id: 'file-1',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: '123',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    })
    expect(mockHashToken).toHaveBeenCalledWith('share-token')
    expect(mockPrisma.fileShare.findFirst).toHaveBeenCalledWith({
      where: {
        enabled: true,
        AND: [
          { OR: [{ token: 'share-token' }, { tokenHash: 'hashed:share-token' }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] },
        ],
      },
      include: { file: { include: { connectedAccount: true } } },
    })
  })

  it('GET /files/:token returns an error when the share is not found', async () => {
    mockPrisma.fileShare.findFirst.mockResolvedValue(null)

    const res = await request(makeApp()).get('/files/missing-token')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Shared file not found' })
  })

  it('GET /files/:token returns an error when the file is not active', async () => {
    mockPrisma.fileShare.findFirst.mockResolvedValue({ file: makeSharedFile({ status: 'deleted' }) })

    const res = await request(makeApp()).get('/files/inactive-token')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Shared file not found' })
  })

  it('GET /files/:token passes database errors to next', async () => {
    mockPrisma.fileShare.findFirst.mockRejectedValue(new Error('db error'))

    const res = await request(makeApp()).get('/files/error-token')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'db error' })
  })

  it('GET /files/:token/download streams the file as an attachment', async () => {
    mockPrisma.fileShare.findFirst.mockResolvedValue({ file: makeSharedFile() })

    const res = await request(makeApp())
      .get('/files/share-token/download')
      .set('Range', 'bytes=0-99')

    expect(res.status).toBe(206)
    expect(res.body).toEqual({ id: 'file-1', range: 'bytes=0-99', disposition: 'attachment' })
    expect(mockStreamProviderFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), 'bytes=0-99', expect.anything(), { disposition: 'attachment' })
  })

  it('GET /files/:token/download returns not found errors', async () => {
    mockPrisma.fileShare.findFirst.mockResolvedValue(null)

    const res = await request(makeApp()).get('/files/missing-token/download')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Shared file not found' })
    expect(mockStreamProviderFile).not.toHaveBeenCalled()
  })

  it('GET /files/:token/download passes streaming errors to next', async () => {
    mockPrisma.fileShare.findFirst.mockResolvedValue({ file: makeSharedFile() })
    mockStreamProviderFile.mockImplementationOnce(() => {
      throw new Error('stream failed')
    })

    const res = await request(makeApp()).get('/files/share-token/download')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'stream failed' })
  })

  it('GET /files/:token/preview streams the file inline', async () => {
    mockPrisma.fileShare.findFirst.mockResolvedValue({ file: makeSharedFile() })

    const res = await request(makeApp())
      .get('/files/share-token/preview')
      .set('Range', 'bytes=100-199')

    expect(res.status).toBe(206)
    expect(res.body).toEqual({ id: 'file-1', range: 'bytes=100-199', disposition: 'inline' })
    expect(mockStreamProviderFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }), 'bytes=100-199', expect.anything(), { disposition: 'inline' })
  })

  it('GET /files/:token/preview returns not found errors', async () => {
    mockPrisma.fileShare.findFirst.mockResolvedValue(null)

    const res = await request(makeApp()).get('/files/missing-token/preview')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Shared file not found' })
  })

  it('GET /files/:token/preview passes database errors to next', async () => {
    mockPrisma.fileShare.findFirst.mockRejectedValue(new Error('preview db error'))

    const res = await request(makeApp()).get('/files/share-token/preview')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'preview db error' })
  })
})
