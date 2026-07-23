import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockProviderConfigFindUniqueOrThrow,
  mockConnectedAccountUpdate,
  mockConnectedAccountFindUniqueOrThrow,
  mockConnectedAccountFindFirstOrThrow,
  mockStorageAccountUpsert,
  mockDriveAboutGet,
  mockDriveFilesList,
  mockDriveFilesCreate,
  mockDriveFactory,
  mockDecryptText,
  mockEncryptText,
  mockOAuth2,
  oauth2Instances,
  mockFolderFindMany,
  mockFileFindMany,
  mockFileCreate,
  mockFileUpdate,
  mockFileUpdateMany,
} = vi.hoisted(() => {
  const mockProviderConfigFindUniqueOrThrow = vi.fn()
  const mockConnectedAccountUpdate = vi.fn()
  const mockConnectedAccountFindUniqueOrThrow = vi.fn()
  const mockConnectedAccountFindFirstOrThrow = vi.fn()
  const mockStorageAccountUpsert = vi.fn()
  const mockDriveAboutGet = vi.fn()
  const mockDriveFilesList = vi.fn()
  const mockDriveFilesCreate = vi.fn()
  const mockDriveFactory = vi.fn().mockImplementation(() => ({
    about: { get: mockDriveAboutGet },
    files: { list: mockDriveFilesList, create: mockDriveFilesCreate },
  }))
  const mockDecryptText = vi.fn()
  const mockEncryptText = vi.fn()
  const oauth2Instances: Array<Record<string, any>> = []
  const mockOAuth2 = vi.fn().mockImplementation(function (...args: unknown[]) {
    const instance = {
      args,
      setCredentials: vi.fn(),
      refreshAccessToken: vi.fn(),
      getRequestHeaders: vi.fn(),
    }
    oauth2Instances.push(instance)
    return instance
  })
  const mockFolderFindMany = vi.fn()
  const mockFileFindMany = vi.fn()
  const mockFileCreate = vi.fn()
  const mockFileUpdate = vi.fn()
  const mockFileUpdateMany = vi.fn().mockResolvedValue({ count: 0 })

  return {
    mockProviderConfigFindUniqueOrThrow,
    mockConnectedAccountUpdate,
    mockConnectedAccountFindUniqueOrThrow,
    mockConnectedAccountFindFirstOrThrow,
    mockStorageAccountUpsert,
    mockDriveAboutGet,
    mockDriveFilesList,
    mockDriveFilesCreate,
    mockDriveFactory,
    mockDecryptText,
    mockEncryptText,
    mockOAuth2,
    oauth2Instances,
    mockFolderFindMany,
    mockFileFindMany,
    mockFileCreate,
    mockFileUpdate,
    mockFileUpdateMany,
  }
})

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    providerConfig: { findUniqueOrThrow: mockProviderConfigFindUniqueOrThrow },
    connectedAccount: {
      update: mockConnectedAccountUpdate,
      findUniqueOrThrow: mockConnectedAccountFindUniqueOrThrow,
      findFirstOrThrow: mockConnectedAccountFindFirstOrThrow,
    },
    storageAccount: { upsert: mockStorageAccountUpsert },
    folder: { findMany: mockFolderFindMany },
    file: {
      findMany: mockFileFindMany,
      create: mockFileCreate,
      update: mockFileUpdate,
      updateMany: mockFileUpdateMany,
    },
  },
}))

vi.mock('../../utils/crypto.js', () => ({
  decryptText: mockDecryptText,
  encryptText: mockEncryptText,
}))

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: mockOAuth2 },
    drive: mockDriveFactory,
  },
}))

import {
  createOAuthClient,
  ensureGoogleAppFolder,
  getAuthedGoogleClient,
  syncGoogleAppFolderFiles,
  syncGoogleQuota,
} from './google.service.js'

function createProviderConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-config-1',
    provider: 'google',
    clientIdEncrypted: 'encrypted-client-id',
    clientSecretEncrypted: 'encrypted-client-secret',
    redirectUri: 'https://example.com/callback',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  } as any
}

function createAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    userId: 'user-1',
    provider: 'google_drive',
    providerAccountId: 'provider-account-1',
    email: 'user@example.com',
    accessTokenEncrypted: 'encrypted-access-token',
    refreshTokenEncrypted: 'encrypted-refresh-token',
    tokenExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    providerConfigId: 'provider-config-1',
    status: 'connected',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  oauth2Instances.length = 0
  mockDecryptText.mockImplementation((value: string) => `decrypted:${value}`)
  mockEncryptText.mockImplementation((value: string) => `encrypted:${value}`)
  mockProviderConfigFindUniqueOrThrow.mockResolvedValue(createProviderConfig())
  mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(createAccount())
  mockConnectedAccountUpdate.mockResolvedValue(undefined)
  mockStorageAccountUpsert.mockResolvedValue({ id: 'storage-1' })
  mockDriveAboutGet.mockResolvedValue({ data: { storageQuota: {} } })
  mockDriveFilesList.mockResolvedValue({ data: { files: [{ id: 'folder-1', name: '9drive' }] } })
  mockDriveFilesCreate.mockResolvedValue({ data: { id: 'folder-created' } })
  vi.spyOn(Date, 'now').mockReturnValue(new Date('2024-01-01T00:00:00.000Z').getTime())
})

describe('createOAuthClient', () => {
  it('creates an OAuth client with decrypted credentials', () => {
    const config = createProviderConfig()

    const client = createOAuthClient(config)

    expect(mockDecryptText).toHaveBeenCalledWith('encrypted-client-id')
    expect(mockDecryptText).toHaveBeenCalledWith('encrypted-client-secret')
    expect(mockOAuth2).toHaveBeenCalledWith(
      'decrypted:encrypted-client-id',
      'decrypted:encrypted-client-secret',
      'https://example.com/callback',
    )
    expect(client).toBe(oauth2Instances[0])
  })
})

describe('getAuthedGoogleClient', () => {
  it('throws when account tokens are missing', async () => {
    await expect(getAuthedGoogleClient(createAccount({ accessTokenEncrypted: null }))).rejects.toThrow(
      'Google account tokens are missing.',
    )
  })

  it('throws when the provider config id is missing', async () => {
    await expect(getAuthedGoogleClient(createAccount({ providerConfigId: null }))).rejects.toThrow(
      'Google provider config is missing.',
    )
  })

  it('returns the OAuth client without refreshing when the token is not expiring soon', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T01:05:00.000Z') })

    const client = await getAuthedGoogleClient(account)

    expect(mockProviderConfigFindUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'provider-config-1' } })
    expect(oauth2Instances[0].setCredentials).toHaveBeenCalledWith({
      access_token: 'decrypted:encrypted-access-token',
      refresh_token: 'decrypted:encrypted-refresh-token',
      expiry_date: account.tokenExpiresAt.getTime(),
    })
    expect(oauth2Instances[0].refreshAccessToken).not.toHaveBeenCalled()
    expect(mockConnectedAccountUpdate).not.toHaveBeenCalled()
    expect(client).toBe(oauth2Instances[0])
  })

  it('refreshes expiring tokens and persists the new access token', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T00:00:30.000Z') })

    const refreshCredentials = {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expiry_date: new Date('2024-01-01T02:00:00.000Z').getTime(),
    }
    const client = {
      setCredentials: vi.fn(),
      refreshAccessToken: vi.fn().mockResolvedValue({ credentials: refreshCredentials }),
      getRequestHeaders: vi.fn(),
    }

    mockProviderConfigFindUniqueOrThrow.mockResolvedValue(createProviderConfig())
    mockOAuth2.mockImplementationOnce(() => client)

    const result = await getAuthedGoogleClient(account)

    expect(client.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(mockEncryptText).toHaveBeenCalledWith('new-access-token')
    expect(mockConnectedAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: {
        accessTokenEncrypted: 'encrypted:new-access-token',
        tokenExpiresAt: new Date(refreshCredentials.expiry_date),
      },
    })
    expect(client.setCredentials).toHaveBeenNthCalledWith(1, {
      access_token: 'decrypted:encrypted-access-token',
      refresh_token: 'decrypted:encrypted-refresh-token',
      expiry_date: account.tokenExpiresAt.getTime(),
    })
    expect(client.setCredentials).toHaveBeenNthCalledWith(2, refreshCredentials)
    expect(result).toBe(client)
  })

  it('uses a fallback expiry time when refreshed credentials omit expiry_date', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T00:00:30.000Z') })
    const client = {
      setCredentials: vi.fn(),
      refreshAccessToken: vi.fn().mockResolvedValue({
        credentials: { access_token: 'new-access-token' },
      }),
      getRequestHeaders: vi.fn(),
    }
    mockOAuth2.mockImplementationOnce(() => client)

    const result = await getAuthedGoogleClient(account)

    expect(mockConnectedAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'account-1' },
      data: {
        accessTokenEncrypted: 'encrypted:new-access-token',
        tokenExpiresAt: new Date(new Date('2024-01-01T00:00:00.000Z').getTime() + 3600_000),
      },
    })
    expect(client.setCredentials).toHaveBeenNthCalledWith(2, { access_token: 'new-access-token' })
    expect(result).toBe(client)
  })

  it('refreshes expiring tokens without updating the database when no access token is returned', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T00:00:30.000Z') })
    const client = {
      setCredentials: vi.fn(),
      refreshAccessToken: vi.fn().mockResolvedValue({
      credentials: { expiry_date: new Date('2024-01-01T02:00:00.000Z').getTime() },
      }),
      getRequestHeaders: vi.fn(),
    }
    mockOAuth2.mockImplementationOnce(() => client)

    const result = await getAuthedGoogleClient(account)

    expect(client.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(mockConnectedAccountUpdate).not.toHaveBeenCalled()
    expect(client.setCredentials).toHaveBeenCalledTimes(1)
    expect(result).toBe(client)
  })
})

