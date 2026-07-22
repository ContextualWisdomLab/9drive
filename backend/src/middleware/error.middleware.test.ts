import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { errorMiddleware } from './error.middleware.js'

function mockRes() {
  const res = {} as Response
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res
}

describe('errorMiddleware', () => {
  it('returns the error message for Error instances', () => {
    const res = mockRes()
    errorMiddleware(new Error('boom'), {} as Request, res, vi.fn())
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' })
  })

  it('returns a default message for non-Error values', () => {
    const res = mockRes()
    errorMiddleware('some string', {} as Request, res, vi.fn())
    expect(res.json).toHaveBeenCalledWith({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' })
  })
})
