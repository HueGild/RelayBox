<div align="center">

# <img src="public/logo.png" width="32" height="32" align="center"> RelayBox

**一个人人都能零成本一键部署的 Cloudflare 个人网盘与文件传输站**

[![GitHub Stars](https://img.shields.io/github/stars/HueGild/relaybox?style=flat-square&logo=github)](https://github.com/HueGild/relaybox/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/HueGild/relaybox?style=flat-square&logo=github)](https://github.com/HueGild/relaybox/network/members)
[![License](https://img.shields.io/github/license/HueGild/relaybox?style=flat-square)](https://github.com/HueGild/relaybox/blob/main/LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20R2-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

**简体中文** | [English](README_EN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HueGild/relaybox)

</div>

> 无需服务器、无需 NAS、无需手写配置文件——基于 **Cloudflare Workers + D1 + R2 + Static Assets** 纯 Serverless 架构，免费额度即可拥有 10 GB 起步的云端文件传输站，支持子账号与临时测试号、外链分享、反向文件收集箱、GitHub Release 自动追更、WebDAV 网盘与多存储池管理。

---

## 目录

- [核心功能](#核心功能)
- [一键部署到 Cloudflare（推荐）](#一键部署到-cloudflare推荐)
- [手动 CLI 部署](#手动-cli-部署)
- [使用指南](#使用指南)
  - [子账号与临时测试号](#子账号与临时测试号)
  - [文件分享与 5 位取件码](#文件分享与-5-位取件码)
  - [访客文件收集箱](#访客文件收集箱)
  - [GitHub Release 拉取与自动追更](#github-release-拉取与自动追更)
  - [极客 API 上传（curl）](#极客-api-上传curl)
  - [WebDAV 挂载](#webdav-挂载)
- [环境变量与密钥列表](#环境变量与密钥列表)
- [项目结构](#项目结构)
- [常见问题与注意事项](#常见问题与注意事项)
- [测试与开发](#测试与开发)

---

## 核心功能

### 1. 多存储池与双传输模式
- **零门槛内置 R2 中转模式**：开箱即用，无需配置任何 S3 API 密钥或桶 CORS，校园网/弱网环境也能稳定上传与外链访问。
- **大文件预签名直传模式**：支持单文件最高 **5 GB**（可通过 `MAX_UPLOAD_SIZE` 调整）分片直传与断点续传，流量不经过 Worker。
- **动态外部 S3 / R2 存储池**：后台网页随时挂载任意外部 Cloudflare R2、Backblaze B2、MinIO 等 S3 兼容桶（密钥 AES-GCM 加密存库），支持配置自定义 `publicDomain` 公开域名 302 预览直出，以及单文件/整池流式跨池迁移。

### 2. 子账号与临时测试号（v3.8.0）
- **常规子账号 & 限时限额测试号**：内置「常规子账号」「24h 读写测试号」「7天只读体验号」三套一键预设模板，支持自动创建专属根目录、独立空间配额与上传/删除/分享细粒度权限位。
- **严格目录子树沙盒**：子账号强制锁死在绑定的 `rootFolderId` 子树内（含列表、搜索、下载、上传、改名、删除与分享），屏蔽全部系统管理后台，密码采用纯 Web Crypto PBKDF2-SHA256 加密存储。
- **安全与生命周期管控**：创建/重置密码后提供一键复制凭据框（120 秒自动隐藏防泄露）；支持一键踢下线、禁用/改密自动撤销旧会话，定时任务自动清理已过期账号会话，所有操作写入审计日志。

### 3. 分享、取件与反向收集
- **文件 & 文件夹分享**：支持自定义提取码、独立分享有效期、下载限次、阅后即焚与 **5 位短取件码**；分享文件夹支持浏览器端一键打包下载（ZIP）。
- **全站分享管理中心**：一屏查看全站所有活跃/已耗尽/已过期外链与取件码，支持按状态筛选、搜索、复制文案、修改提取码或一键吊销。
- **反向文件收集箱（`/d/:token`）**：生成只写不读的收件链接，访客免登录即可提交作业/素材到指定目录，提交者之间互不可见。

### 4. GitHub Release 自动追更与运维看板
- **GitHub 软件拉取与追更（v3.7.0）**：支持输入 `owner/repo` 手动拉取 Release 附件或订阅定时自动追更（支持通配符过滤、无 Token 网页解析兜底、新版自动将旧版移入回收站）。
- **统计看板与安全审计（v3.6.0）**：D1 原生聚合存储分布、Top 10 热门下载与 7 天上传趋势；内置 30 天滚动安全审计日志，记录登录、子账号操作、密钥变更与回收站清理。
- **快捷命令面板与文件整理**：支持 `Ctrl+K` 全局命令面板、文件置顶与备注、上传前全目录智能判重（支持 SHA-256 校验）。

### 5. 现代前端体验与协议生态
- **单文件 SPA + PWA**：支持全屏拖拽/文件夹上传/剪贴板粘贴、客户端 Canvas 图片压缩转 WebP、视频首帧缩略图自动截取与重截、URL 目录路由同步（`/?folder=<id>`）与手机端侧滑返回。
- **在线预览与编辑**：支持图片缩放旋转、视频倍速播放、音频、PDF、**Markdown 渲染预览（含源码切换）**、带行号代码预览、在线文本编辑（≤ 1 MB）与文字/代码快传（Pastebin）。
- **防 SSRF 远程拉取 & 7 天回收站**：支持远程 URL 转存（≤ 50 MB）；软删除文件保留 7 天随时一键还原，Cron 定时清理过期文件、残余分片与过期会话。
- **WebDAV、API Token 与 Telegram 推送**：支持 `/dav/*` 标准 WebDAV 挂载、`/api/raw-upload` 命令行上传、Telegram 实时告警与每日存储用量汇总，以及桌面/手机端独立壁纸与自定义站点外观。

---

## 一键部署到 Cloudflare（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HueGild/relaybox)

### 前置条件
1. 拥有一个 GitHub 账号与 Cloudflare 账号。
2. 在 Cloudflare 控制台提前**开通 R2 服务**（每月提供 **10 GB 免费存储 + 100 万次 A 类/1000 万次 B 类免费操作**；开通需绑定信用卡或 PayPal，免费额度内不扣费）。

### 部署步骤
1. 点击上方 **Deploy to Cloudflare** 按钮，授权克隆本仓库到你的 GitHub 账号。
2. Cloudflare 会自动为你创建全新的 **D1 数据库** 与 **R2 存储桶**，自动回填 `database_id`，执行 `migrations/` 下的建表迁移并部署上线。
3. 部署完成后，进入 Cloudflare 控制台：**Workers & Pages → 你的 Worker → Settings → Variables and Secrets**，新增一条加密变量（Secret）：
   - 名称：`UPLOAD_PASSWORD`
   - 值：你自定义的管理员登录密码
4. 保存后访问你的 Worker 域名（或绑定自定义域名），点击右上角登录（管理员账号留空，直接输密码）即可开始使用！

> **提示**：仅配置 `UPLOAD_PASSWORD` 后，内置 R2 的**中转模式**即可 100% 正常工作；如需开启百 MB~GB 级大文件**预签名直传模式**，再按下方环境变量表补填 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ACCOUNT_ID` 并配置桶 CORS 暴露 `ETag` 头即可。

---

## 手动 CLI 部署

```sh
# 1. 克隆仓库并安装依赖
git clone https://github.com/HueGild/relaybox.git
cd relaybox
npm install

# 2. 创建 D1 数据库（将返回的 database_id 填入 wrangler.toml）与 R2 存储桶
npx wrangler d1 create relaybox
npx wrangler r2 bucket create relaybox

# 3. 设置管理员密码（必填）
npx wrangler secret put UPLOAD_PASSWORD

# 4. （可选）如需预签名直传大文件，补设以下 3 个 R2 S3 密钥
# npx wrangler secret put R2_ACCESS_KEY_ID
# npx wrangler secret put R2_SECRET_ACCESS_KEY
# npx wrangler secret put R2_ACCOUNT_ID

# 5. 自动执行 D1 全部迁移并部署
npm run deploy
```

也可以在 Cloudflare Workers 中直接连接你的 GitHub 仓库（生产分支 `main`，部署命令填 `npm run deploy`），之后每次 push 都会自动迁移并部署。

---

## 使用指南

### 子账号与临时测试号
- 主管理员点击顶栏（手机端侧边抽屉）的 **子账号与测试号 → + 新建账号**，可一键选用「常规子账号」「24h 读写测试号」「7天只读体验号」模板，或自定义绑定目录、空间配额与权限位。
- 创建或重置密码后可直接点击 **一键复制凭据** 发给对方（凭据框 120 秒后自动隐藏）；子账号在登录框填写用户名和密码即可进入专属沙盒空间。

### 文件分享与 5 位取件码
- 点击文件/文件夹菜单中的「分享设置」，可配置**提取码**、**独立有效期**、**最大下载次数**（设为 `1` 即阅后即焚），系统同时自动分配唯一 **5 位短取件码**。
- 访客可在首页顶部输入框直接输入 5 位取件码直达分享页，也可直接打开 `/s/<token>` 链接。

### 访客文件收集箱
- 管理员在顶栏（手机端侧边抽屉）打开 **文件收集箱 → + 新建收集箱**，设置标题、存入目录、可选口令、最大份数与有效期。
- 将生成的 `/d/<token>` 链接发给他人，对方无需登录即可上传文件，且无法查看他人已提交的文件。

### GitHub Release 拉取与自动追更
- 管理员打开 **GitHub 软件拉取**，输入 `owner/repo`（如 `owner/app`）即可解析最新 Release 附件并拉取到指定目录和存储池；切换到「自动追更」可添加定时订阅，由 Worker Cron 自动检测新版并拉取。
- 匿名模式支持无 Token 网页解析兜底；如需更高频率或拉取私有仓库，可在弹窗顶部配置只读 GitHub Token（AES-GCM 加密存库）。

### 极客 API 上传（curl）
在后台 **API 密钥管理** 生成 `rbx_...` 密钥后，即可在终端或脚本中一键传文件：

```sh
curl -X POST "https://你的域名/api/raw-upload?filename=test.png&visibility=public" \
  -H "Authorization: Bearer rbx_你的密钥" \
  --data-binary @./test.png
```

### WebDAV 挂载
- **服务器地址**：`https://你的域名/dav`
- **用户名**：`admin`
- **密码**：在后台生成的「全功能（all）」API 密钥（推荐）或管理员密码
- 兼容 Finder、RaiDrive、Infuse、VidHub、ES 文件浏览器等标准 WebDAV 客户端。

---

## 环境变量与密钥列表

| 变量名 | 类型 | 是否必填 | 默认值 | 说明 |
| :--- | :--- | :---: | :--- | :--- |
| `UPLOAD_PASSWORD` | Secret | **必填** | — | 主管理员登录密码，同时用于派生外部存储池密钥的加密密钥 |
| `MAX_UPLOAD_SIZE` | Var | 选填 | `5368709120` (5 GB) | 单文件上传大小上限（字节） |
| `R2_BUCKET` | Var | 选填 | `relaybox` | 内置 R2 桶名（仅预签名模式需要与实际桶名一致） |
| `R2_ACCESS_KEY_ID` | Secret | 选填 | — | R2 S3 API Access Key ID（仅开启预签名直传时需要） |
| `R2_SECRET_ACCESS_KEY` | Secret | 选填 | — | R2 S3 API Secret Access Key（仅开启预签名直传时需要） |
| `R2_ACCOUNT_ID` | Secret | 选填 | — | Cloudflare Account ID（仅开启预签名直传时需要） |

---

## 项目结构

```text
├── migrations/
│   ├── 0001_init.sql             # 初始 D1 建表迁移
│   ├── 0002_share_expiry.sql     # 分享独立有效期
│   ├── 0003_perf_indexes.sql     # 高频查询复合索引
│   ├── 0004_v360_features.sql    # 文件置顶/备注与安全审计日志
│   ├── 0005_github_releases.sql  # GitHub Release 自动追更订阅表
│   └── 0006_sub_accounts.sql     # 子账号与临时测试号（users/sessions/files）
├── public/
│   ├── index.html                # 单文件 SPA + PWA 前端
│   ├── jszip.min.js              # 浏览器端打包下载依赖
│   ├── qrcode.min.js             # 二维码生成依赖
│   └── logo.png                  # 项目图标
├── src/
│   ├── core/                     # 纯 Web 标准 API 编写的 Hono 路由与业务逻辑（零 Node 依赖）
│   │   ├── lib/                  # 鉴权、PBKDF2/AES-GCM 加密、S3 外部池、审计、通知、定时清理
│   │   └── routes/               # 文件、目录、子账号、分享、收集箱、GitHub、统计、WebDAV 等路由
│   ├── adapters/
│   │   └── cf/                   # Cloudflare D1MetaStore + R2 Storage 适配层
│   ├── entry-worker.js           # Workers 入口（fetch + scheduled 定时任务）
│   └── schema.sql                # 完整 D1 表结构基线（已含 0001–0006 全部变更）
├── wrangler.toml                 # Cloudflare Workers / D1 / R2 / Cron 配置
└── package.json                  # 依赖与部署/测试脚本
```

---

## 常见问题与注意事项

1. **自定义壁纸 / Logo 填入链接后显示裂图？**
   - 壁纸与头像必须填写**公开图片直链**（如 `/f/<文件ID>` 或外部图片直链），不能填 `/s/...` 分享页链接（`/s/` 返回的是 HTML 网页而非图片）；最省事的方式是直接点输入框右侧的 **「上传」** 按钮。
2. **开启预签名直传大文件失败或提示 CORS 错误？**
   - 请在对应 R2 桶的 **Settings → CORS Policy** 中允许你站点的域名执行 `PUT`、`GET`、`HEAD`，并在 `ExposeHeaders` 中暴露 `ETag`（浏览器分片合并必需）。
3. **如何为外部 R2 / S3 桶配置自定义域名直出？**
   - 在后台 **存储池管理 → 编辑** 中填入「公开访问域名」（如 `https://cdn.example.com`）。公开图片/视频在线预览将自动 302 跳转直出（零 Worker 流量），私密文件、强制下载（`?download=1`）与限次分享仍严格走鉴权链路。
4. **国内访问 `*.workers.dev` 不稳定？**
   - 强烈建议在 Cloudflare Workers 的 **Settings → Domains & Routes** 中绑定自己的自定义域名，速度与稳定性会大幅提升。

---

## 测试与开发

```sh
# 运行全量 D1 回归测试（101 项用例，基于 Node 内置 node:sqlite，零外部依赖）
npm test
```

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源，欢迎自由部署与二次开发。