describe('syncGoogleQuota', () => {
  it('stores total, used, available, and trash bytes when Google returns quota details', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T01:00:00.000Z') })
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)
    mockDriveAboutGet.mockResolvedValue({
      data: {
        storageQuota: {
          limit: '100',
          usage: '40',
          usageInDriveTrash: '5',
        },
      },
    })

    await syncGoogleQuota('account-1')

    expect(mockDriveFactory).toHaveBeenCalledWith({ version: 'v3', auth: oauth2Instances[0] })
    expect(mockStorageAccountUpsert).toHaveBeenCalledWith({
      where: { connectedAccountId: 'account-1' },
      create: expect.objectContaining({
        connectedAccountId: 'account-1',
        totalBytes: 100n,
        usedBytes: 40n,
        availableBytes: 60n,
        trashBytes: 5n,
        lastSyncedAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        totalBytes: 100n,
        usedBytes: 40n,
        availableBytes: 60n,
        trashBytes: 5n,
        lastSyncedAt: expect.any(Date),
      }),
    })
  })

  it('stores null total and trash bytes when Google omits them', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T01:00:00.000Z') })
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)
    mockDriveAboutGet.mockResolvedValue({ data: { storageQuota: {} } })

    await syncGoogleQuota('account-1')

    expect(mockStorageAccountUpsert).toHaveBeenCalledWith({
      where: { connectedAccountId: 'account-1' },
      create: expect.objectContaining({
        totalBytes: null,
        usedBytes: 0n,
        availableBytes: null,
        trashBytes: null,
      }),
      update: expect.objectContaining({
        totalBytes: null,
        usedBytes: 0n,
        availableBytes: null,
        trashBytes: null,
      }),
    })
  })
})

describe('ensureGoogleAppFolder', () => {
  it('returns the existing folder id when the folder already exists', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T01:00:00.000Z') })
    mockDriveFilesList.mockResolvedValue({ data: { files: [{ id: 'existing-folder', name: '9drive' }] } })

    const folderId = await ensureGoogleAppFolder(account)

    expect(folderId).toBe('existing-folder')
    expect(mockDriveFilesCreate).not.toHaveBeenCalled()
    expect(mockDriveFilesList).toHaveBeenCalledWith({
      q: "name = '9drive' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
      spaces: 'drive',
      fields: 'files(id,name)',
      pageSize: 1,
    })
  })

  it('creates the folder when it does not already exist', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T01:00:00.000Z') })
    mockDriveFilesList.mockResolvedValue({ data: { files: [] } })
    mockDriveFilesCreate.mockResolvedValue({ data: { id: 'new-folder' } })

    const folderId = await ensureGoogleAppFolder(account)

    expect(folderId).toBe('new-folder')
    expect(mockDriveFilesCreate).toHaveBeenCalledWith({
      requestBody: {
        name: '9drive',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      },
      fields: 'id',
    })
  })

  it('throws when neither lookup nor create returns a folder id', async () => {
    const account = createAccount({ tokenExpiresAt: new Date('2024-01-01T01:00:00.000Z') })
    mockDriveFilesList.mockResolvedValue({ data: { files: [] } })
    mockDriveFilesCreate.mockResolvedValue({ data: { id: null } })

    await expect(ensureGoogleAppFolder(account)).rejects.toThrow('Failed to create Google Drive app folder.')
  })
})

