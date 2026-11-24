# RelayBox 双端部署重构方案（v3.0 规划）

> 项目名：**RelayBox**（原“文件传输助手”/ file-share）。协议：**MIT**。仓库：**新建干净公开仓库**。
> 目标：一套代码，两个部署目标——VPS（Node.js）与 Cloudflare（Workers + R2 + D1 + Static Assets），
> 前端 `public/index.html` 零改动；同时为开源发布做准备。
> 现状基线：v2.8.4（server.js 1358 行，index.html 2253 行），线上站正常运行，重构期间不受影响。
>
> **已确认的 6 个决策（2026-11-24，Jay 拍板）**：
> 1. 项目名 RelayBox（备选 DualDrive 未采用：易与 SanDisk 双接口 U 盘撞名，且“Drive”偏网盘，Relay 更贴合中转传输）。
> 2. 协议 MIT。3. 新建干净公开仓库（不公开现有私有仓库的历史）。
> 4. **CF 版为主站**（免维护、吃 CDN），**VPS 版保留并行**（扛超大文件、利用本地硬盘），两边互为备份，迁移期间线上站零中断。
> 5. 上传上限做成环境变量 `MAX_UPLOAD_SIZE`：CF 默认 5GB，VPS 默认 10GB。
> 6. VPS 版**必须保留本地硬盘 + R2 双存储池**（VPS 版区别于纯 CF 项目的核心卖点）。

## 0. 目标与原则

1. **一套代码，两端部署**：业务逻辑只写一次，运行时差异由适配器隔离。
2. **前端零改动**：API 契约冻结（见 §7），`index.html` 一个字节都不用改。
3. **线上站不受影响**：先在新分支/新仓库里重构并测通，再切线上；v2.8.4 的 VPS 部署方式全程可用。
4. **开源友好**：零原生依赖（VPS 部署不用编译），一键部署（Docker Compose / `wrangler deploy`），干净仓库 + MIT。

## 1. 现状盘点（v2.8.4，迁移有利的事实）

| 现状 | 对迁移的意义 |
|---|---|
| server.js 1358 行，Node `http` 原生服务；依赖只有 `busboy`（multipart）+ `@aws-sdk/client-s3`（R2） | 依赖少，换 Hono 后依赖仍可控 |
| 文件/文件夹已用唯一 id + `parentId` 维护逻辑树 | **逻辑目录树与物理存储早已解耦**，迁移到 D1 + R2 不用重做模型 |
| 本地文件名与 R2 Key 都是扁平的 `${id}_${name}`，不按目录层级存 | storageKey 只需在元数据里记一个字段，新老格式可共存，无需迁移旧文件 |
| `r2Used` / `localUsed` 由文件元数据求和得出，不读存储 | Blob 接口不需要 `usage()` 方法 |
| R2 上传已是预签名直传（v1.5：`/api/upload-url` → 浏览器直传 R2 → `/api/upload-complete` 做 HeadObject 校验） | CF 版的大文件链路已有现成模式可复用 |
| 单文件上限已是 5GB（`MAX_FILE_SIZE`），R2 免费额度 10GB | 上限改为环境变量 `MAX_UPLOAD_SIZE`（CF 默认 5GB，VPS 默认 10GB），两端可配 |
| 元数据是 5 个 JSON 文件（files / shares / folders / sessions / announcement）+ `data/chunks/` | 元数据模型简单，正好对应 6 张 D1 表 |
| 防爆破是内存 `failMap`（5 次/10 分钟 → 封 10 分钟） | CF 版需落到 D1（见 §3.1 的 rateLimit 方法） |

## 2. 目标架构

```
浏览器 ──► Hono App（src/core，纯 Web 标准 API，零 Node 依赖）
              │
              ├─ MetaStore ────────► JsonMetaStore（VPS：JSON 文件 + 串行写队列）
              │                      └─ D1MetaStore（CF：D1）
              │
              └─ StorageStore ─────► LocalStorage（VPS：本地硬盘）
                                     └─ R2Storage（VPS 选配 / CF 唯一：R2）
```

