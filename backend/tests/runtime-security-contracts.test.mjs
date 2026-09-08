import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.DATABASE_URL = 'mysql://9drive:test@localhost:3306/9drive'
process.env.FRONTEND_URL = 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET = 'j'.repeat(32)
process.env.TOKEN_ENCRYPTION_KEY = 'k'.repeat(32)

const { decryptText, encryptText } = await import('../dist/utils/crypto.js')

test('AES-256-GCM rejects authentication tags shorter than 128 bits', () => {
  const [iv, tag, ciphertext] = encryptText('commercial-intake-evidence').split(':')
  const shortenedTag = Buffer.from(tag, 'base64').subarray(0, 12).toString('base64')

  assert.throws(() => decryptText(`${iv}:${shortenedTag}:${ciphertext}`))
})

test('runtime images declare a non-root final user', () => {
  for (const dockerfile of [
    new URL('../Dockerfile', import.meta.url),
    new URL('../../frontend/Dockerfile', import.meta.url),
  ]) {
    const source = readFileSync(dockerfile, 'utf8')
    assert.match(source, /^USER\s+(?!root(?::|\s|$)|0(?::|\s|$))\S+/m)
  }
})

test('frontend Compose routing uses the unprivileged Nginx port', () => {
  const dockerfile = readFileSync(new URL('../../frontend/Dockerfile', import.meta.url), 'utf8')
  const nginx = readFileSync(new URL('../../frontend/nginx.conf', import.meta.url), 'utf8')
  const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

  assert.match(dockerfile, /^EXPOSE 8080$/m)
  assert.match(nginx, /^\s*listen 8080;$/m)
  assert.match(compose, /"127\.0\.0\.1:5173:8080"/)
})
