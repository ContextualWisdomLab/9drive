import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./stream-google-file.js', () => ({
  streamGoogleFile: vi.fn(),
}))

vi.mock('../s3/s3.service.js', () => ({
  streamS3File: vi.fn(),
}))

import { streamGoogleFile } from './stream-google-file.js'
import { streamS3File } from '../s3/s3.service.js'
import { streamProviderFile } from './stream-file.js'

const mockStreamGoogleFile = vi.mocked(streamGoogleFile)
const mockStreamS3File = vi.mocked(streamS3File)

function makeFile(provider: string) {
  return {
    id: 'file-1',
    provider,
    connectedAccount: { id: 'account-1' },
  } as any
}

describe('streamProviderFile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls streamS3File for s3 files', () => {
    const file = makeFile('s3')
    const res = {} as any

    streamProviderFile(file, 'bytes=0-1', res, { disposition: 'attachment' })

    expect(mockStreamS3File).toHaveBeenCalledWith(file, 'bytes=0-1', res, { disposition: 'attachment' })
    expect(mockStreamGoogleFile).not.toHaveBeenCalled()
  })

  it('calls streamGoogleFile for google drive files', () => {
    const file = makeFile('google_drive')
    const res = {} as any

    streamProviderFile(file, undefined, res, { disposition: 'inline' })

    expect(mockStreamGoogleFile).toHaveBeenCalledWith(file, undefined, res, { disposition: 'inline' })
    expect(mockStreamS3File).not.toHaveBeenCalled()
  })

  it('falls back to streamGoogleFile for unknown providers', () => {
    const file = makeFile('dropbox')
    const res = {} as any

    streamProviderFile(file, undefined, res)

    expect(mockStreamGoogleFile).toHaveBeenCalledWith(file, undefined, res, {})
    expect(mockStreamS3File).not.toHaveBeenCalled()
  })
})