### 目录结构

```
src/
├── core/                  # 纯标准 Web API 的 Hono 路由与业务逻辑（零 Node 依赖）
│   ├── app.js             # 建 Hono 实例、挂路由、注入 adapters
│   ├── routes/            # 按资源分文件：auth.js files.js folders.js shares.js
│   │                      #   upload.js chunks.js thumbs.js announce.js deploy.js
│   ├── lib/               # 纯函数：mime、kindOf、id 生成、pathOf、expiry、fmtSize
│   └── contracts.js       # MetaStore / StorageStore 的接口定义（JSDoc + 运行时校验）
├── adapters/
│   ├── node/              # 仅此处可用 node:fs / node:path
│   │   ├── json-meta.js   # JsonMetaStore
│   │   ├── local-storage.js
│   │   └── r2-storage.js  # 与 CF 共用同一份 R2 逻辑（见 §3.2 注）
│   └── cf/
│       ├── d1-meta.js     # D1MetaStore
│       └── r2-storage.js  # 用 R2 Binding（createMultipartUpload 等）
├── entry-node.js          # VPS 入口：@hono/node-server + 静态托管 public/
├── entry-worker.js        # CF 入口：export default { fetch, scheduled }
├── schema.sql             # D1 建表（§5）
├── migrate.js             # 一次性迁移：VPS 的 JSON + 本地文件 → D1 + R2
├── wrangler.toml          # CF：Workers + Static Assets + R2/D1 绑定 + Cron
├── docker-compose.yml     # VPS 一键部署
└── package.json           # 依赖：hono、@hono/node-server、busboy（仅 Node 入口用）、
                           #   @aws-sdk/client-s3（仅 Node 的 R2 用；CF 用 Binding 不需要 SDK）
```

### 隔离规则（防 Node 依赖污染 Worker）

- `src/core/` **禁止**出现 `node:`、`fs`、`path`、`crypto`（Node 版）、`__dirname`、`process.env`。
  用 CI 一行 grep 兜底：`grep -rn "from ['\"]node:\|require(['\"]fs\|require(['\"]path" src/core/ && exit 1`。
- 配置统一走一个 `loadConfig(env)`：VPS 读 `config.json`（保持现状，gitignored），
  CF 读 wrangler 的 `vars` + secrets + 绑定；两端拼成同一份 config 对象再注入 core。
- `crypto` 只用 Web Crypto（`crypto.randomUUID()` / `crypto.subtle`），两端通用。
  现有的 id 生成若用了 Node `crypto.randomBytes`，统一改成 `crypto.randomUUID()`。

## 3. 接口契约（定死之后，迁移就顺滑）

### 3.1 MetaStore（元数据层）

> 实现：`JsonMetaStore`（VPS）与 `D1MetaStore`（CF）。所有方法返回 Promise；时间统一用毫秒时间戳。

