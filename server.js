/**
 * server.js — Heartbeat Signal PWA 极简后端
 * =============================================
 * 功能：
 *   1. GET  /vapid-public-key    — 返回 VAPID 公钥（前端用于 pushManager.subscribe）
 *   2. POST /subscribe           — 接收并存储用户的推送订阅信息
 *   3. POST /send-signal         — 向所有已订阅用户发送 Web Push 通知
 *   4. POST /upload-image        — 接收前端上传的自定义动图，返回可访问 URL
 *
 * 技术栈：Express + web-push + multer
 * 部署目标：Vercel / Render / Railway / VPS
 *
 * =============================================
 * 使用前请先运行以下命令生成 VAPID 密钥：
 *   npx web-push generate-vapid-keys
 * 然后将生成的公钥/私钥填入下方 VAPID_KEYS 对象。
 * =============================================
 */

import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ======================== 配置 ========================

// VAPID 密钥 —— 部署前必须替换！
// 生成命令: npx web-push generate-vapid-keys
const VAPID_KEYS = {
  publicKey: process.env.VAPID_PUBLIC_KEY || 'BGWQKSTL_au4-reJvsTVIl7zsJSbq-DLUFvItpSNXWFRPDRvdfGgcYApvUF1DQ9j_BbV3qSIWCx-pPGBFi1f9JE',
  privateKey: process.env.VAPID_PRIVATE_KEY || 'uz_nbsAT45x-RMuKnoOInfBy5O_ubLl4eIByz4faRq4',
  subject: process.env.VAPID_SUBJECT || 'mailto:your-email@example.com',
};

// 上传目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UPLOADS_DIR = join(__dirname, 'uploads');
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

// 确保上传目录存在
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ======================== 初始化 web-push ========================
webpush.setVapidDetails(VAPID_KEYS.subject, VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

// ======================== Express 应用 ========================
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
// 静态文件服务（前端页面）
app.use(express.static('.'));
// 上传文件可通过 /uploads/xxx 访问
app.use('/uploads', express.static(UPLOADS_DIR));

// ======================== 数据存储（文件持久化） ========================
/**
 * 订阅列表
 * 数据结构：PushSubscriptionJSON 对象数组
 *
 * PushSubscriptionJSON 格式：
 * {
 *   endpoint: "https://fcm.googleapis.com/...",
 *   keys: {
 *     p256dh: "...",
 *     auth: "..."
 *   }
 * }
 */

// 订阅数据持久化文件路径
const SUBSCRIPTIONS_FILE = join(__dirname, 'subscriptions.json');

/** 从文件加载已有订阅 */
function loadSubscriptions() {
  try {
    if (existsSync(SUBSCRIPTIONS_FILE)) {
      const data = readFileSync(SUBSCRIPTIONS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[订阅] 读取 subscriptions.json 失败，将使用空列表:', err.message);
  }
  return [];
}

/** 将当前订阅写入文件 */
function saveSubscriptions(subs) {
  try {
    writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
  } catch (err) {
    console.error('[订阅] 写入 subscriptions.json 失败:', err.message);
  }
}

/** 内存中的订阅列表（启动时从文件加载） */
const subscriptions = loadSubscriptions();
console.log(`[订阅] 启动时加载了 ${subscriptions.length} 个已有订阅`);

// 速率限制：存储每个 IP 的最后发送时间戳
const rateLimitMap = new Map();

// ======================== Multer 文件上传配置 ========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop() || 'gif';
    const name = `${randomUUID()}.${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // 只允许图片/GIF 类型
    const allowed = ['image/gif', 'image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error('仅支持 GIF/PNG/JPEG/WebP 格式');
      err.code = 'UNSUPPORTED_FILE_TYPE';
      cb(err, false);
    }
  },
});

// ======================== API 路由 ========================

/**
 * GET /vapid-public-key
 * 返回 VAPID 公钥，前端用于 pushManager.subscribe({ applicationServerKey: ... })
 */
app.get('/vapid-public-key', (req, res) => {
  if (!VAPID_KEYS.publicKey || VAPID_KEYS.publicKey === 'YOUR_PUBLIC_KEY_HERE') {
    return res.status(500).json({ error: 'VAPID 公钥未配置，请先运行 npx web-push generate-vapid-keys 并设置环境变量' });
  }
  res.json({ publicKey: VAPID_KEYS.publicKey });
});

/**
 * POST /subscribe
 * 接收前端推送订阅信息并存储
 *
 * Request Body: PushSubscriptionJSON
 * {
 *   endpoint: "...",
 *   expirationTime: null,
 *   keys: { p256dh: "...", auth: "..." }
 * }
 */
app.post('/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;

  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: '无效的订阅信息，需要 endpoint、keys.p256dh、keys.auth' });
  }

  // 避免重复订阅（按 endpoint 去重）
  const existingIdx = subscriptions.findIndex(s => s.endpoint === endpoint);
  if (existingIdx >= 0) {
    subscriptions[existingIdx] = req.body;
    console.log('[订阅] 已更新已有订阅，当前总数:', subscriptions.length);
  } else {
    subscriptions.push(req.body);
    console.log('[订阅] 新增订阅，当前总数:', subscriptions.length);
  }

  // 持久化到文件
  saveSubscriptions(subscriptions);

  res.json({ success: true, count: subscriptions.length });
});

/**
 * POST /send-signal
 * 向所有已订阅用户发送 Web Push 通知
 *
 * Request Body:
 * {
 *   image: "动图URL",           // iOS 锁屏通知显示的图片
 *   title: "通知标题",
 *   body: "通知正文",
 *   timestamp: 时间戳
 * }
 */
app.post('/send-signal', async (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

  // 可选认证：如果设置了 SEND_SECRET 环境变量，要求提供匹配的 secret
  if (process.env.SEND_SECRET) {
    const { secret } = req.body;
    if (secret !== process.env.SEND_SECRET) {
      console.warn(`[认证] IP ${clientIp} 提供了无效的 secret`);
      return res.status(401).json({ error: '认证失败：secret 无效' });
    }
  }

  // 速率限制：同一 IP 两次发送之间至少间隔 5 秒
  const lastSendTime = rateLimitMap.get(clientIp);
  const now = Date.now();
  if (lastSendTime !== undefined && now - lastSendTime < 5000) {
    const retryAfter = Math.ceil((5000 - (now - lastSendTime)) / 1000);
    return res.status(429).json({
      error: '发送过于频繁，请稍后再试',
      retryAfterSeconds: retryAfter,
    });
  }
  rateLimitMap.set(clientIp, now);

  const { image, title, body } = req.body;

  if (!image) {
    return res.status(400).json({ error: '缺少 image 字段（动图URL）' });
  }

  if (subscriptions.length === 0) {
    return res.status(200).json({
      success: true,
      sent: 0,
      message: '暂无已订阅用户，通知未发送',
    });
  }

  // 构建推送 payload
  const payload = JSON.stringify({
    title: title || '来自TA的心动信号 💗',
    body: body || 'TA给你发送了一个心动信号~',
    image: image,                       // === iOS 16.4+ 锁屏通知显示动图的关键字段 ===
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: 'heartbeat-signal',
    data: { url: '/' },
    timestamp: Date.now(),
  });

  console.log(`[发送] 准备向 ${subscriptions.length} 个订阅发送通知`);
  console.log(`[发送] Image URL: ${image}`);

  // 并发向所有订阅发送推送
  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush.sendNotification(sub, payload).catch((err) => {
        console.error('[发送] 推送失败:', err.statusCode, err.body || err.message);
        throw err;
      })
    )
  );

  // 统计结果并清理无效订阅
  let successCount = 0;
  const failedEndpoints = [];

  results.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      successCount++;
    } else {
      console.error(`[发送] 订阅 #${idx} 失败:`, result.reason?.statusCode, result.reason?.body);
      failedEndpoints.push(subscriptions[idx]?.endpoint);
    }
  });

  // 移除已失效的订阅（返回 410 Gone 或 404 Not Found 的）
  const deadStatuses = [410, 404];
  for (let i = subscriptions.length - 1; i >= 0; i--) {
    const result = results[i];
    if (
      result.status === 'rejected' &&
      result.reason &&
      deadStatuses.includes(result.reason.statusCode)
    ) {
      console.log('[清理] 移除无效订阅:', subscriptions[i].endpoint.slice(0, 60) + '...');
      subscriptions.splice(i, 1);
    }
  }

  console.log(`[发送] 完成: ${successCount}/${results.length} 成功，剩余有效订阅: ${subscriptions.length}`);

  // 清理失效订阅后持久化到文件
  if (failedEndpoints.length > 0) {
    saveSubscriptions(subscriptions);
  }

  res.json({
    success: true,
    sent: successCount,
    total: results.length,
    remaining: subscriptions.length,
  });
});

