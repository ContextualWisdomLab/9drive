import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/prisma.js', () => ({
  prisma: {
    auditLog: {
      create: vi.fn(),
    },
  },
}))

import { createAuditLog } from './audit.js'
import { prisma } from '../config/prisma.js'

const mockPrisma = prisma as unknown as { auditLog: { create: ReturnType<typeof vi.fn> } }

describe('createAuditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates an audit log with stringified metadata', async () => {
    mockPrisma.auditLog.create.mockResolvedValue({})
    await createAuditLog('user-1', 'ACTION', 'entity', 'entity-1', { key: 'value' })
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: 'ACTION',
        entityType: 'entity',
        entityId: 'entity-1',
        metadata: { key: 'value' },
      },
    })
  })

  it('creates an audit log without metadata', async () => {
    mockPrisma.auditLog.create.mockResolvedValue({})
    await createAuditLog('user-1', 'ACTION', 'entity')
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: 'ACTION',
        entityType: 'entity',
        entityId: undefined,
        metadata: undefined,
      },
    })
  })

  it('swallows errors when creation fails', async () => {
    mockPrisma.auditLog.create.mockRejectedValue(new Error('db down'))
    await expect(createAuditLog('user-1', 'ACTION', 'entity')).resolves.toBeUndefined()
  })
})