```js
// ---- 文件 ----
getFile(id) -> file | null
listFiles(folderId, { authed }) -> file[]            // 含 visibility 过滤（访客只见公开）
searchFiles(q, { authed }) -> file[]
createFile(file) -> file
updateFile(id, patch) -> file | null                 // patch: { name, visibility, expiresAt, folderId, downloads }
deleteFile(id) -> boolean
incrementDownloads(id) -> void

// ---- 文件夹 ----
listFolders() -> folder[]
getFolder(id) -> folder | null
createFolder(folder) -> folder
updateFolder(id, patch) -> folder | null             // patch: { name, parentId }
deleteFolder(id) -> boolean
// deleteFolder 的判空规则（与现状 handleDeleteFolder 一致）：文件夹里有文件 或 有子文件夹时都拒绝删除，
// 返回 false（由路由层转 400“文件夹里还有文件/子文件夹，先移走或删掉”）；只有空文件夹才能删。

// ---- 分享 ----
getShareByToken(token) -> share | null
getShareByFileId(fileId) -> share | null
getShareByFolderId(folderId) -> share | null
createShare(share) -> share
updateShare(token, patch) -> share | null            // patch: { code, burn }
deleteShare(token) -> boolean

// ---- 会话 ----
getSession(token) -> session | null                  // 含 expiresAt 校验
createSession(token, expiresAt) -> void
deleteSession(token) -> void
deleteExpiredSessions(now) -> void

// ---- 公告 ----
getAnnouncement() -> string
setAnnouncement(text) -> void

// ---- 登录防爆破（替代现在的内存 failMap）----
recordFailure(ip, at) -> void
countFailuresSince(ip, since) -> number
clearFailures(ip) -> void

// ---- 分片上传会话（CF 版用 D1 存，VPS 版对应 data/chunks/<uploadId>/meta.json）----
getChunkUpload(uploadId) -> chunkUpload | null
createChunkUpload(u) -> void
updateChunkUpload(uploadId, patch) -> void           // patch: { received: number[] }
deleteChunkUpload(uploadId) -> void
listStaleChunkUploads(before) -> chunkUpload[]       // createdAt 早于 before 的（24h TTL 清理用）
```

**file 对象（两端同一形状）**：`{ id, name, size, ext, kind, storage: 'local'|'r2', storageKey, folderId, visibility, expiresAt, downloads, uploadedAt }`
**folder 对象**：`{ id, name, parentId, createdAt }`
**share 对象**：`{ token, fileId, folderId, code, burn, createdAt }`

### 3.2 StorageStore（文件 Blob 层）

```js
put(key, body, contentType) -> void                  // 小文件 / 缩略图 / VPS 分片拼装后上传
get(key) -> Response                                 // 下载：本地返回文件流；R2 返回 GetObject 或 302 预签名
head(key) -> { size } | null                         // upload-complete 的 HeadObject 校验
delete(key) -> void
copy(srcKey, dstKey) -> void                         // R2 改名 = CopyObject + DeleteObject；本地 = fs.rename
presignedPutUrl(key, contentType, expiresIn) -> string   // 浏览器直传 R2
presignedGetUrl(key, expiresIn) -> string                // 下载 302 跳转
// 大文件分片（R2 multipart；VPS 本地走现有磁盘拼装，不用这组方法）
createMultipartUpload(key, contentType) -> uploadId
presignedPartUrl(uploadId, key, partNumber, expiresIn) -> string
completeMultipartUpload(uploadId, key, parts) -> void
abortMultipartUpload(uploadId, key) -> void
```

**storageKey 格式**：新文件统一用 `YYYY/MM/<id>_<name>`（如 `2026/11/mwtdgu8t277756_村花.mp4`）；
**已存在的文件保持原 key 不变**（key 存在元数据的 `storageKey` 字段里，新老格式共存，无需迁移旧文件）。
**R2 的实现**：VPS 与 CF 共用同一份“R2 语义”，只是驱动不同——VPS 用 `@aws-sdk/client-s3`（需要 endpoint + key/secret），
CF 用 R2 Binding（`env.R2`，免密钥、免 SDK）。为此 `R2Storage` 接受一个最小驱动接口
`{ put, get, head, delete, copy, signPut, signGet, createMultipart, signPart, completeMultipart, abortMultipart }`，
Node 侧用 SDK 实现它，CF 侧用 Binding 实现它，核心逻辑只写一份。

**CF 端预签名（重要）：Workers 原生的 `env.R2` Binding 不支持生成 S3 Presigned URL。**
因此 `adapters/cf/r2-storage.js` 里，`signPut / signGet / signPart` 明确用 **`aws4fetch`**（纯 Web Crypto 的
AWS Signature V4 签名库，无 Node 依赖，可在 Workers 里跑）配合 R2 的 S3 API 密钥来签发；其余读写（put / get /
head / delete / copy / multipart）走 `env.R2` Binding。这意味着 CF 部署除了 R2 绑定外，还需要把
`R2_ACCESS_KEY_ID` 与 `R2_SECRET_ACCESS_KEY` 配成 Worker secrets（`wrangler secret put`），仅用于签发预签名链接。

