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

> 无需服务器、无需 NAS、无需手写配置文件——基于 **Cloudflare Workers + D1 + R2 + Static Assets** 纯 Serverless 架构，免费额度即可拥有 10 GB 起步的云端文件传输站、外链分享、反向文件收集箱、WebDAV 网盘与多存储池管理。

---

## 📑 目录

- [核心功能](#核心功能)
- [一键部署到 Cloudflare（推荐）](#一键部署到-cloudflare推荐)
- [手动 CLI 部署](#手动-cli-部署)
- [使用指南](#使用指南)
  - [文件分享与 5 位取件码](#文件分享与-5-位取件码)
  - [访客文件收集箱](#访客文件收集箱)
  - [极客 API 上传（curl）](#极客-api-上传curl)
  - [WebDAV 挂载](#webdav-挂载)
- [环境变量与密钥列表](#环境变量与密钥列表)
- [项目结构](#项目结构)
- [常见问题与注意事项](#常见问题与注意事项)
- [测试与开发](#测试与开发)

---

## ✨ 核心功能

### 1. 多存储池与双传输模式
- **零门槛内置 R2 中转模式**：开箱即用，无需配置任何 S3 API 密钥或桶 CORS，校园网/弱网环境也能稳定上传与外链访问。
- **大文件预签名直传模式**：支持单文件最高 **5 GB**（可通过 `MAX_UPLOAD_SIZE` 调整）分片直传与断点续传，流量不经过 Worker。
- **动态外部 S3 / R2 存储池**：后台网页随时挂载任意外部 Cloudflare R2、Backblaze B2、MinIO 等 S3 兼容桶（密钥 AES-GCM 加密存库），支持配置自定义 `publicDomain` 公开域名 302 预览直出，以及单文件/整池流式跨池迁移。

### 2. 分享、取件与反向收集
- **文件 & 文件夹分享**：支持自定义提取码、下载限次、阅后即焚与 **5 位短取件码**；分享文件夹支持浏览器端一键打包下载（ZIP）。
- **全站分享管理中心**：一屏查看全站所有活跃/已耗尽/已过期外链与取件码，支持按状态筛选、搜索、复制文案、修改提取码或一键吊销。
- **反向文件收集箱（`/d/:token`）**：生成只写不读的收件链接，访客免登录即可提交作业/素材到指定目录，提交者之间互不可见。

### 3. 效率工具与协议生态
- **现代单文件 SPA + PWA**：支持全屏拖拽/剪贴板粘贴上传、客户端 Canvas 图片压缩转 WebP、视频首帧缩略图自动截取与一键重截、URL 目录路由同步（`/?folder=<id>`）与手机端侧滑返回。
- **在线预览与编辑**：支持图片缩放旋转、视频倍速播放、音频、PDF、**Markdown 渲染预览（含源码切换）**、带行号代码预览、在线文本编辑（≤ 1 MB）与文字/代码快传（Pastebin）。
- **防 SSRF 远程拉取**：直接输入远程文件 URL 转存至存储池（≤ 50 MB）。
- **7 天防误删回收站**：软删除文件保留 7 天随时一键还原，Cron 定时任务自动清理过期文件与残余分片。
- **WebDAV & API Token**：支持 `/dav/*` 标准 WebDAV 挂载与 `/api/raw-upload` 极客命令行上传。
- **Telegram 实时推送**：支持收集箱投递提醒、阅后即焚耗尽告警、暴力破解封禁告警与每日存储池用量定时汇总。
- **个性化外观**：支持桌面端/手机端独立壁纸、自定义站点标题/Logo/Favicon、浅色/深色/跟随系统瞬切与桌面端顶栏图标长按拖拽排序。

---

## 🚀 一键部署到 Cloudflare（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HueGild/relaybox)

### 前置条件
1. 拥有一个 GitHub 账号与 Cloudflare 账号。
2. 在 Cloudflare 控制台提前**开通 R2 服务**（每月提供 **10 GB 免费存储 + 100 万次 A 类/1000 万次 B 类免费操作**；开通需绑定信用卡或 PayPal，免费额度内不扣费）。

### 部署步骤
1. 点击上方 **Deploy to Cloudflare** 按钮，授权克隆本仓库到你的 GitHub 账号。
2. Cloudflare 会自动为你创建全新的 **D1 数据库** 与 **R2 存储桶**，自动回填 `database_id`，执行 `migrations/0001_init.sql` 建表并部署上线。
3. 部署完成后，进入 Cloudflare 控制台：**Workers & Pages → 你的 Worker → Settings → Variables and Secrets**，新增一条加密变量（Secret）：
   - 名称：`UPLOAD_PASSWORD`
   - 值：你自定义的管理员登录密码
4. 保存后访问你的 Worker 域名（或绑定自定义域名），点击右上角登录即可开始使用！

> **提示**：仅配置 `UPLOAD_PASSWORD` 后，内置 R2 的**中转模式**即可 100% 正常工作；如需开启百 MB~GB 级大文件**预签名直传模式**，再按下方环境变量表补填 `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_ACCOUNT_ID` 并配置桶 CORS 暴露 `ETag` 头即可。

---

## 🛠️ 手动 CLI 部署

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

# 5. 自动执行 D1 建表迁移并部署
npm run deploy
```

也可以在 Cloudflare Workers 中直接连接你的 GitHub 仓库（生产分支 `main`，部署命令填 `npm run deploy`），之后每次 push 都会自动迁移并部署。

---

## 📖 使用指南

### 文件分享与 5 位取件码
- 点击文件/文件夹菜单中的「分享设置」，可配置**提取码**、**最大下载次数**（设为 `1` 即阅后即焚），系统同时自动分配唯一 **5 位短取件码**。
- 访客可在首页顶部输入框直接输入 5 位取件码直达分享页，也可直接打开 `/s/<token>` 链接。

### 访客文件收集箱
- 管理员在顶栏（手机端侧边抽屉）打开 **文件收集箱 → + 新建收集箱**，设置标题、存入目录、可选口令、最大份数与有效期。
- 将生成的 `/d/<token>` 链接发给他人，对方无需登录即可上传文件，且无法查看他人已提交的文件。

### 极客 API 上传（curl）
在后台 **API 密钥管理** 生成 `rbx_...` 密钥后，即可在终端或脚本中一键传文件：

```sh
curl -X POST "https://你的域名/api/raw-upload?filename=test.png&visibility=public"   -H "Authorization: Bearer rbx_你的密钥"   --data-binary @./test.png
```

### WebDAV 挂载
- **服务器地址**：`https://你的域名/dav`
- **用户名**：`admin`
- **密码**：在后台生成的「全功能（all）」API 密钥（推荐）或管理员密码
- 兼容 Finder、RaiDrive、Infuse、VidHub、ES 文件浏览器等标准 WebDAV 客户端。

---

## ⚙️ 环境变量与密钥列表

| 变量名 | 类型 | 是否必填 | 默认值 | 说明 |
| :--- | :--- | :---: | :--- | :--- |
| `UPLOAD_PASSWORD` | Secret | **必填** | — | 管理员登录密码，同时用于派生外部存储池密钥的加密密钥 |
| `MAX_UPLOAD_SIZE` | Var | 选填 | `5368709120` (5 GB) | 单文件上传大小上限（字节） |
| `R2_BUCKET` | Var | 选填 | `relaybox` | 内置 R2 桶名（仅预签名模式需要与实际桶名一致） |
| `R2_ACCESS_KEY_ID` | Secret | 选填 | — | R2 S3 API Access Key ID（仅开启预签名直传时需要） |
| `R2_SECRET_ACCESS_KEY` | Secret | 选填 | — | R2 S3 API Secret Access Key（仅开启预签名直传时需要） |
| `R2_ACCOUNT_ID` | Secret | 选填 | — | Cloudflare Account ID（仅开启预签名直传时需要） |

---

## 📂 项目结构

```text
├── migrations/
│   └── 0001_init.sql       # 幂等 D1 初始建表迁移（一键部署自动执行）
├── public/
│   ├── index.html          # 单文件 SPA + PWA 前端
│   ├── jszip.min.js        # 浏览器端打包下载依赖
│   └── qrcode.min.js       # 二维码生成依赖
├── src/
│   ├── core/               # 纯 Web 标准 API 编写的 Hono 路由与业务逻辑（零 Node 依赖）
│   │   ├── lib/            # 鉴权、加密、S3 外部池、Telegram 通知、定时清理
│   │   └── routes/         # 文件、目录、分享、收集箱、回收站、WebDAV、分片等路由
│   ├── adapters/
│   │   └── cf/             # Cloudflare D1MetaStore + R2 Storage 适配层
│   ├── entry-worker.js     # Workers 入口（fetch + scheduled 定时任务）
│   └── schema.sql          # 完整 D1 表结构参考
├── wrangler.toml           # Cloudflare Workers / D1 / R2 / Cron 配置
└── package.json            # 依赖与部署/测试脚本
```

---

## ⚠️ 常见问题与注意事项

1. **自定义壁纸 / Logo 填入链接后显示裂图？**
   - 壁纸与头像必须填写**公开图片直链**（如 `/f/<文件ID>` 或外部图片直链），不能填 `/s/...` 分享页链接（`/s/` 返回的是 HTML 网页而非图片）；最省事的方式是直接点输入框右侧的 **「上传」** 按钮。
2. **开启预签名直传大文件失败或提示 CORS 错误？**
   - 请在对应 R2 桶的 **Settings → CORS Policy** 中允许你站点的域名执行 `PUT`、`GET`、`HEAD`，并在 `ExposeHeaders` 中暴露 `ETag`（浏览器分片合并必需）。
3. **如何为外部 R2 / S3 桶配置自定义域名直出？**
   - 在后台 **存储池管理 → 编辑** 中填入「公开访问域名」（如 `https://cdn.example.com`）。公开图片/视频在线预览将自动 302 跳转直出（零 Worker 流量），私密文件、强制下载（`?download=1`）与限次分享仍严格走鉴权链路。
4. **国内访问 `*.workers.dev` 不稳定？**
   - 强烈建议在 Cloudflare Workers 的 **Settings → Domains & Routes** 中绑定自己的自定义域名，速度与稳定性会大幅提升。

---

## 🧪 测试与开发

```sh
# 运行全量 D1 回归测试（基于 Node 内置 node:sqlite，零外部依赖）
npm test
```

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源，欢迎自由部署与二次开发。
