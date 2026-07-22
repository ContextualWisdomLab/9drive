import { describe, it, expect } from 'vitest'
import { prisma } from './prisma.js'

describe('prisma client', () => {
  it('exports a prisma client instance', () => {
    expect(prisma).toBeDefined()
    expect(typeof prisma.$connect).toBe('function')
  })
})
