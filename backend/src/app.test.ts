import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { app } from './app.js'

describe('app', () => {
  it('responds to GET /health', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('applies CORS headers for the configured frontend origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/does-not-exist')
    expect(res.status).toBe(404)
  })
})
