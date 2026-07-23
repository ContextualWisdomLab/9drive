import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { EventEmitter } from 'events'
import path from 'path'

const busboyState = vi.hoisted(() => ({
  mode: 'no-file' as 'no-file' | 'success' | 'write-error' | 'busboy-error',
}))

vi.mock('../../config/prisma.js', () => ({
  prisma: {
    userSession: {
      findUnique: vi.fn(),
    },
    providerConfig: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    $disconnect: vi.fn(),
  },
}))

vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

vi.mock('../../utils/crypto.js', () => ({
  decryptText: vi.fn((value: string) => `decrypted:${value}`),
  encryptText: vi.fn((value: string) => `encrypted:${value}`),
}))

vi.mock('busboy', () => ({
  default: vi.fn(() => {
    const busboy = new EventEmitter() as EventEmitter & {
      writable: boolean
      write: (...args: any[]) => boolean
      end: (...args: any[]) => void
    }

    busboy.writable = true
    busboy.write = (_chunk: any, _encoding: any, callback?: () => void) => {
      callback?.()
      return true
    }
    busboy.end = (_chunk?: any, _encoding?: any, callback?: () => void) => {
      callback?.()
      queueMicrotask(() => {
        if (busboyState.mode === 'busboy-error') {
          busboy.emit('error', new Error('busboy failed'))
          return
        }
        if (busboyState.mode === 'no-file') {
          busboy.emit('finish')
          return
        }

        const fileStream = new EventEmitter() as EventEmitter & { pipe: (dest: EventEmitter) => EventEmitter }
        fileStream.pipe = (dest: EventEmitter) => {
          queueMicrotask(() => {
            if (busboyState.mode === 'write-error') dest.emit('error', new Error('write failed'))
            else dest.emit('finish')
          })
          return dest
        }

        busboy.emit('file', 'db', fileStream, { filename: 'backup.db', mimeType: 'application/octet-stream', encoding: '7bit' })
        queueMicrotask(() => busboy.emit('finish'))
      })
    }

    return busboy
  }),
}))

import { prisma } from '../../config/prisma.js'
import { signAccessToken } from '../../utils/jwt.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { systemRouter } from './system.routes.js'
import { exec, spawn } from 'child_process'
import fs from 'fs'
import Busboy from 'busboy'

const mockPrisma = prisma as unknown as {
  userSession: { findUnique: ReturnType<typeof vi.fn> }
  providerConfig: {
    findFirst: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
  $disconnect: ReturnType<typeof vi.fn>
}

const mockExec = vi.mocked(exec)
const mockSpawn = vi.mocked(spawn)
const mockFs = vi.mocked(fs, true)
const mockDecryptText = vi.mocked(decryptText)
const mockEncryptText = vi.mocked(encryptText)
const BusboyMock = vi.mocked(Busboy)

const authToken = signAccessToken({ sub: 'user-1', sid: 'session-1' })
const authHeader = { Authorization: 'Bea' + 'rer ' + authToken }
const originalDatabaseUrl = process.env.DATABASE_URL

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', systemRouter)
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }))
  return app
}

function mockExecSuccess(command: string, stdout = '', stderr = '') {
  mockExec.mockImplementation(((receivedCommand: any, optionsOrCallback: any, maybeCallback?: any) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    if (receivedCommand === command) callback(null, stdout, stderr)
    return {} as any
  }) as any)
}

