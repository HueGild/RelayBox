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
 * @property {number|null} expiresAt null = permanent
 * @property {number} downloads
 * @property {number} uploadedAt
 * @property {string|null} [uploadIp]  uploader IP (admin-only on read, v3.1.5)
 * @property {string|null} [uploadGeo] uploader geo from CF request.cf (admin-only on read, v3.1.5)
 * @property {number|null} [width]     image/video pixel width (v3.1.5)
 * @property {number|null} [height]    image/video pixel height (v3.1.5)
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
 * @property {string} code        extraction code, '' = none
 * @property {boolean} burn       burn-after-reading
 * @property {number} createdAt
 * @property {number} maxDownloads  0 = unlimited, 1 = burn-after-reading, N = limited (v3.1)
 * @property {number} usedDownloads downloads already served through this share (v3.1)
 * @property {string|null} pickupCode 5-char pickup code, null = none (v3.1)
 *
 * @typedef {Object} ApiTokenItem
 * @property {string} id
 * @property {string} name
 * @property {string} prefix      first 8 chars preview, e.g. "rbx_a1b2" (v3.1)
 * @property {string} scope       'upload' | 'all' (v3.1)
 * @property {number|null} lastUsedAt
 * @property {number} createdAt
 *
 * @typedef {Object} ChunkUpload
 * @property {string} uploadId
 * @property {string|null} r2UploadId  R2 multipart upload id (CF only)
 * @property {string|null} storageKey
 * @property {string} name
 * @property {number} size
 * @property {number} total       total part count
 * @property {{partNumber:number,etag:string}[]} received
 * @property {'local'|'r2'} storage
 * @property {string|null} folderId
 * @property {'public'|'private'} visibility
 * @property {number} expiresHours 0 = permanent
 * @property {number} createdAt
 */

export const MetaStoreMethods = [
  'getFile', 'listFiles', 'listAllFiles', 'searchFiles', 'createFile', 'updateFile', 'deleteFile',
  'incrementDownloads',
  'listFolders', 'getFolder', 'createFolder', 'updateFolder', 'deleteFolder',
  'getShareByToken', 'getShareByFileId', 'getShareByFolderId', 'getShareByPickupCode',
  'createShare', 'updateShare', 'deleteShare', 'incrementShareDownloads',
  'createApiToken', 'getApiTokenByHash', 'listApiTokens', 'deleteApiToken', 'touchApiToken',
  'getSession', 'createSession', 'deleteSession', 'deleteExpiredSessions',
  'getAnnouncement', 'setAnnouncement',
  'getSetting', 'setSetting',
  'listStoragePools', 'getStoragePool', 'createStoragePool', 'updateStoragePool', 'deleteStoragePool',
  'recordFailure', 'countFailuresSince', 'clearFailures', 'isBlocked',
  'getChunkUpload', 'createChunkUpload', 'updateChunkUpload', 'deleteChunkUpload',
  'listStaleChunkUploads',
  'writeChunkPart', 'readChunkPart', 'chunkPartExists', 'assembleChunks',
];

export const StorageStoreMethods = [
  'put', 'get', 'head', 'delete', 'copy', 'rename',
  'presignedPutUrl', 'presignedGetUrl',
  'createMultipartUpload', 'presignedPartUrl',
  'completeMultipartUpload', 'abortMultipartUpload',
  'putFile', 'putThumb', 'getThumb', 'deleteThumb',
];

/** Throws unless `impl` provides every method in `methods`. */
export function assertImplements(impl, methods, name) {
  for (const m of methods) {
    if (typeof impl[m] !== 'function') throw new Error(`${name} is missing method: ${m}`);
  }
}
