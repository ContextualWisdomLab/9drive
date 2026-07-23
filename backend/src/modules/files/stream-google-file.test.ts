import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetAuthedGoogleClient } = vi.hoisted(() => ({
  mockGetAuthedGoogleClient: vi.fn(),
}))

vi.mock('../google/google.service.js', () => ({
  getAuthedGoogleClient: mockGetAuthedGoogleClient,
}))

import {
  normalizeHeaders,
  streamGoogleFile,
  withExtension,
} from './stream-google-file.js'

type MockResponse = {
  status: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

function createRes(): MockResponse {
  const res = {} as MockResponse
  res.status = vi.fn().mockReturnValue(res)
  res.setHeader = vi.fn()
  res.json = vi.fn().mockReturnValue(res)
  res.write = vi.fn()
  res.end = vi.fn()
  return res
}

function createFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-id',
    userId: 'user-1',
    connectedAccountId: 'account-1',
    provider: 'google_drive',
    providerFileId: 'provider-file-1',
    name: 'report',
    mimeType: 'text/plain',
    sizeBytes: 10n,
    status: 'active',
    folderId: null,
    deletedAt: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    connectedAccount: {
      id: 'account-1',
      userId: 'user-1',
      provider: 'google_drive',
      providerAccountId: 'provider-account-1',
      email: 'user@example.com',
      accessTokenEncrypted: 'access',
      refreshTokenEncrypted: 'refresh',
      tokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      providerConfigId: 'provider-config-1',
      status: 'connected',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    },
    ...overrides,
  } as any
}

function createBody(chunks: Array<Uint8Array>) {
  const read = vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
  for (const chunk of chunks) {
    read.mockResolvedValueOnce({ done: false, value: chunk })
  }
  read.mockResolvedValueOnce({ done: true, value: undefined })

  return {
    getReader: vi.fn().mockReturnValue({ read }),
    read,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAuthedGoogleClient.mockResolvedValue({
    getRequestHeaders: vi.fn().mockResolvedValue({ Authorization: '******' }),
  })
  vi.stubGlobal('fetch', vi.fn())
})

describe('withExtension', () => {
  it('returns the original name when the extension already exists', () => {
    expect(withExtension('report.pdf', '.pdf')).toBe('report.pdf')
  })

  it('appends the extension when it is missing', () => {
    expect(withExtension('report', '.pdf')).toBe('report.pdf')
  })
})

describe('normalizeHeaders', () => {
  it('converts a Headers instance into a plain object', () => {
    const headers = new Headers({ Authorization: '******', Accept: 'application/json' })

    expect(normalizeHeaders(headers)).toEqual({
      accept: 'application/json',
      authorization: '******',
    })
  })

  it('returns a plain object as-is', () => {
    const headers = { Authorization: '******' }

    expect(normalizeHeaders(headers)).toBe(headers)
  })
})

describe('streamGoogleFile', () => {
  it('streams a regular file without range or disposition', async () => {
    const res = createRes()
    const body = createBody([new Uint8Array([1, 2, 3]), new Uint8Array([4])])
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
      body: { getReader: body.getReader },
    })

    await streamGoogleFile(createFile(), undefined, res as any)

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/provider-file-1?alt=media',
      { headers: { Authorization: '******' } },
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain')
    expect(res.setHeader).toHaveBeenCalledWith('Accept-Ranges', 'bytes')
    expect(res.write).toHaveBeenNthCalledWith(1, Buffer.from([1, 2, 3]))
    expect(res.write).toHaveBeenNthCalledWith(2, Buffer.from([4]))
    expect(res.end).toHaveBeenCalledTimes(1)
  })

  it('includes the Range header for regular files', async () => {
    const res = createRes()
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 206,
      headers: {
        get: vi.fn((name: string) => ({ 'content-length': '10', 'content-range': 'bytes 0-9/100' }[name] ?? null)),
      },
      body: null,
    })

    await streamGoogleFile(createFile(), 'bytes=0-9', res as any)

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/provider-file-1?alt=media',
      { headers: { Authorization: '******', Range: 'bytes=0-9' } },
    )
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '10')
    expect(res.setHeader).toHaveBeenCalledWith('Content-Range', 'bytes 0-9/100')
    expect(res.end).toHaveBeenCalledTimes(1)
  })

  it('uses the export URL and attachment disposition for Google Docs downloads', async () => {
    const res = createRes()
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
      body: null,
    })

    await streamGoogleFile(
      createFile({
        name: 'my "report"',
        mimeType: 'application/vnd.google-apps.document',
      }),
      'bytes=0-10',
      res as any,
      { disposition: 'attachment' },
    )

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/provider-file-1/export?mimeType=application%2Fpdf',
      { headers: { Authorization: '******' } },
    )
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf')
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="my report.pdf"')
  })

  it('uses preview export mime types for inline Google Docs previews', async () => {
    const res = createRes()
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
      body: null,
    })

    await streamGoogleFile(
      createFile({ mimeType: 'application/vnd.google-apps.presentation' }),
      undefined,
      res as any,
      { disposition: 'inline' },
    )

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/provider-file-1/export?mimeType=application%2Fpdf',
      { headers: { Authorization: '******' } },
    )
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'inline; filename="report.pdf"')
  })

  it('uses different spreadsheet export formats for download and inline preview', async () => {
    const downloadRes = createRes()
    const inlineRes = createRes()
    ;(globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: vi.fn().mockReturnValue(null) },
        body: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: vi.fn().mockReturnValue(null) },
        body: null,
      })

    const file = createFile({ mimeType: 'application/vnd.google-apps.spreadsheet' })

    await streamGoogleFile(file, undefined, downloadRes as any, { disposition: 'attachment' })
    await streamGoogleFile(file, undefined, inlineRes as any, { disposition: 'inline' })

    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(
      'https://www.googleapis.com/drive/v3/files/provider-file-1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(downloadRes.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(downloadRes.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="report.xlsx"')

    expect((globalThis.fetch as any).mock.calls[1][0]).toBe(
      'https://www.googleapis.com/drive/v3/files/provider-file-1/export?mimeType=application%2Fpdf',
    )
    expect(inlineRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf')
    expect(inlineRes.setHeader).toHaveBeenCalledWith('Content-Disposition', 'inline; filename="report.pdf"')
  })

  it('falls back to the response status text when Google returns an empty error body', async () => {
    const res = createRes()
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: vi.fn().mockResolvedValue(''),
      headers: { get: vi.fn().mockReturnValue(null) },
      body: null,
    })

    await streamGoogleFile(createFile(), undefined, res as any)

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith({
      code: 'GOOGLE_FILE_STREAM_FAILED',
      message: 'Bad Gateway',
    })
  })

  it('returns error JSON when Google returns a failed response', async () => {
    const res = createRes()
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: vi.fn().mockResolvedValue('google failed'),
    })

    await streamGoogleFile(createFile(), undefined, res as any)

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith({
      code: 'GOOGLE_FILE_STREAM_FAILED',
      message: 'google failed',
    })
  })

  it('falls back to statusText when reading the error body fails', async () => {
    const res = createRes()
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: vi.fn().mockRejectedValue(new Error('boom')),
    })

    await streamGoogleFile(createFile(), undefined, res as any)

    expect(res.json).toHaveBeenCalledWith({
      code: 'GOOGLE_FILE_STREAM_FAILED',
      message: 'Internal Server Error',
    })
  })

  it('does not set content length or content range headers when they are absent', async () => {
    const res = createRes()
    ;(globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
      body: null,
    })

    await streamGoogleFile(createFile(), undefined, res as any)

    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Length', expect.anything())
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Range', expect.anything())
  })
})