**用量统计**：不由 StorageStore 提供。`r2Used` / `localUsed` 继续由元数据求和（现状如此，两端一致）。

### 3.3 JsonMetaStore 的竞态修复（VPS）

- 现状：JSON 文件是“读 → 改 → 写”三步，并发请求（并行上传、分片回调）可能互相覆盖。
- 修复：`JsonMetaStore` 内部加一个**内存串行写队列**（Promise 链，所有写操作排队执行），零新依赖。
- 备选（不推荐为默认）：`better-sqlite3`（原生模块，需编译，VPS 部署要装 build 工具）或 `sql.js`（纯 JS/WASM，
  与 D1 的 SQL 逻辑最接近，但体积和性能不如 JSON）。先上写队列；只有当 JSON 成为瓶颈时再考虑 SQLite。

## 4. 大文件上传链路（CF Workers 请求体限制）

**痛点**：Workers 单次请求体上限——免费版 100MB、付费版 500MB。文件直 POST 给 Worker 一定会在大文件时崩溃。
VPS 则无此问题（Node 流式写本地或中转 R2）。

**统一方案：预签名直传（已在 v1.5 验证过的模式，推广为两端统一链路）**

| 文件大小 | VPS（local） | VPS（R2）与 CF（R2） |
|---|---|---|
| ≤ 32MB（`CHUNK_UPLOAD_THRESHOLD`） | multipart POST 到服务端，流式写盘 | `POST /api/upload-url` 取预签名 PUT → 浏览器直传 R2 → `POST /api/upload-complete`（HeadObject 校验大小后写元数据） |
| > 32MB（分片） | 现状保持：`POST /api/upload/chunk`（5MB/片）→ 磁盘拼装 → 本地改名或单次 PutObject 到 R2 | **R2 multipart 直传**：`POST /api/upload/chunk` 在 CF 实现里改为“创建 multipart + 返回 presigned part URL”，浏览器逐片直传 R2，`POST /api/upload/chunk-complete` 由 Worker 调 `completeMultipartUpload` 收尾 |

**关键点**：
- 前端 `uploadChunked()` **不用改**：它现在就是按 5MB 一片调 `/api/upload/chunk`、最后调 `/api/upload/chunk-complete`；
  CF 版只换这两个端点的服务端实现（磁盘拼装 → R2 multipart），分片字节不经过 Worker（每片 5MB 也远小于 100MB 上限，
  即使经 Worker 中转也不会超，但直传更省）。
- 单文件上限保持 5GB（CF 默认 `MAX_UPLOAD_SIZE`；R2 单次 PUT 上限也是 5GB，multipart 可更大，但为与 VPS 本地路径一致，CF 版统一卡 5GB；VPS 版默认 10GB）。
- 注意 R2 免费额度只有 10GB 总量：一个 5GB 文件就占一半，README 里要写明这一点。

## 5. D1 表结构（schema.sql）

