import crypto from 'node:crypto'
import { env } from '../config/env.js'

const key = crypto.createHash('sha256').update(env.TOKEN_ENCRYPTION_KEY).digest()

/** Encrypt application-held secret text with AES-256-GCM and a 128-bit tag. */
export function encryptText(value: string) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

/** Decrypt a colon-delimited AES-256-GCM payload after enforcing its 128-bit tag. */
export function decryptText(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(':')
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted payload')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64'), {
    authTagLength: 16,
  })
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64')), decipher.final()]).toString('utf8')
}

/** Return a cryptographically random URL-safe token. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** Return a stable SHA-256 digest for a revocable token. */
export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex')
}
