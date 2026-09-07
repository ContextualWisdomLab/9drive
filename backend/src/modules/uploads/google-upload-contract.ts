/** Metadata accepted by Google Drive when 9Drive creates a private file. */
export type GoogleUploadRequestBody = {
  name: string
  parents: string[]
}

/** Build upload metadata without any ACL or public-sharing side effect. */
export function buildGoogleUploadRequestBody(
  fileName: string,
  parentFolderId: string,
): GoogleUploadRequestBody {
  return { name: fileName, parents: [parentFolderId] }
}
