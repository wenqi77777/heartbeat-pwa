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
import { join, dirname, extname, resolve, sep } from 'node:path';
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
// ✅ 修改点：上传文件类型白名单集中定义，供 multer 校验和安全扩展名生成共用
const ALLOWED_UPLOAD_MIME_TO_EXT = new Map([
  ['image/gif', '.gif'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);
const ALLOWED_GIF_PATHS = new Set([
  '/heart.gif',
  '/birthday.gif',
  '/fireworks.gif',
  '/miss.gif',
]);

// 确保上传目录存在
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ======================== 初始化 web-push ========================
webpush.setVapidDetails(VAPID_KEYS.subject, VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

// ======================== Express 应用 ========================
const app = express();
const PORT = process.env.PORT || 3000;

// ✅ 修改点：Railway/反向代理环境必须信任代理，否则 req.protocol 可能一直是 http，导致推送图片 URL 不是 HTTPS
app.set('trust proxy', 1);

// 中间件
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})); // ✅ 修改点：显式允许跨域 JSON 请求，便于自定义域名或 ?api= 调试
app.use(express.json({ limit: '1mb' }));
// ✅ 修改点：内置根目录 GIF 先于通用静态托管显式返回，确保 Content-Type/缓存头稳定，便于 iOS 富媒体通知直接拉取
app.get([...ALLOWED_GIF_PATHS], (req, res, next) => {
  const gifFilePath = join(__dirname, req.path.replace(/^\//, ''));

  if (!existsSync(gifFilePath)) {
    return next();
  }

  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'public, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.sendFile(gifFilePath);
});

// 静态文件服务（前端页面）
app.use(express.static(__dirname, {
  setHeaders(res, filePath) {
    if (extname(filePath).toLowerCase() === '.gif') {
      res.setHeader('Content-Type', 'image/gif');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  },
}));
// 上传文件可通过 /uploads/xxx 访问
app.use('/uploads', express.static(UPLOADS_DIR));

// ✅ 修改点：统一生成当前 Railway/自定义域名下的 HTTPS 站点 origin
function getPublicOrigin(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}`.replace(/^http:\/\//i, 'https://');
}

// ✅ 修改点：把 /heart.gif、uploads/a.gif、heart.gif 等路径统一转换为公网可访问的绝对 HTTPS URL
function toAbsoluteHttpsUrl(input, req) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();

  if (/^data:/i.test(trimmed) || /^blob:/i.test(trimmed)) {
    return '';
  }

  try {
    const absolute = new URL(trimmed, getPublicOrigin(req));
    if (absolute.protocol === 'http:') {
      absolute.protocol = 'https:';
    }
    return absolute.toString();
  } catch {
    return '';
  }
}

// 严格校验 /send-signal 使用的图片：必须是公网 HTTPS 绝对 URL，且路径只能是内置 GIF 白名单或 /uploads/ 上传文件
function isBlockedGifHostname(hostname) {
  const normalizedHostname = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');

  if (normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1') {
    return true;
  }

  const ipv4Match = normalizedHostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) {
    return false;
  }

  const octets = ipv4Match.slice(1).map(Number);
  if (octets.some(octet => octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function validateSignalGifImage(image) {
  let url;

  try {
    url = new URL(image);
  } catch {
    return { error: 'GIF 路径不合法', status: 400 };
  }

  if (url.protocol !== 'https:') {
    return { error: 'GIF 路径不合法', status: 400 };
  }

  if (isBlockedGifHostname(url.hostname)) {
    return { error: 'GIF 路径不合法', status: 400 };
  }

  const isBuiltInGif = ALLOWED_GIF_PATHS.has(url.pathname);
  const isUploadedGif = url.pathname.startsWith('/uploads/');

  if (!isBuiltInGif && !isUploadedGif) {
    return { error: 'GIF 路径不合法', status: 400 };
  }

  let gifFilePath;
  if (isBuiltInGif) {
    gifFilePath = join(__dirname, url.pathname.replace(/^\//, ''));
  } else {
    let uploadRelativePath;
    try {
      uploadRelativePath = decodeURIComponent(url.pathname.slice('/uploads/'.length));
    } catch {
      return { error: 'GIF 路径不合法', status: 400 };
    }

    const uploadsRoot = resolve(UPLOADS_DIR);
    gifFilePath = resolve(uploadsRoot, uploadRelativePath);

    if (gifFilePath !== uploadsRoot && !gifFilePath.startsWith(`${uploadsRoot}${sep}`)) {
      return { error: 'GIF 路径不合法', status: 400 };
    }
  }

  if (!existsSync(gifFilePath)) {
    return { error: 'GIF 不存在', status: 404 };
  }

  return { url };
}

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
    // ✅ 修改点：扩展名不再信任 originalname，按已通过白名单的 mimetype 生成，避免伪造文件名影响静态访问
    const fallbackExt = extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_UPLOAD_MIME_TO_EXT.get(file.mimetype) || fallbackExt || '.gif';
    const name = `${randomUUID()}${safeExt}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // ✅ 修改点：后端保持严格上传文件类型白名单，并返回明确 JSON 错误
    if (ALLOWED_UPLOAD_MIME_TO_EXT.has(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error('文件类型不支持：仅支持 GIF/PNG/JPEG/WebP');
      err.code = 'UNSUPPORTED_FILE_TYPE';
      cb(err, false);
    }
  },
});

// ======================== API 路由 ========================

// ✅ 修改点：Railway 防休眠健康检查接口，可配合 UptimeRobot / cron-job.org 每 5 分钟访问一次 https://你的域名/ping
app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    subscriptions: subscriptions.length,
  });
});

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

  // ✅ 修改点：SEND_SECRET 支持 body.secret、?secret= 和 Authorization: Bearer xxx，未设置时保持开放可用
  if (process.env.SEND_SECRET) {
    const authHeader = req.get('authorization') || '';
    const bearerSecret = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const providedSecret = req.body?.secret || req.query?.secret || bearerSecret;
    if (providedSecret !== process.env.SEND_SECRET) {
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

  const { image } = req.body;
  const gifValidation = validateSignalGifImage(image);

  if (gifValidation.error) {
    return res.status(gifValidation.status).json({
      error: gifValidation.error,
    });
  }

  const signalImage = gifValidation.url.toString();
  const notificationCopies = {
    '/heart.gif': {
      title: '来自 TA 的消息 💌',
      body: '有人给你递了一份心动～',
    },
    '/birthday.gif': {
      title: 'Happy Birthday 🎂',
      body: '有人给你送了一份生日祝福～',
    },
    '/fireworks.gif': {
      title: '有人为你放了专属烟花🎆',
      body: '烟火向星辰，所愿皆成真～',
    },
    '/miss.gif': {
      title: '有点想你啦💕',
      body: 'TA 的想念已送达',
    },
  };
  const notificationCopy = gifValidation.url.pathname.startsWith('/uploads/')
    ? {
      title: '你收到一份小惊喜 ✨',
      body: 'TA给你发了一段专属心意',
    }
    : notificationCopies[gifValidation.url.pathname];

  if (subscriptions.length === 0) {
    return res.status(200).json({
      success: true,
      sent: 0,
      message: '暂无已订阅用户，通知未发送',
    });
  }

  const publicOrigin = getPublicOrigin(req);

  // 构建推送 payload
  const payload = JSON.stringify({
    title: notificationCopy.title,
    body: notificationCopy.body,
    image: signalImage, // ✅ 修改点：payload 必须保留前端传来的 HTTPS 绝对 URL，不自动转换、不使用默认 GIF 兜底
    mediaUrl: signalImage,
    'mutable-content': 1,
    mutableContent: 1,
    icon: toAbsoluteHttpsUrl('/icon.png', req), // ✅ 修改点：通知栏 icon 统一使用根目录新图标，并转换为公网 HTTPS 绝对 URL
    badge: toAbsoluteHttpsUrl('/icon.png', req), // ✅ 修改点：通知 badge 不再引用旧 /icons/badge-96.png，避免缺失文件
    tag: `heartbeat-signal-${Date.now()}`, // ✅ 修改点：使用唯一 tag，避免同 tag 通知被系统合并导致看起来只有第一次有效
    data: {
      url: publicOrigin + '/',
      gifUrl: signalImage,
      image: signalImage,
      mediaUrl: signalImage,
    },
    timestamp: Date.now(),
  });

  console.log(`[发送] 准备向 ${subscriptions.length} 个订阅发送通知`);
  console.log(`[发送] Image URL: ${signalImage}`);

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

  const failedCount = results.length - successCount;

  res.json({
    success: true,
    sent: successCount,
    failed: failedCount,
    total: results.length,
    remaining: subscriptions.length,
    message: `推送成功 ${successCount} 个，失败 ${failedCount} 个`,
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
    // ✅ 修改点：无文件上传时返回可直接展示的精准 JSON 错误
    return res.status(400).json({ error: '文件未选择：请使用字段名 image 上传图片文件' });
  }

  const uploadPath = `/uploads/${req.file.filename}`;
  const url = toAbsoluteHttpsUrl(uploadPath, req); // ✅ 修改点：上传后直接返回绝对 HTTPS URL，前端可直接用于通知 image

  try {
    const parsedUrl = new URL(url);
    const isLocalHttp = parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== 'https:' && !isLocalHttp) {
      return res.status(500).json({ error: '上传成功但生成的访问 URL 不是 HTTPS 地址' });
    }
  } catch {
    return res.status(500).json({ error: '上传成功但生成的访问 URL 非法' });
  }

  console.log('[上传] 文件已保存:', req.file.filename, `(${(req.file.size / 1024).toFixed(1)} KB)`);
  console.log('[上传] 访问 URL:', url);

  res.json({
    success: true,
    url,
    path: uploadPath,
    filename: req.file.filename,
    size: req.file.size,
  });
});

// Multer 错误处理中间件（文件过大、格式错误等）
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件超过大小限制：不能超过 2MB' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: '上传字段错误：请使用字段名 image' });
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