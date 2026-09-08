import assert from 'node:assert/strict'
import test from 'node:test'

import { buildGoogleUploadRequestBody } from '../dist/modules/uploads/google-upload-contract.js'
import { getFileDatabasePath } from '../dist/modules/system/database-file-contract.js'

test('Google upload request body keeps provider ACLs private by construction', () => {
  assert.deepEqual(buildGoogleUploadRequestBody('report.pdf', 'app-folder'), {
    name: 'report.pdf',
    parents: ['app-folder'],
  })
})

test('server database URLs cannot be interpreted as local backup paths', () => {
  assert.throws(
    () => getFileDatabasePath('mysql://9drive:secret@mysql:3306/9drive', process.cwd()),
    /database-file-path-unavailable-for-server-database/,
  )
  assert.throws(
    () => getFileDatabasePath('postgresql://9drive:secret@db/9drive', process.cwd()),
    /database-file-path-unavailable-for-server-database/,
  )
})

test('file database URLs resolve query-free paths for backup and restore', () => {
  assert.equal(
    getFileDatabasePath('file:/var/lib/9drive/dev.db?connection_limit=1', '/app'),
    '/var/lib/9drive/dev.db',
  )
  assert.equal(
    getFileDatabasePath('sqlite:./dev.db', '/app/prisma'),
    '/app/prisma/dev.db',
  )
})
