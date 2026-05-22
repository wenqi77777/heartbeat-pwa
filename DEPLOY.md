# Heartbeat Signal PWA — 部署说明

## 目录

1. [项目结构](#项目结构)
2. [本地开发环境搭建](#本地开发环境搭建)
3. [生成 VAPID 密钥](#生成-vapid-密钥)
4. [配置环境变量](#配置环境变量)
5. [部署到 Render](#部署到-render推荐)
6. [部署到 Railway](#部署到-railway)
7. [部署到 Vercel](#部署到-vercel仅前端)
8. [iOS 添加到主屏幕](#ios-添加到主屏幕)
9. [iOS 开启通知权限](#ios-开启通知权限)
10. [测试推送通知](#测试推送通知)
11. [常见问题排查](#常见问题排查)

---

## 项目结构

```
PWA项目/
├── index.html          # PWA 主页面（星空背景、发送按钮、动图卡片）
├── manifest.json       # PWA 应用清单（iOS/Safari 兼容）
├── sw.js               # Service Worker（Web Push 接收 + 缓存）
├── server.js           # Express 后端（订阅/推送/上传）
├── package.json        # 项目依赖与脚本
├── DEPLOY.md           # 本文件 — 部署说明
├── uploads/            # 用户上传文件存储目录（自动创建）
├── icons/              # PWA 图标目录（需要准备图标文件）
└── screenshots/        # PWA 截图（manifest 引用）
```

---

## 本地开发环境搭建

### 前提条件

- **Node.js** >= 18（推荐使用 nvm 管理）
- **npm** >= 9
- **HTTPS 本地开发**（Web Push 需要 HTTPS 或 localhost）

### 安装步骤

```bash
# 1. 进入项目目录
cd /Users/admin/Documents/PWA项目

# 2. 安装依赖
npm install

# 3. 生成 VAPID 密钥（见下一节）

# 4. 启动开发服务器
npm run dev
```

服务器启动后访问 **http://localhost:3000**。

> **注意**：Web Push API 在 localhost 下可以直接工作，无需 HTTPS。部署到生产环境时**必须使用 HTTPS**。

---

## 生成 VAPID 密钥

VAPID（Voluntary Application Server Identification）是 Web Push 协议的身份验证机制，每个应用需要一对公私钥。

```bash
# 在项目目录下运行
npx web-push generate-vapid-keys
```

输出示例：

```
=======================================
Public Key:
BOrXkBZ...（约87个字符的Base64字符串）

Private Key:
nYj...（约43个字符的Base64字符串）
=======================================
```

**请将这两个密钥保存好**，后续需要配置到环境变量中。

---

## 配置环境变量

### 本地开发

创建 `.env` 文件（仅本地使用，不要提交到 Git）：

```bash
# .env
VAPID_PUBLIC_KEY=你的公钥
VAPID_PRIVATE_KEY=你的私钥
VAPID_SUBJECT=mailto:你的邮箱@example.com
PORT=3000
```

### Render / Railway 部署

在平台的「Environment Variables」设置中添加以下变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `VAPID_PUBLIC_KEY` | VAPID 公钥 | `BOrXkBZ...` |
| `VAPID_PRIVATE_KEY` | VAPID 私钥 | `nYj...` |
| `VAPID_SUBJECT` | 联系邮箱（格式 `mailto:xxx`）| `mailto:your@email.com` |
| `PORT` | 服务端口（平台通常自动设置） | `3000` |

---

## 部署到 Render（推荐）

[Render](https://render.com) 支持免费 Node.js Web Service，支持 HTTPS，是部署此类应用的最佳免费平台。

### 步骤

1. **注册/登录** [render.com](https://render.com)
2. 点击 **New +** → **Web Service**
3. 连接你的 GitHub/GitLab 仓库（或使用 Public Git repository）
4. 填写配置：

   | 字段 | 值 |
   |------|-----|
   | **Name** | `heartbeat-signal` |
   | **Runtime** | `Node` |
   | **Region** | `Singapore`（亚洲用户推荐）或 `Oregon` |
   | **Build Command** | `npm install` |
   | **Start Command** | `node server.js` |
   | **Instance Type** | `Free` |

5. 点击 **Advanced** → 添加环境变量（见上一节）
6. 点击 **Create Web Service**

部署完成后，Render 会提供一个 `https://xxx.onrender.com` 的域名，即你的 PWA 访问地址。

> **注意**：免费实例在 15 分钟无访问后会休眠，首次访问可能需要等待 30-60 秒唤醒。

---

## 部署到 Railway

[Railway](https://railway.app) 也提供免费额度，部署流程类似。

### 步骤

1. **注册/登录** [railway.app](https://railway.app)
2. 点击 **New Project** → **Deploy from GitHub repo**
3. 选择你的仓库
4. 在项目设置中添加环境变量（**Variables** 标签）
5. 点击 **Deploy**

Railway 会自动检测 Node.js 项目并运行 `npm start`，默认域名格式为 `https://xxx.up.railway.app`。

---

## 部署到 Vercel（仅前端）

[Vercel](https://vercel.com) 适合部署纯前端 PWA，但 **Serverless 函数不保持长连接**，不适合存储订阅信息的后端。你可以将后端部署在 Render/Railway，前端部署在 Vercel。

### Vercel 配置

1. 创建 `vercel.json`：

```json
{
  "version": 2,
  "builds": [
    {
      "src": "server.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "server.js" },
    { "src": "/(.*)", "dest": "server.js" }
  ]
}
```

2. 部署：`npx vercel --prod`

由于 Vercel Serverless 的限制，推荐使用 Render + Vercel 组合：
- **Vercel**：托管前端静态文件（`index.html`、`sw.js`、`manifest.json`）
- **Render**：运行 `server.js` 后端，并将前端的 `API_BASE` 指向 Render 域名

如果使用此组合，需要修改 [`index.html`](index.html) 中的 `API_BASE` 变量：

```javascript
// index.html 中找到这一行，改为 Render 的实际域名
const API_BASE = 'https://你的服务.onrender.com';
```

---

## iOS 添加到主屏幕

### 前提条件

- **iOS 16.4 或更高版本**
- 网站必须通过 **HTTPS** 访问
- 已正确配置 `manifest.json`

### 操作步骤

1. 在 iPhone 上用 **Safari** 打开你的 PWA 地址（例如 `https://xxx.onrender.com`）
2. 点击底部工具栏的 **分享按钮**（方框+箭头图标）
3. 滑动找到并点击 **「添加到主屏幕」**（Add to Home Screen）
4. 确认名称后点击右上角 **「添加」**

添加完成后，主屏幕上会出现一个「心动信号」的图标，点击即可以**全屏独立应用**形式打开。

### 验证 PWA 安装

- 打开后应看不到 Safari 的地址栏和工具栏（独立窗口模式）
- 下拉不应出现 Safari 的刷新提示
- 状态栏颜色为深色主题

---

## iOS 开启通知权限

### 首次使用

1. 通过主屏幕图标打开 PWA
2. 页面顶部会出现 **「开启通知，及时收到TA的心动信号 💗」** 的引导横幅
3. 点击 **「开启」** 按钮
4. 系统弹出通知权限对话框 → 点击 **「允许」**

### 如果之前拒绝了

1. 打开 iPhone **设置** → 下拉找到 **「Safari」**（或 PWA 已安装时找 PWA 名称）
2. 进入 **「网站设置」** 或 **「通知」**
3. 找到你的网站域名，将通知权限改为 **「允许」**

### 验证通知权限

在 Safari 地址栏左侧点击 **「大小」→「网站设置」**，确认「通知」为「允许」。

### iOS 16.4+ Web Push 关键要点

- **必须从主屏幕打开 PWA**（Add to Home Screen 后），才能接收 Web Push
- 在 Safari 浏览器中直接访问时，无法接收推送通知
- 通知中的 `image` 字段会在锁屏通知中显示（GIF/PNG 均可，但 GIF 动画在锁屏通知中播放效果因 iOS 版本而异）
- 确保 `sw.js` 的 `showNotification` 正确传递了 `image` 字段

---

## 测试推送通知

### 方法一：通过网页发送

1. 用两台设备（或一台设备的两个浏览器）打开 PWA
2. 两台设备都添加到主屏幕并**开启通知权限**
3. 在一台设备上选择动图，点击 **「发送心动」** 按钮
4. 另一台设备应收到锁屏通知，显示选中的动图

### 方法二：使用 curl 测试

```bash
# 先获取订阅列表（需要修改 server.js 添加一个 GET /subscriptions 接口，或用下面的方式）

# 直接发送测试推送
curl -X POST https://你的域名/send-signal \
  -H "Content-Type: application/json" \
  -d '{
    "image": "https://你的域名/icons/icon-192.png",
    "title": "测试推送",
    "body": "这是一条测试推送通知"
  }'
```

### 方法三：在线工具测试

使用 [web-push-codelab.glitch.me](https://web-push-codelab.glitch.me/) 发送测试推送，需要提供订阅信息的 endpoint 和 keys。

---

## 准备图标文件

需要在 `icons/` 目录下准备以下 PNG 图标文件：

| 文件名 | 尺寸 | 用途 |
|--------|------|------|
| `icon-192.png` | 192×192 | PWA 图标 / 通知图标 |
| `icon-512.png` | 512×512 | PWA 大图标 |
| `icon-512-maskable.png` | 512×512 | Android 自适应图标（安全区域留白） |
| `apple-touch-icon-180.png` | 180×180 | iOS 主屏幕图标 |
| `apple-touch-icon-152.png` | 152×152 | iPad 主屏幕图标 |
| `apple-touch-icon-120.png` | 120×120 | iPhone 主屏幕图标（备用） |
| `badge-96.png` | 96×96 | 通知角标图标 |

**图标设计建议**：星空背景+金色爱心，与整体风格保持一致。

可以使用以下方式快速生成占位图标：

```bash
# 使用 ImageMagick 生成简单占位图标（如已安装）
convert -size 192x192 xc:#0a0a1a -fill "#d4a853" -draw "circle 96,96 96,30" icons/icon-192.png
```

或使用在线工具 [maskable.app](https://maskable.app/) 生成符合 PWA 规范的图标。

---

## 常见问题排查

### Q: 通知没有收到

1. 检查是否已通过 **主屏幕** 打开 PWA（Safari 浏览器内无法接收推送）
2. 检查通知权限是否已授予（设置 → 通知 → 网站）
3. 检查 VAPID 密钥是否正确配置
4. 查看 `server.js` 的控制台日志：`[发送] 完成: X/Y 成功`
5. 确认 `sw.js` 是否已注册成功（Safari → 开发 → Service Workers）

### Q: PWA 没有以独立窗口打开

1. 确认 `manifest.json` 中 `display` 为 `"standalone"`
2. 确认通过「添加到主屏幕」打开，而非 Safari 地址栏
3. 检查 HTTPS 证书是否有效

### Q: 动图在通知中不显示

1. 动图 URL 必须是**绝对路径**（以 `https://` 开头）
2. 检查动图 URL 是否可公开访问
3. 某些 GIF 过大可能导致 iOS 裁剪，建议动图文件不超过 500KB

### Q: render.com 实例休眠

免费实例 15 分钟无流量会自动休眠。解决方案：
- 使用 [cron-job.org](https://cron-job.org) 定时 ping 你的服务
- 升级到 Render 付费计划（$7/月）
- 使用支持常驻的 Railway 免费计划

---

## 总结

部署完成后，你的 PWA 将具备：

- ✅ 深色星空背景 + 金色爱心 UI
- ✅ 4 种内置动图 + 自定义上传
- ✅ iOS 16.4+ 主屏幕独立应用
- ✅ 锁屏通知展示动图
- ✅ 双人互动推送心动信号

**推荐部署方案**：**Render**（一键部署 Node.js + 自动 HTTPS），最省心且完全免费。