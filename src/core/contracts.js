// RelayBox core contracts — MetaStore / StorageStore.
// These interfaces are the boundary between the Hono routes (src/core, Web-standard
// APIs only) and the runtime adapters (src/adapters/*). Both targets implement them.
// Full definitions: REFACTOR-PLAN.md §3. All methods return Promises.
// Timestamps are Unix milliseconds. `null` folderId means the root directory.

/**
 * @typedef {Object} FileItem
 * @property {string} id
 * @property {string} name
 * @property {number} size
 * @property {string} ext
 * @property {'image'|'video'|'audio'|'archive'|'file'} kind
 * @property {'local'|'r2'} storage
 * @property {string} storageKey   physical key, e.g. 2026/11/<id>_<name>
 * @property {string|null} folderId
 * @property {'public'|'private'} visibility
 * @property {number|null} expiresAt  null = permanent
 * @property {number} downloads
 * @property {number} uploadedAt
 *
 * @typedef {Object} FolderItem
 * @property {string} id
 * @property {string} name
 * @property {string|null} parentId
 * @property {number} createdAt
 *
 * @typedef {Object} ShareItem
 * @property {string} token
 * @property {string|null} fileId
 * @property {string|null} folderId
 * @property {string} code         extraction code, '' = none
 * @property {boolean} burn        burn-after-reading
 * @property {number} createdAt
 *
 * @typedef {Object} ChunkUpload
 * @property {string} uploadId
 * @property {string|null} r2UploadId   R2 multipart upload id (CF only)
 * @property {string|null} storageKey
 * @property {string} name
 * @property {number} size
 * @property {number} total              total part count
 * @property {{partNumber:number,etag:string}[]} received
 * @property {'local'|'r2'} storage
 * @property {string|null} folderId
 * @property {'public'|'private'} visibility
 * @property {number} expiresHours       0 = permanent
 * @property {number} createdAt
 */

/**
 * MetaStore — all metadata. Implementations: JsonMetaStore (VPS), D1MetaStore (CF).
 * deleteFolder refuses when the folder holds files OR subfolders (same rule as v2.8.4).
 * Shares have no independent expiry: a share follows its file (expired files take
 * their file-shares with them in cleanup; folder shares survive single-file expiry).
 */
export const MetaStoreMethods = [
  'getFile', 'listFiles', 'searchFiles', 'createFile', 'updateFile', 'deleteFile',
  'incrementDownloads',
  'listFolders', 'getFolder', 'createFolder', 'updateFolder', 'deleteFolder',
  'getShareByToken', 'getShareByFileId', 'getShareByFolderId',
  'createShare', 'updateShare', 'deleteShare',
  'getSession', 'createSession', 'deleteSession', 'deleteExpiredSessions',
  'getAnnouncement', 'setAnnouncement',
  'recordFailure', 'countFailuresSince', 'clearFailures',
  'getChunkUpload', 'createChunkUpload', 'updateChunkUpload', 'deleteChunkUpload',
  'listStaleChunkUploads',
];

/**
 * StorageStore — file blobs. Implementations: LocalStorage (VPS disk),
 * R2Storage (VPS via AWS SDK, CF via R2 Binding + aws4fetch for presigning).
 * The R2 driver behind both is { put, get, head, delete, copy,
 * signPut, signGet, createMultipart, signPart, completeMultipart, abortMultipart }.
 */
export const StorageStoreMethods = [
  'put', 'get', 'head', 'delete', 'copy',
  'presignedPutUrl', 'presignedGetUrl',
  'createMultipartUpload', 'presignedPartUrl',
  'completeMultipartUpload', 'abortMultipartUpload',
];

/** Throws unless `impl` provides every method in `methods`. */
export function assertImplements(impl, methods, name) {
  for (const m of methods) {
    if (typeof impl[m] !== 'function') throw new Error(`${name} is missing method: ${m}`);
  }
}