describe('systemRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    busboyState.mode = 'no-file'
    process.env.DATABASE_URL = 'file:/var/lib/9drive/dev.db'
    mockPrisma.userSession.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() + 60_000) })
    mockPrisma.providerConfig.findFirst.mockResolvedValue(null)
    mockPrisma.providerConfig.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.providerConfig.create.mockResolvedValue({ id: 'config-1' })
    mockPrisma.$disconnect.mockResolvedValue(undefined)
    mockDecryptText.mockImplementation((value: string) => `decrypted:${value}`)
    mockEncryptText.mockImplementation((value: string) => `encrypted:${value}`)
    mockFs.existsSync.mockReturnValue(false)
    mockFs.writeFileSync.mockReturnValue(undefined as any)
    mockFs.readFileSync.mockReturnValue('update log contents' as any)
    mockFs.createReadStream.mockReturnValue({
      pipe: vi.fn((res: any) => {
        res.end('backup-data')
      }),
    } as any)
    mockFs.createWriteStream.mockImplementation(() => new EventEmitter() as any)
    mockFs.renameSync.mockReturnValue(undefined as any)
    mockFs.unlinkSync.mockReturnValue(undefined as any)
    mockExec.mockReset()
    mockSpawn.mockReset()
    mockSpawn.mockReturnValue({ unref: vi.fn() } as any)
  })

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl
  })

  it('POST /update returns 400 when git is unavailable', async () => {
    mockExec.mockImplementation(((command: any, callback: any) => {
      if (command === 'git --version') callback(new Error('git missing'))
      return {} as any
    }) as any)

    const res = await request(makeApp())
      .post('/update')
      .set(authHeader)

    expect(res.status).toBe(400)
    expect(res.body).toEqual(expect.objectContaining({ code: 'GIT_NOT_FOUND' }))
  })

  it('POST /update starts update.sh when present', async () => {
    mockExec.mockImplementation(((command: any, callback: any) => {
      if (command === 'git --version') callback(null, 'git version', '')
      return {} as any
    }) as any)
    mockFs.existsSync.mockImplementation((target: any) => String(target).endsWith('update.sh'))

    const res = await request(makeApp())
      .post('/update')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(expect.objectContaining({ status: 'success' }))
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/update\.log$/), 'Initiating update...\n')
    expect(mockSpawn).toHaveBeenCalledWith('bash', ['update.sh'], expect.objectContaining({ detached: true, stdio: 'ignore' }))
  })

  it('POST /update returns 500 when spawning update.sh fails', async () => {
    mockExec.mockImplementation(((command: any, callback: any) => {
      if (command === 'git --version') callback(null, 'git version', '')
      return {} as any
    }) as any)
    mockFs.existsSync.mockImplementation((target: any) => String(target).endsWith('update.sh'))
    mockFs.writeFileSync.mockImplementation(() => {
      throw new Error('write failed')
    })

    const res = await request(makeApp())
      .post('/update')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ code: 'UPDATE_FAILED', message: 'Failed to start update script.', error: 'write failed' })
  })

  it('POST /update falls back to git pull', async () => {
    mockExec.mockImplementation(((command: any, optionsOrCallback: any, maybeCallback?: any) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      if (command === 'git --version') callback(null, 'git version', '')
      if (command === 'git pull') callback(null, 'Already up to date.', '')
      return {} as any
    }) as any)
    mockFs.existsSync.mockReturnValue(false)

    const res = await request(makeApp())
      .post('/update')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'success',
      message: 'System code updated successfully. Dev servers will auto-restart.',
      stdout: 'Already up to date.',
      stderr: '',
    })
  })

  it('POST /update logs successful git pull stderr output when present', async () => {
    mockExec.mockImplementation(((command: any, optionsOrCallback: any, maybeCallback?: any) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      if (command === 'git --version') callback(null, 'git version', '')
      if (command === 'git pull') callback(null, 'Updated', 'warning: local changes ignored')
      return {} as any
    }) as any)
    mockFs.existsSync.mockReturnValue(false)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const res = await request(makeApp())
      .post('/update')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(warnSpy).toHaveBeenCalledWith('System update stderr:', 'warning: local changes ignored')
    warnSpy.mockRestore()
  })

  it('POST /update returns 500 when git pull fails', async () => {
    mockExec.mockImplementation(((command: any, optionsOrCallback: any, maybeCallback?: any) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      if (command === 'git --version') callback(null, 'git version', '')
      if (command === 'git pull') callback(new Error('pull failed'), '', 'fatal: failed')
      return {} as any
    }) as any)

    const res = await request(makeApp())
      .post('/update')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({
      code: 'UPDATE_FAILED',
      message: 'Failed to run git pull. Make sure git is installed and configured.',
      error: 'pull failed',
      stderr: 'fatal: failed',
    })
  })

  it('GET /update-log returns a default message when no log exists', async () => {
    mockFs.existsSync.mockReturnValue(false)

    const res = await request(makeApp())
      .get('/update-log')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ log: 'No update history found.' })
  })

  it('GET /update-log reads the update log', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue('build ok' as any)

    const res = await request(makeApp())
      .get('/update-log')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ log: 'build ok' })
  })

  it('GET /update-log returns 500 when reading fails', async () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('read failed')
    })

    const res = await request(makeApp())
      .get('/update-log')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ code: 'READ_LOG_FAILED', message: 'Failed to read update log file.', error: 'read failed' })
  })

  it('GET /google-config returns the default redirect when config is missing', async () => {
    const res = await request(makeApp())
      .get('/google-config')
      .set(authHeader)
      .set('Host', 'example.com')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ exists: false, defaultRedirectUri: 'http://example.com/connected-accounts/google/callback' })
  })

  it('GET /google-config returns decrypted config details', async () => {
    mockPrisma.providerConfig.findFirst.mockResolvedValue({
      clientIdEncrypted: 'cid',
      clientSecretEncrypted: 'csecret',
      redirectUri: 'https://example.com/callback',
    })

    const res = await request(makeApp())
      .get('/google-config')
      .set(authHeader)
      .set('Host', 'example.com')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      exists: true,
      clientId: 'decrypted:cid',
      redirectUri: 'https://example.com/callback',
      hasSecret: true,
      defaultRedirectUri: 'http://example.com/connected-accounts/google/callback',
    })
  })

  it('GET /google-config tolerates decrypt failures', async () => {
    mockPrisma.providerConfig.findFirst.mockResolvedValue({
      clientIdEncrypted: 'cid',
      clientSecretEncrypted: '',
      redirectUri: 'https://example.com/callback',
    })
    mockDecryptText.mockImplementationOnce(() => {
      throw new Error('bad decrypt')
    })

    const res = await request(makeApp())
      .get('/google-config')
      .set(authHeader)
      .set('Host', 'example.com')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      exists: true,
      clientId: '',
      redirectUri: 'https://example.com/callback',
      hasSecret: false,
      defaultRedirectUri: 'http://example.com/connected-accounts/google/callback',
    })
  })

  it('GET /google-config passes database errors to next', async () => {
    mockPrisma.providerConfig.findFirst.mockRejectedValue(new Error('config lookup failed'))

    const res = await request(makeApp())
      .get('/google-config')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'config lookup failed' })
  })

  it('POST /google-config requires a client id', async () => {
    const res = await request(makeApp())
      .post('/google-config')
      .set(authHeader)
      .send({ clientSecret: 'secret' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'BAD_REQUEST', message: 'Client ID is required.' })
  })

  it('POST /google-config creates a new config when a secret is provided', async () => {
    const res = await request(makeApp())
      .post('/google-config')
      .set(authHeader)
      .set('Host', 'example.com')
      .send({ clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://example.com/callback' })

    expect(res.status).toBe(201)
    expect(mockPrisma.providerConfig.updateMany).toHaveBeenCalledWith({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      data: { status: 'disabled' },
    })
    expect(mockPrisma.providerConfig.create).toHaveBeenCalledWith({
      data: {
        userId: null,
        provider: 'google_drive',
        clientIdEncrypted: 'encrypted:client-id',
        clientSecretEncrypted: 'encrypted:client-secret',
        redirectUri: 'https://example.com/callback',
        scopes: [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
        ],
        status: 'active',
      },
    })
    expect(res.body).toEqual({ status: 'success', message: 'Global Google OAuth configuration updated successfully.', id: 'config-1' })
  })

  it('POST /google-config reuses the old secret when omitted', async () => {
    mockPrisma.providerConfig.findFirst.mockResolvedValueOnce({ clientSecretEncrypted: 'old-secret' })

    const res = await request(makeApp())
      .post('/google-config')
      .set(authHeader)
      .set('Host', 'example.com')
      .send({ clientId: 'client-id' })

    expect(res.status).toBe(201)
    expect(mockPrisma.providerConfig.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        clientSecretEncrypted: 'encrypted:decrypted:old-secret',
        redirectUri: 'http://example.com/connected-accounts/google/callback',
      }),
    }))
  })

  it('POST /google-config requires a secret for first-time setup', async () => {
    mockPrisma.providerConfig.findFirst.mockResolvedValueOnce(null)

    const res = await request(makeApp())
      .post('/google-config')
      .set(authHeader)
      .send({ clientId: 'client-id' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'BAD_REQUEST', message: 'Client Secret is required for first-time setup.' })
  })

  it('POST /google-config ignores decrypt failures on disabled configs and still validates', async () => {
    mockPrisma.providerConfig.findFirst.mockResolvedValueOnce({ clientSecretEncrypted: 'old-secret' })
    mockDecryptText.mockImplementationOnce(() => {
      throw new Error('decrypt failed')
    })

    const res = await request(makeApp())
      .post('/google-config')
      .set(authHeader)
      .send({ clientId: 'client-id' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'BAD_REQUEST', message: 'Client Secret is required for first-time setup.' })
  })

  it('POST /google-config passes database errors to next', async () => {
    mockPrisma.providerConfig.updateMany.mockRejectedValue(new Error('save failed'))

    const res = await request(makeApp())
      .post('/google-config')
      .set(authHeader)
      .send({ clientId: 'client-id', clientSecret: 'client-secret' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'save failed' })
  })

  it('GET /backup returns 404 when the database file is missing', async () => {
    mockFs.existsSync.mockImplementation((target: any) => String(target) === '/var/lib/9drive/dev.db' ? false : false)

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: 'Database file not found.' })
  })

  it('GET /backup streams the database file', async () => {
    mockFs.existsSync.mockImplementation((target: any) => String(target) === '/var/lib/9drive/dev.db')

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockFs.createReadStream).toHaveBeenCalledWith('/var/lib/9drive/dev.db')
    expect(res.headers['content-disposition']).toBe('attachment; filename=9drive-backup.db')
    expect(res.headers['content-type']).toContain('application/octet-stream')
  })

  it('GET /backup uses the default database path when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL
    const expectedPath = path.resolve(process.cwd(), '..', 'backend', 'prisma', './dev.db')
    mockFs.existsSync
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => false)
      .mockImplementation((target: any) => String(target) === expectedPath)

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockFs.createReadStream).toHaveBeenCalledWith(expectedPath)
  })

  it('GET /backup passes stream creation errors to next', async () => {
    mockFs.existsSync.mockImplementation((target: any) => String(target) === '/var/lib/9drive/dev.db')
    mockFs.createReadStream.mockImplementation(() => {
      throw new Error('stream failed')
    })

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(500)
    expect(mockFs.createReadStream).toHaveBeenCalledWith('/var/lib/9drive/dev.db')
  })

  it('GET /backup supports absolute DATABASE_URL values without the file prefix', async () => {
    process.env.DATABASE_URL = '/absolute/path/dev.db'
    mockFs.existsSync.mockImplementation((target: any) => String(target) === '/absolute/path/dev.db')

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockFs.createReadStream).toHaveBeenCalledWith('/absolute/path/dev.db')
  })

  it('GET /backup resolves relative DATABASE_URL values from prisma when that directory exists', async () => {
    process.env.DATABASE_URL = 'file:./relative.db'
    const expectedPath = path.resolve(process.cwd(), 'prisma', './relative.db')
    mockFs.existsSync
      .mockImplementationOnce(() => true)
      .mockImplementation((target: any) => String(target) === expectedPath)

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockFs.createReadStream).toHaveBeenCalledWith(expectedPath)
  })

  it('GET /backup falls back to backend/prisma for relative DATABASE_URL values', async () => {
    process.env.DATABASE_URL = 'file:./fallback.db'
    const expectedPath = path.resolve(process.cwd(), 'backend', 'prisma', './fallback.db')
    mockFs.existsSync
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => true)
      .mockImplementation((target: any) => String(target) === expectedPath)

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockFs.createReadStream).toHaveBeenCalledWith(expectedPath)
  })

  it('GET /backup falls back to ../backend/prisma when other relative directories are missing', async () => {
    process.env.DATABASE_URL = 'file:./final.db'
    const expectedPath = path.resolve(process.cwd(), '..', 'backend', 'prisma', './final.db')
    mockFs.existsSync
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => false)
      .mockImplementation((target: any) => String(target) === expectedPath)

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockFs.createReadStream).toHaveBeenCalledWith(expectedPath)
  })

  it('GET /backup strips query parameters from DATABASE_URL values', async () => {
    process.env.DATABASE_URL = 'file:./query.db?cache=shared'
    const expectedPath = path.resolve(process.cwd(), 'prisma', './query.db')
    mockFs.existsSync
      .mockImplementationOnce(() => true)
      .mockImplementation((target: any) => String(target) === expectedPath)

    const res = await request(makeApp())
      .get('/backup')
      .set(authHeader)

    expect(res.status).toBe(200)
    expect(mockFs.createReadStream).toHaveBeenCalledWith(expectedPath)
  })

  it('POST /restore requires multipart form data', async () => {
    const res = await request(makeApp())
      .post('/restore')
      .set(authHeader)
      .send({ nope: true })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'BAD_REQUEST', message: 'multipart/form-data required.' })
  })

  it('POST /restore returns 400 when no file is uploaded', async () => {
    busboyState.mode = 'no-file'

    const res = await request(makeApp())
      .post('/restore')
      .set(authHeader)
      .set('Content-Type', 'multipart/form-data; boundary=---x')
      .send('--ignored--')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'BAD_REQUEST', message: 'No file uploaded.' })
  })

  it('POST /restore restores the database and schedules a restart', async () => {
    vi.useFakeTimers()
    busboyState.mode = 'success'
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any)
    mockFs.createWriteStream.mockImplementation(() => new EventEmitter() as any)

    const resPromise = request(makeApp())
      .post('/restore')
      .set(authHeader)
      .set('Content-Type', 'multipart/form-data; boundary=---x')
      .send('--ignored--')

    await vi.runAllTicks()
    const res = await resPromise

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'success', message: 'Database restored successfully. Server will restart in 2 seconds.' })
    expect(mockPrisma.$disconnect).toHaveBeenCalled()
    expect(mockFs.renameSync).toHaveBeenCalledWith('/var/lib/9drive/dev.db.tmp', '/var/lib/9drive/dev.db')
    vi.runAllTimers()
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })

  it('POST /restore returns 500 on write errors', async () => {
    busboyState.mode = 'write-error'
    mockFs.createWriteStream.mockImplementation(() => new EventEmitter() as any)
    mockFs.existsSync.mockImplementation((target: any) => String(target) === '/var/lib/9drive/dev.db.tmp')

    const res = await request(makeApp())
      .post('/restore')
      .set(authHeader)
      .set('Content-Type', 'multipart/form-data; boundary=---x')
      .send('--ignored--')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ code: 'WRITE_ERROR', message: 'Failed to write temporary database file.', error: 'write failed' })
    expect(mockFs.unlinkSync).toHaveBeenCalledWith('/var/lib/9drive/dev.db.tmp')
  })

  it('POST /restore still returns 500 when temp cleanup after a write error also fails', async () => {
    busboyState.mode = 'write-error'
    mockFs.createWriteStream.mockImplementation(() => new EventEmitter() as any)
    mockFs.existsSync.mockImplementation((target: any) => String(target) === '/var/lib/9drive/dev.db.tmp')
    mockFs.unlinkSync.mockImplementation(() => {
      throw new Error('unlink failed')
    })

    const res = await request(makeApp())
      .post('/restore')
      .set(authHeader)
      .set('Content-Type', 'multipart/form-data; boundary=---x')
      .send('--ignored--')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ code: 'WRITE_ERROR', message: 'Failed to write temporary database file.', error: 'write failed' })
  })

  it('POST /restore returns 500 when replacing the database fails', async () => {
    busboyState.mode = 'success'
    mockFs.createWriteStream.mockImplementation(() => new EventEmitter() as any)
    mockFs.existsSync.mockImplementation((target: any) => String(target) === '/var/lib/9drive/dev.db.tmp')
    mockFs.renameSync.mockImplementation(() => {
      throw new Error('rename failed')
    })

    const res = await request(makeApp())
      .post('/restore')
      .set(authHeader)
      .set('Content-Type', 'multipart/form-data; boundary=---x')
      .send('--ignored--')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ code: 'RESTORE_FAILED', message: 'Failed to restore database.', error: 'rename failed' })
    expect(mockFs.unlinkSync).toHaveBeenCalledWith('/var/lib/9drive/dev.db.tmp')
  })

  it('POST /restore still returns 500 when temp cleanup after replace failure also fails', async () => {
    busboyState.mode = 'success'
    mockFs.createWriteStream.mockImplementation(() => new EventEmitter() as any)
    mockFs.existsSync.mockImplementation((target: any) => String(target) === '/var/lib/9drive/dev.db.tmp')
    mockFs.renameSync.mockImplementation(() => {
      throw new Error('rename failed')
    })
    mockFs.unlinkSync.mockImplementation(() => {
      throw new Error('unlink failed')
    })

    const res = await request(makeApp())
      .post('/restore')
      .set(authHeader)
      .set('Content-Type', 'multipart/form-data; boundary=---x')
      .send('--ignored--')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ code: 'RESTORE_FAILED', message: 'Failed to restore database.', error: 'rename failed' })
  })

  it('POST /restore passes busboy errors to next', async () => {
    busboyState.mode = 'busboy-error'

    const res = await request(makeApp())
      .post('/restore')
      .set(authHeader)
      .set('Content-Type', 'multipart/form-data; boundary=---x')
      .send('--ignored--')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'busboy failed' })
  })

  it('POST /restore passes constructor errors to next', async () => {
    BusboyMock.mockImplementationOnce(() => {
      throw new Error('restore init failed')
    })

    const res = await request(makeApp())
      .post('/restore')
      .set(authHeader)
      .set('Content-Type', 'multipart/form-data; boundary=---x')
      .send('--ignored--')

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'restore init failed' })
  })
})