```sql
-- 文件（storageKey 存物理键，新老格式共存；文件夹关系只在元数据层）
CREATE TABLE files (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  ext         TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'file',        -- image | video | audio | archive | file
  storage     TEXT NOT NULL DEFAULT 'r2',          -- 'local' | 'r2'（CF 版只有 'r2'）
  storage_key TEXT NOT NULL,                       -- 如 2026/11/<id>_<name>
  folder_id   TEXT,                                -- NULL = 根目录
  visibility  TEXT NOT NULL DEFAULT 'public',      -- 'public' | 'private'
  expires_at  INTEGER,                             -- 毫秒时间戳，NULL = 永久
  downloads   INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_uploaded ON files(uploaded_at);

-- 文件夹（parentId 维护逻辑树）
CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT,                                 -- NULL = 根目录
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_folders_parent ON folders(parent_id);

-- 分享（file_id 与 folder_id 二选一）
CREATE TABLE shares (
  token      TEXT PRIMARY KEY,
  file_id    TEXT,
  folder_id  TEXT,
  code       TEXT NOT NULL DEFAULT '',             -- 提取码，空 = 无
  burn       INTEGER NOT NULL DEFAULT 0,           -- 0/1，阅后即焚
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_shares_file ON shares(file_id);
CREATE INDEX idx_shares_folder ON shares(folder_id);

-- 管理员会话（替代 sessions.json）
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- 公告（单行表）
CREATE TABLE announcement (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL DEFAULT ''
);

-- 登录防爆破（替代内存 failMap；定期清理）
CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_attempts_ip_at ON login_attempts(ip, at);

-- 分片上传会话（CF 版用 D1 存；VPS 版对应 data/chunks/<uploadId>/meta.json）
CREATE TABLE chunk_uploads (
  upload_id   TEXT PRIMARY KEY,                    -- 前端用的 uploadId（与 VPS 的 chunk 目录名同一值）
  r2_upload_id TEXT,                               -- R2 Multipart 的 uploadId（CF 版必填，VPS 版为空）
  storage_key TEXT,                                -- 最终对象键，如 2026/11/<id>_<name>
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  total       INTEGER NOT NULL,                    -- 总片数
  received    TEXT NOT NULL DEFAULT '[]',          -- 已收片 JSON 数组 [{ partNumber, etag }]（合并分片必需）
  storage     TEXT NOT NULL DEFAULT 'r2',          -- 'local' | 'r2'
  folder_id   TEXT,                                -- 目标文件夹，NULL = 根目录
  visibility  TEXT NOT NULL DEFAULT 'public',
  expires_hours INTEGER NOT NULL DEFAULT 0,        -- 0 = 永久
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_chunks_created ON chunk_uploads(created_at);

-- 注：CF 端浏览器直传分片时，浏览器要从响应头里读每片的 ETag 回传给服务端做合并，
-- R2 桶的 CORS 必须配好 ExposeHeaders: ["ETag"]（现状 file-share 桶已有此配置，新部署照抄）。
```

**说明**：
- 不用外键：D1 默认不强制外键，引用完整性由应用层保证（与现状 JSON 的做法一致）。
- `expires_at` / `uploaded_at` / `created_at` / `at` 统一存毫秒时间戳，前后端都按现状的毫秒约定走。
- `kind` 的取值与现状 `kindOf()` 的分类一致（image / video / audio / archive / file）。
- D1 免费额度（5GB 存储、每天 500 万行读 / 10 万行写）对个人站绰绰有余；真正的大头是 R2 的 10GB。

### 5.1 有效期与权限规则（已逐项核对现状代码）

**分享有效期——分享本身没有独立的有效期字段**（现状 `shares.json` 只有 `{ token, fileId/folderId, code, burn, createdAt }`，
`schema.sql` 的 shares 表同样不设 `expires_at`）。分享是否有效由三条规则共同决定：

1. 分享存在（未被删除、未被阅后即焚烧掉）；
2. 指向的文件存在且未过期——文件的 `expires_at` 才是真正的有效期；
3. 提取码匹配（若设置了 `code`）。

**过期清理（对应现状 `cleanupExpired`，启动时 + 每 5 分钟跑一次）**：
- 删掉已过期的文件：R2 的删对象、本地的删磁盘文件、缩略图一起删；
- 从 `files` 表删掉这些文件；
- **指向这些文件的文件分享一并删掉**（`DELETE FROM shares WHERE file_id IN (...)`）；
- **文件夹分享不受单个文件过期影响**——文件夹分享没有 `file_id`，过期文件只是从分享目录里消失，分享本身继续有效。
- 分片会话超过 24h 未完成：VPS 删 `data/chunks/<uploadId>/` 目录，CF 调 `abortMultipartUpload` 并删 `chunk_uploads` 行。
- 过期的登录防爆破记录与会话（sessions 表 `expires_at < now`）顺手清理。

