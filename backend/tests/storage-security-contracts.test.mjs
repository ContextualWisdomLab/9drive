import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('Google upload paths do not widen provider ACLs as a storage side effect', () => {
  const source = readSource('../src/modules/uploads/upload.routes.ts')

  assert.doesNotMatch(source, /permissions\.create\s*\(/)
  assert.doesNotMatch(source, /type\s*:\s*['"]anyone['"]/)
  assert.doesNotMatch(source, /role\s*:\s*['"]writer['"]\s*,?\s*\n\s*type\s*:\s*['"]anyone['"]/)
})

test('server-database backup and restore fail closed instead of treating the URL as a file path', () => {
  const source = readSource('../src/modules/system/system.routes.ts')
  const guards = source.match(/if \(!isFileDatabase\(\)\)/g) ?? []

  assert.equal(guards.length, 2)
  assert.match(source, /code:\s*['"]DATABASE_BACKUP_UNSUPPORTED['"]/)
  assert.match(source, /code:\s*['"]DATABASE_RESTORE_UNSUPPORTED['"]/)
  assert.match(source, /throw new Error\(['"]database-file-path-unavailable-for-server-database['"]\)/)
})
