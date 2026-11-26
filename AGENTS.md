# RelayBox · Google Drive 协作工作区规范（AGENTS.md）

本文件夹是 **RelayBox**（Cloudflare Workers + D1 + R2 文件传输站）在 Google Drive 中的**多 Agent 协作共享工作区**，用于在多个 AI 助手与协作者之间同步源码、方案文档与阶段性产物。

> **GitHub 公开仓库**：`https://github.com/HueGild/relaybox`（MIT License）  
> **线上主站**：Cloudflare Workers + R2 + D1 + Static Assets。  
> **自 v3.4.0（2026-11-25）起项目为纯 Cloudflare 架构**，VPS（Node.js）适配层已移除，不再要求适配 VPS/Node；开发可直接利用 D1 原生 SQL 与 CF 边缘能力。最后一个完整双端版封存为 Git Tag `v3.3.11-dual-final` / 分支 `archive/dual-v3.3.11`，源码包 `RelayBox-v3.3.11-dual-final-backup.zip` 在本文件夹 `archives/` 下。

---

## 1. 目录结构与文件说明

```text
RelayBox/
├── AGENTS.md                  # 本文件：多 Agent 协作与读写规范
├── README.md                  # 项目开源说明与纯 CF 部署指南
├── wrangler.toml              # Cloudflare Workers + Static Assets + R2/D1 + Cron 配置
├── package.json               # 依赖声明（hono、aws4fetch、wrangler；无 VPS 依赖）
├── public/
│   └── index.html             # 前端单页（当前 UI r33，v3.8.0）
└── src/
    ├── core/                  # 纯 Web 标准 API 编写的 Hono 路由与业务逻辑（严禁引入 Node 依赖）
    ├── adapters/
    │   └── cf/                # CF 适配层：D1MetaStore + R2 Binding（预签名使用 aws4fetch）
    ├── entry-worker.js        # CF 入口（fetch + scheduled 定时清理）
    ├── schema.sql             # D1 完整基线（新部署直接建库，已含迁移 001-006 全部内容）
    └── migrations/            # D1 增量迁移（仅用于已有数据库升级）
```

*(注：原始双端架构蓝图与四阶段计划见仓库内 `REFACTOR-PLAN.md`（历史文档，VPS 部分已于 v3.4.0 移除）。)*

---

## 2. 核心架构红线（所有 Agent 必须遵守）

1. **运行时严格隔离**：`src/core/` 下禁止出现 `node:`、`fs`、`path`、Node 版 `crypto`、`__dirname`、`process.env`。随机 ID 与签名统一使用 Web Crypto API。
2. **API 契约冻结**：所有 `/api/*`、`/f/:id`、`/s/:token`、`/thumb/:id` 的路径、方法、鉴权与返回结构保持与 v3.3.11 一致，确保前端零改动即可升级。
3. **CF 端 R2 预签名方案**：Workers 原生 `env.R2` Binding 不支持签发预签名 URL，预签名（`signPut` / `signGet` / `signPart`）统一使用 `aws4fetch` 配合 Worker Secrets；普通读写与分片合并走 `env.R2`。
4. **分片与上限配置**：
   - 上传上限由环境变量 `MAX_UPLOAD_SIZE` 控制（CF 默认 5GB）。
   - 分片直传 R2 时，桶 CORS 必须暴露 `ETag` 响应头，`chunk_uploads` 记录 `r2_upload_id`、`storage_key` 与 `[{ partNumber, etag }]`。
5. **纯 CF 架构**：不再维护 VPS/Node 适配层（`src/adapters/node/`、`src/entry-node.js`、`docker-compose.yml` 已于 v3.4.0 删除）。存储统一走 R2 Binding 与 S3 兼容池（aws4fetch）；元数据统一走 D1（可直接写原生 SQL），不再保留 JSON 文件元数据路径。

---

## 3. 多 Agent 协作规范

### 3.1 读写与版本保护
- **先读后改**：任何 Agent 在修改代码或出方案前，先读取本文件、最新重构方案及对应目标源码，不要凭记忆假设旧版本实现。
- **不直接覆盖基线**：在回归测试完成前，**不要覆盖 `public/index.html`**。前端改版、实验性模块或草稿一律使用带后缀的独立文件名暂存（例如 `public/index-v3-ui.html`、`src/xxx.draft.js`），验收通过后再统一替换。
- **明确标注变更**：新上传或更新的文件，请在顶部注释中写明版本号/日期/核心改动，方便其他 Agent 快速识别最新状态。

### 3.2 同步时机
- 无需每次微小改动都同步；在**关键里程碑节点**（如前端大版本定稿、后端重大重构）同步一次完整源码即可。
- Git 仓库（`HueGild/relaybox`）为代码唯一真理来源（Single Source of Truth），本云盘目录用于跨 Agent 审阅、前端并行开发与文档归档。

### 3.3 严格安全黑名单（严禁上传）
以下文件或目录**绝对禁止**同步到本云盘文件夹：
- **敏感密钥与配置**：`config.json`、`.env`、`.dev.vars`、任何包含 `UPLOAD_PASSWORD` / `R2_SECRET_ACCESS_KEY` / API Token 的文件。
- **用户隐私与测试数据**：`data/`、`files/`、`thumbs/` 目录下的真实文件或元数据。
- **冗余构建与依赖**：`node_modules/`、`.git/`、`.wrangler/`、构建缓存与日志。

---

## 4. 交接清单（Agent 完成任务后自查）

- [ ] 是否未泄露任何密钥、真实域名隐私配置或本地测试数据？
- [ ] 修改 `src/core/` 时是否保证了零 Node 原生依赖？
- [ ] 修改前端时是否保持了与现有 API 契约的 100% 兼容？
- [ ] 是否在回复中明确告知了文件存放路径、改动摘要及下一步建议？