**访问权限（字段与规则）**：
- `files.visibility`：`public`（所有人可见）/ `private`（仅管理员 + 持分享链接者可见）。
- `shares.code`：提取码，空串 = 无；同时 gate 分享页和下载（v2.8.0 已堵住只带 token 绕过 code 的口子）。
- `shares.burn`：阅后即焚，下载成功交付后删除分享（只在交付点烧，预览和信息查询不烧）。
- **文件夹分享是明确授权**：分享目录里的文件不论公开/私密，持链接的人全部可见（现状 `handleShareInfo` 的规则，core 里原样保留）。
- 分享页的子目录浏览必须在被分享的目录树内（根或其子孙），越界返回 404。

## 6. API 契约（冻结，前端零改动）

以下端点**方法、路径、鉴权、返回形状全部不变**（v2.8.4 现状）。重构只换服务端实现。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/`、`/s/*` | 公开 | 单页应用 |
| GET | `/qrcode.min.js`、`/jszip.min.js` | 公开 | 前端依赖 |
| POST | `/api/login` | 密码 | 管理员登录（防爆破计数） |
| POST | `/api/logout` | 会话 | 登出 |
| GET | `/api/me` | 公开 | 登录态 |
| GET | `/api/announcement` | 公开 | 读公告 |
| POST | `/api/announcement` | 管理员 | 写公告（空 = 清除，≤200 字） |
| GET | `/api/files?folderId=` | 公开 | 列表（含 path、quota、r2 开关） |
| GET | `/api/search?q=` | 公开 | 全局搜索 |
| POST | `/api/upload` | 管理员或匿名密码 | 本地小文件 multipart 上传（VPS 专属） |
| POST | `/api/upload-url` | 管理员或匿名密码 | 取 R2 预签名 PUT |
| POST | `/api/upload-complete` | 管理员或匿名密码 | R2 上传完成校验 + 写元数据 |
| POST | `/api/upload/chunk` | 管理员或匿名密码 | 分片上传一片 |
| GET | `/api/upload/chunk-status?uploadId=` | 管理员或匿名密码 | 查已收分片（断点续传） |
| POST | `/api/upload/chunk-complete` | 管理员或匿名密码 | 拼装/完成分片 |
| GET | `/f/:id` | 公开/分享 token | 下载（R2 302 预签名，本地直接流） |
| POST | `/api/files/:id/move` | 管理员 | 移动文件 |
| POST | `/api/files/:id/rename` | 管理员 | 改名 |
| POST | `/api/files/:id/visibility` | 管理员 | 公开/私密 |
| POST | `/api/files/:id/expiry` | 管理员 | 改有效期 |
| DELETE | `/api/files/:id` | 管理员 | 删除 |
| GET/POST/DELETE | `/api/files/:id/share` | 管理员（GET 查） | 文件分享链接管理 |
| GET | `/api/folders` | 公开 | 全部文件夹 |
| POST | `/api/folders` | 管理员 | 新建文件夹 |
| DELETE | `/api/folders/:id` | 管理员 | 删空文件夹 |
| POST | `/api/folders/:id/rename` | 管理员 | 文件夹改名 |
| POST | `/api/folders/:id/move` | 管理员 | 移动文件夹（防循环） |
| GET/POST/DELETE | `/api/folders/:id/share` | 管理员（GET 查） | 文件夹分享链接管理 |
| GET | `/api/share/:token` | 公开/提取码 | 分享页数据（含 needCode） |
| POST | `/api/thumbs/:id` | 管理员或匿名密码 | 上传缩略图 |
| GET | `/thumb/:id` | 公开 | 读缩略图 |
| POST | `/api/deploy` | 管理员 | 强制拉取部署（VPS 专属，CF 版不需要） |

**注意**：`POST /api/upload`（本地 multipart）与 `POST /api/deploy` 是 VPS 专属端点，CF 版返回 501 或不注册；
其余端点两端行为一致。缩略图在 CF 版存 R2（key 前缀 `thumbs/`），与文件同一桶。

## 7. 部署方案

### VPS（一键部署，Docker Compose）——与 CF 版并行运行，扛超大文件 + 利用本地硬盘

```yaml
services:
  fileshare:
    build: .
    ports: ["80:80"]
    volumes:
      - ./data:/app/data
      - ./files:/app/files
      - ./thumbs:/app/thumbs
    environment:
      - UPLOAD_PASSWORD=${UPLOAD_PASSWORD}
      - MAX_UPLOAD_SIZE=10737418240   # VPS 默认 10GB
      # R2 可选：R2_BUCKET / R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
```

- 保留现有 systemd + git 定时拉取部署作为备选（线上站目前就是这套）。
- `config.json` 仍由环境变量或挂载文件提供，不进仓库。
- **VPS 版保留本地硬盘 + R2 双存储池**（已确认的核心卖点）；VPS 实例用独立域名（如 `vps.19660716.xyz`），
  与 CF 主站分开跑。
- **注意**：两端是各自独立的部署、各自的数据，**不是实时同步**。v3.0 的目标是“一套代码两端可部署”，
  双向实时同步是另一个功能，不在本轮范围里（后续可单独做）。

### Cloudflare（单命令全栈部署）——主站

- `wrangler.toml`：Workers + Static Assets（托管 `public/`，前端与 API 同域、零跨域）+
  R2 绑定 + D1 绑定 + Cron Trigger（每 5 分钟跑过期清理与分片清理，对应现在的 `setInterval`）。
- `wrangler deploy` 一条命令完成部署；另配一个 Deploy to Cloudflare 按钮（README 里放）。
- 密钥（管理员密码、R2 相关）走 `wrangler secret put`，不进仓库。
- `MAX_UPLOAD_SIZE` 默认 5GB（环境变量可配）。

### 数据迁移（一次性脚本 `migrate.js`）

- 读 VPS 的 `data/*.json` + `files/`，写入 D1（按 §5 的表）并把本地文件上传到 R2（key 按新格式生成，元数据里的 `storageKey` 同步更新）。
- 分享 token、文件夹结构、下载数、有效期全部保留；跑完后逐项核对（文件数、分享数、下载数）再切流量。

## 8. 分阶段实施计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **Phase 0** | 基线：给 v2.8.4 打 tag；新分支 `refactor/hono-dual`（或新仓库）；冻结新功能 | 线上站不动 |
| **Phase 0 状态（2026-11-24）** | 基线已定：v2.8.4，提交 `a6444f2`；RelayBox 骨架已搭好并推到公开仓库 `HueGild/relaybox`（初始提交 `1826706`，package.json 版本 v0.1.0）；**注意：这只是 main 上的初始代码，不作正式版——没打 tag、没发 GitHub Release**，等 Jay 说可以再发正式版；下一步进 Phase 1（core + Hono + Node 适配器） | — |
| **Phase 1** | 抽 `MetaStore` / `StorageStore` 契约；core 路由迁到 Hono；先实现 Node 适配器（JsonMetaStore + Local/R2 Storage） | VPS 版跑通全部 jsdom 回归（v282/v283/v283-fixes/v284）+ 真实服务器接口测试，与 v2.8.4 行为一致 |
| **Phase 1 状态（2026-11-24 12:48）** | 已完成并推送（提交 `53e42729`）：JsonMetaStore（串行写队列）+ LocalStorage + R2Storage + 8 个 Hono 路由模块（~35 端点）+ entry-node.js（MAX_UPLOAD_SIZE 默认 10GB）；API 对照 144/144、jsdom 4/4、index.html 哈希与 v2.8.4 一致（零改动）；同日已同步到 Google Drive RelayBox 文件夹（另一 AI 的 index-v3-ui.html 与 AGENTS.md 原样保留）。下一阶段 Phase 2（CF 适配器 + Worker 入口）。 | — |
| **Phase 2** | 实现 CF 适配器（D1MetaStore + R2 Binding Storage）；`entry-worker.js` + `wrangler.toml`；部署到测试子域名 | 同一套测试在 CF 测试站上全过；大文件（>32MB 分片、>100MB 直传）实测通过 |
| **Phase 2 状态（2026-11-24 15:06，已部署到测试子域名并通过真实环境测试）** | 代码已完成并推送（提交 `baf93598`）；已部署到 **https://relaybox.imgbed-061.workers.dev**（Version ID 1fd061b4-5bd2-42be-9c0d-84d10820b792，Cron `*/5 * * * *` 每 5 分钟过期清理，绑定 D1 relaybox `883a23d5-8649-46a2-856d-7a5a200c1e1d` + R2 relaybox，MAX_UPLOAD_SIZE 5GB，静态资源 3 个文件）。D1 库与 7 张表、R2 桶均已建；4 个 Worker Secrets 全部设好（经 stdin，未写文件）。真实环境实测：**CF API 对照 158/158**、**真实 R2 字节验证 12/12**（分片上传→预签名 GET 920 字节逐字节一致、Range bytes=0-9 回 206、预签名 PUT 直传→upload-complete→下载 37 字节逐字节一致）、**jsdom 4/4**、**index.html sha256 与 v2.8.4 一致（`8cfd84e9…`，零改动）**。3 个边界坑真实环境全部验证通过：① 分片 index+1（105MB/21 片合并成功，110100480 字节）、② /f/:id 302 预签名 GET（Range 206 由 R2 边缘返回）、③ /s/:token 返回 index.html（200）。部署中修掉 2 个问题：① `d1 execute` 默认是本地库，操作远程库必须加 `--remote`（否则远程 D1 无表，全部接口 500）；② test-api-cf.js 硬编码 PW 改成 `process.env.CF_TEST_PW || 'testpass123'`（改动留本地未推送）。测试站已清干净（D1 files 表 0 行，R2 桶 0 对象）。`storageKey` 仍用平铺 `${id}_${name}`（`YYYY/MM/` 格式延后，与 Phase 1 一致）。**Phase 2 已收口，Jay 现在可以销毁 API Token**（后续云盘同步与 v3 前端合入不需要 Token；若以后重部署需重新建 Token）。下一步：同步到 Google Drive RelayBox 文件夹，然后拉 Drive 上新版 index-v3-ui.html 替换合入（v3 前端改版），再进 Phase 3。 | — |
| **Phase 3** | `migrate.js`；线上数据迁移演练（先在测试环境跑）；**CF 版接管主域名 `wp.19660716.xyz`**，VPS 版切到独立域名并行运行 | 迁移后文件/分享/下载数与线上一致；主站切到 CF 后全功能正常；VPS 版独立域名可访问，数据完整 |
| **Phase 4** | 开源包装：新干净公开仓库（RelayBox）、README（双端部署教程）、MIT LICENSE、Docker Compose、Deploy to Cloudflare 按钮 | 从零按 README 走一遍，两端都能跑起来 |

**风险控制**：Phase 1 完成前线上站保持 v2.8.4 原样；Phase 2 的 CF 站用独立子域名测试，不动 `wp.19660716.xyz`；
任何一步测不过就停在原地，不强行切。

## 9. 决策记录（已全部确认，2026-11-24）

1. **项目名**：**RelayBox**（备选 DualDrive 未采用：易与 SanDisk 双接口 U 盘撞名，且“Drive”偏网盘，Relay 更贴合中转传输）。
2. **协议**：**MIT**。
3. **仓库**：**新建干净公开仓库**（不公开现有私有仓库的历史）。
4. **线上站运行策略**：**CF 版为主站**，**VPS 版保留并行**（扛超大文件、利用本地硬盘），迁移期间线上站零中断。
5. **上传上限**：环境变量 `MAX_UPLOAD_SIZE`，CF 默认 5GB，VPS 默认 10GB。
6. **VPS 本地存储**：**必须保留本地硬盘 + R2 双存储池**（VPS 版核心卖点）。
