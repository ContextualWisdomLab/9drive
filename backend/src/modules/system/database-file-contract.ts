import path from 'node:path'

/** Return whether a database URL identifies a local file-backed database. */
export function isFileDatabaseUrl(databaseUrl: string): boolean {
  return /^(sqlite|file):/.test(databaseUrl)
}

/** Resolve a file database URL or fail closed for server database URLs. */
export function getFileDatabasePath(
  databaseUrl: string,
  databaseDirectory: string,
): string {
  if (!isFileDatabaseUrl(databaseUrl)) {
    throw new Error('database-file-path-unavailable-for-server-database')
  }

  const databasePath = databaseUrl
    .replace(/^(sqlite|file):/, '')
    .split('?', 1)[0]

  return path.isAbsolute(databasePath)
    ? databasePath
    : path.resolve(databaseDirectory, databasePath)
}