describe('syncGoogleAppFolderFiles', () => {
  function createAccount(overrides: Record<string, unknown> = {}) {
    return {
      id: 'account-1',
      userId: 'user-1',
      provider: 'google_drive',
      status: 'connected',
      providerConfigId: 'provider-config-1',
      accessTokenEncrypted: 'encrypted-access',
      refreshTokenEncrypted: 'encrypted-refresh',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      providerAccountId: 'google-id-1',
      email: 'test@example.com',
      ...overrides,
    } as any
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDecryptText.mockResolvedValue('decrypted-token')
    mockEncryptText.mockResolvedValue('encrypted-token')
    mockConnectedAccountUpdate.mockResolvedValue({})
    mockStorageAccountUpsert.mockResolvedValue({})
    mockDriveAboutGet.mockResolvedValue({ data: { storageQuota: { limit: '100', usage: '40', usageInDrive: '40', usageInDriveTrash: '5' } } })
    mockFileUpdateMany.mockResolvedValue({ count: 0 })
    mockProviderConfigFindUniqueOrThrow.mockResolvedValue({
      id: 'provider-config-1',
      provider: 'google',
      clientIdEncrypted: 'enc-client-id',
      clientSecretEncrypted: 'enc-client-secret',
      redirectUri: 'https://example.com/callback',
    })
  })

  it('creates new files found in Drive that are not in the database', async () => {
    const account = createAccount()
    mockConnectedAccountFindFirstOrThrow.mockResolvedValue(account)
    mockDriveFilesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'drive-folder-1', name: '9drive' }] } }) // ensureGoogleAppFolder lookup
      .mockResolvedValueOnce({ data: { files: [{ id: 'file-1', name: 'test.txt', mimeType: 'text/plain', size: '1024', parents: ['app-folder-1'] }], nextPageToken: undefined } }) // files.list
      .mockResolvedValue({ data: { files: [] } }) // syncGoogleQuota quota usage
    mockFolderFindMany.mockResolvedValue([])
    mockFileFindMany.mockResolvedValue([])
    mockFileCreate.mockResolvedValue({})
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)

    const result = await syncGoogleAppFolderFiles('account-1', 'user-1')

    expect(result.created).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.deleted).toBe(0)
    expect(mockFileCreate).toHaveBeenCalledTimes(1)
  })

  it('updates existing files whose metadata changed in Drive', async () => {
    const account = createAccount()
    mockConnectedAccountFindFirstOrThrow.mockResolvedValue(account)
    mockDriveFilesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'drive-folder-1', name: '9drive' }] } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'file-1', name: 'renamed.txt', mimeType: 'text/plain', size: '2048', parents: ['drive-folder-1'] }], nextPageToken: undefined } })
      .mockResolvedValue({ data: { files: [] } })
    mockFolderFindMany.mockResolvedValue([])
    mockFileFindMany.mockResolvedValue([
      { id: 'db-file-1', providerFileId: 'file-1', name: 'old.txt', mimeType: 'text/plain', sizeBytes: 1024n, status: 'active', deletedAt: null, folderId: null },
    ])
    mockFileUpdate.mockResolvedValue({})
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)

    const result = await syncGoogleAppFolderFiles('account-1', 'user-1')

    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
    expect(result.deleted).toBe(0)
    expect(mockFileUpdate).toHaveBeenCalledTimes(1)
  })

  it('marks active files deleted when they are missing from Drive', async () => {
    const account = createAccount()
    mockConnectedAccountFindFirstOrThrow.mockResolvedValue(account)
    mockDriveFilesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'drive-folder-1', name: '9drive' }] } })
      .mockResolvedValueOnce({ data: { files: [], nextPageToken: undefined } })
      .mockResolvedValue({ data: { files: [] } })
    mockFolderFindMany.mockResolvedValue([])
    mockFileFindMany.mockResolvedValue([
      { id: 'db-file-1', providerFileId: 'gone-file', name: 'gone.txt', mimeType: 'text/plain', sizeBytes: 512n, status: 'active', deletedAt: null, folderId: null },
    ])
    mockFileUpdateMany.mockResolvedValue({ count: 1 })
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)

    const result = await syncGoogleAppFolderFiles('account-1', 'user-1')

    expect(result.deleted).toBe(1)
    expect(mockFileUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'deleted', deletedAt: expect.any(Date) } }))
  })

  it('does not update files whose metadata is unchanged', async () => {
    const account = createAccount()
    mockConnectedAccountFindFirstOrThrow.mockResolvedValue(account)
    mockDriveFilesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'drive-folder-1', name: '9drive' }] } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'file-1', name: 'same.txt', mimeType: 'text/plain', size: '1024', parents: ['drive-folder-1'] }], nextPageToken: undefined } })
      .mockResolvedValue({ data: { files: [] } })
    mockFolderFindMany.mockResolvedValue([])
    mockFileFindMany.mockResolvedValue([
      { id: 'db-file-1', providerFileId: 'file-1', name: 'same.txt', mimeType: 'text/plain', sizeBytes: 1024n, status: 'active', deletedAt: null, folderId: null },
    ])
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)

    const result = await syncGoogleAppFolderFiles('account-1', 'user-1')

    expect(result.created).toBe(0)
    expect(result.updated).toBe(0)
    expect(mockFileUpdate).not.toHaveBeenCalled()
  })

  it('handles paginated Drive file listing', async () => {
    const account = createAccount()
    mockConnectedAccountFindFirstOrThrow.mockResolvedValue(account)
    mockDriveFilesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'drive-folder-1', name: '9drive' }] } }) // ensureGoogleAppFolder
      .mockResolvedValueOnce({ data: { files: [{ id: 'file-1', name: 'page1.txt', mimeType: 'text/plain', size: '100', parents: ['drive-folder-1'] }], nextPageToken: 'token-page2' } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'file-2', name: 'page2.txt', mimeType: 'text/plain', size: '200', parents: ['drive-folder-1'] }], nextPageToken: undefined } })
      .mockResolvedValue({ data: { files: [] } })
    mockFolderFindMany.mockResolvedValue([])
    mockFileFindMany.mockResolvedValue([])
    mockFileCreate.mockResolvedValue({})
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)

    const result = await syncGoogleAppFolderFiles('account-1', 'user-1')

    expect(result.created).toBe(2)
  })

  it('skips incomplete Drive metadata and falls back to the app folder parent', async () => {
    const account = createAccount()
    mockConnectedAccountFindFirstOrThrow.mockResolvedValue(account)
    mockDriveFilesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'drive-folder-1', name: '9drive' }] } })
      .mockResolvedValueOnce({
        data: {
          files: [
            { id: null, name: 'missing-id.txt', mimeType: 'text/plain', size: '1', parents: ['drive-folder-1'] },
            { id: 'file-2', name: 'orphan.txt', mimeType: 'text/plain', size: '25' },
            { id: 'file-3', name: null, mimeType: 'text/plain', size: '9', parents: ['drive-folder-1'] },
          ],
          nextPageToken: undefined,
        },
      })
      .mockResolvedValue({ data: { files: [] } })
    mockFolderFindMany.mockResolvedValue([])
    mockFileFindMany.mockResolvedValue([])
    mockFileCreate.mockResolvedValue({})
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)

    const result = await syncGoogleAppFolderFiles('account-1', 'user-1')

    expect(result).toEqual({ accountId: 'account-1', created: 1, updated: 0, deleted: 0 })
    expect(mockFileCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        connectedAccountId: 'account-1',
        provider: 'google_drive',
        providerFileId: 'file-2',
        name: 'orphan.txt',
        mimeType: 'text/plain',
        sizeBytes: 25n,
        status: 'active',
        folderId: null,
      },
    })
  })

  it('handles undefined Drive file lists and defaults missing sizes to zero', async () => {
    const account = createAccount()
    mockConnectedAccountFindFirstOrThrow.mockResolvedValue(account)
    mockDriveFilesList
      .mockResolvedValueOnce({ data: { files: [{ id: 'drive-folder-1', name: '9drive' }] } })
      .mockResolvedValueOnce({ data: { files: undefined, nextPageToken: 'page-2' } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'file-4', name: 'zero.txt', mimeType: 'text/plain', parents: ['drive-folder-1'] }], nextPageToken: undefined } })
      .mockResolvedValue({ data: { files: [] } })
    mockFolderFindMany.mockResolvedValue([])
    mockFileFindMany.mockResolvedValue([])
    mockFileCreate.mockResolvedValue({})
    mockConnectedAccountFindUniqueOrThrow.mockResolvedValue(account)

    const result = await syncGoogleAppFolderFiles('account-1', 'user-1')

    expect(result).toEqual({ accountId: 'account-1', created: 1, updated: 0, deleted: 0 })
    expect(mockFileCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        providerFileId: 'file-4',
        sizeBytes: 0n,
      }),
    }))
  })
})