/**
 * POST /upload-image
 * 接收前端上传的自定义动图，返回可访问的 URL
 *
 * 使用 multer 中间件处理 multipart/form-data 上传
 *
 * Response:
 * {
 *   success: true,
 *   url: "/uploads/xxx.gif",
 *   filename: "xxx.gif"
 * }
 */
app.post('/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未找到上传文件，字段名应为 image' });
  }

  const url = `/uploads/${req.file.filename}`;

  console.log('[上传] 文件已保存:', req.file.filename, `(${(req.file.size / 1024).toFixed(1)} KB)`);

  res.json({
    success: true,
    url: url,
    filename: req.file.filename,
    size: req.file.size,
  });
});

// Multer 错误处理中间件（文件过大、格式错误等）
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件大小不能超过 2MB' });
    }
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  // 处理 Multer fileFilter 抛出的自定义错误
  if (err.code === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(400).json({ error: err.message });
  }
  console.error('[错误]', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// ======================== 启动服务器 ========================
app.listen(PORT, () => {
  console.log('❤️  ===========================================');
  console.log('   Heartbeat Signal 后端已启动');
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   VAPID 公钥已配置: ${VAPID_KEYS.publicKey !== 'YOUR_PUBLIC_KEY_HERE' ? '✅ 是' : '❌ 否（请生成并配置）'}`);
  console.log(`   /send-signal 认证: ${process.env.SEND_SECRET ? '🔒 已启用（需提供 secret）' : '⚠️  未启用（开放访问）'}`);
  console.log(`   订阅持久化文件: ${SUBSCRIPTIONS_FILE}`);
  console.log(`   已加载订阅数: ${subscriptions.length}`);
  console.log(`   速率限制: 同一 IP 5 秒内只能发送一次`);
  console.log('❤️  ===========================================');
});

// ======================== 导出（供 Vercel Serverless 使用） ========================
export default app;