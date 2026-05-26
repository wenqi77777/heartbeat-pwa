/**
 * Service Worker - Heartbeat Signal PWA
 * ========================================
 * 功能：
 * 1. 静态资源缓存（Cache-First 策略）
 * 2. Web Push 通知接收与展示（iOS 16.4+ 兼容）
 * 3. 通知点击处理（打开/聚焦主页面）
 *
 * iOS 16.4+ Web Push 关键点：
 * - showNotification 的 image 字段用于在锁屏通知中显示动图
 * - 必须在 push 事件中同步调用 event.waitUntil()
 * - notificationclick 事件用于处理用户点击通知
 */

// -------------------- 配置 --------------------
const CACHE_NAME = 'heartbeat-signal-v2'; // ✅ 修改点：升级缓存版本，确保部署后 iOS PWA 能尽快拿到新的通知逻辑

// 需要预缓存的静态资源列表
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.png'
]; // ✅ 修改点：只预缓存项目实际可能存在的核心资源，避免 /icons/* 缺失导致安装缓存失败

// -------------------- 安装事件 --------------------
// 预缓存关键静态资源，确保离线时基本可用
self.addEventListener('install', (event) => {
  console.log('[SW] 安装中...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] 预缓存资源中...');
        // 使用 addAll 批量缓存，忽略失败的请求（部分资源可能还未部署）
        return cache.addAll(PRECACHE_URLS).catch((err) => {
          console.warn('[SW] 部分资源预缓存失败（可忽略）:', err.message);
        });
      })
      .then(() => {
        console.log('[SW] 安装完成，立即激活');
        // self.skipWaiting() 让新 SW 立即接管，无需等待旧 SW 释放
        return self.skipWaiting();
      })
  );
});

// -------------------- 激活事件 --------------------
// 清理旧版本缓存
self.addEventListener('activate', (event) => {
  console.log('[SW] 激活中...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] 删除旧缓存:', name);
            return caches.delete(name);
          })
      );
    })
    .then(() => {
      console.log('[SW] 激活完成，接管所有页面');
      // clients.claim() 让 SW 立即控制所有打开的页面
      return self.clients.claim();
    })
  );
});

// -------------------- Fetch 事件 --------------------
// Cache-First 策略：优先从缓存获取，缓存未命中时回退到网络
self.addEventListener('fetch', (event) => {
  // 只处理 GET 请求
  if (event.request.method !== 'GET') return;

  // 跳过 chrome-extension 和非 http/https 请求
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith('http')) return;

  // ✅ 修改点：API 与上传图片走网络优先，避免缓存旧上传图或拦截 POST 之外的健康检查资源
  if (url.pathname.startsWith('/uploads/') || ['/ping', '/vapid-public-key'].includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // 缓存命中：直接返回
      if (cachedResponse) {
        return cachedResponse;
      }

      // 缓存未命中：从网络获取并动态加入缓存
      return fetch(event.request).then((networkResponse) => {
        // 只缓存成功的同源响应
        if (!networkResponse || networkResponse.status !== 200 || url.origin !== self.location.origin) {
          return networkResponse;
        }

        // 克隆响应（响应流只能读取一次）
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      }).catch(() => {
        // 网络请求失败（离线），尝试返回离线页面提示
        return new Response('当前处于离线状态，请检查网络连接。', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});

// -------------------- Push 事件 --------------------
/**
 * 接收服务器推送并展示通知
 *
 * 服务器推送的 JSON payload 格式：
 * {
 *   "title": "来自TA的心动信号",       // 通知标题
 *   "body": "TA给你发送了一个心动信号", // 通知正文
 *   "image": "https://...动图URL",      // iOS 锁屏通知显示的动图（关键字段！）
 *   "icon": "/icon.png",               // ✅ 修改点：通知图标统一为根目录新图标
 *   "badge": "/icon.png",              // ✅ 修改点：通知角标统一为根目录新图标，避免旧 /icons/* 缺失
 *   "tag": "heartbeat-signal",         // 通知标签（相同 tag 的通知会合并）
 *   "data": {                          // 自定义数据
 *     "url": "/"                        // 点击通知后打开的 URL
 *   }
 * }
 */
self.addEventListener('push', (event) => {
  console.log('[SW] 收到推送消息');

  // 默认通知标题
  const defaultTitle = '来自TA的心动信号 💗';

  // 默认通知配置（服务器未提供完整数据时的降级方案）
  const defaultGifUrl = self.location.origin + '/heart.gif';

  const defaultOptions = {
    body: 'TA给你发送了一个心动信号~',
    image: defaultGifUrl,
    icon: self.location.origin + '/icon.png',
    badge: self.location.origin + '/icon.png',
    tag: 'heartbeat-signal',
    // ✅ 修改点：通知 data 默认携带 url/gifUrl/image/mediaUrl，便于点击通知后前端打开 GIF 预览
    data: {
      url: self.location.origin + '/',
      gifUrl: defaultGifUrl,
      image: defaultGifUrl,
      mediaUrl: defaultGifUrl
    }
  }; // ✅ 修改点：默认 icon/badge 均改为项目根目录 icon.png，且使用绝对 URL

  // ✅ 修改点：兜底规范化通知图片 URL，确保 image 字段是 HTTPS/http 绝对 URL；iOS 对 data/blob 不会展示
  function normalizeAssetUrl(value, fallback) {
    if (!value || typeof value !== 'string' || /^data:/i.test(value) || /^blob:/i.test(value)) {
      return fallback;
    }
    try {
      const url = new URL(value, self.location.origin);
      if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        url.protocol = 'https:';
      }
      return url.toString();
    } catch {
      return fallback;
    }
  }

  // 解析推送 payload
  let notificationPromise;

  if (event.data) {
    try {
      // 尝试解析 JSON payload
      const payload = event.data.json();
      console.log('[SW] Payload:', payload);

      // 通知标题（iOS 上会粗体显示）
      const title = payload.title || defaultTitle;
      const payloadData = payload.data || {};
      const normalizedImage = normalizeAssetUrl(payload.image || payloadData.image, defaultOptions.image);
      const normalizedMediaUrl = normalizeAssetUrl(payload.mediaUrl || payloadData.mediaUrl, normalizedImage);
      // ✅ 修改点：从 payload 顶层 image/mediaUrl 或 data 中补齐 gifUrl，保留 payload.data 已有字段优先级
      const normalizedGifUrl = normalizeAssetUrl(
        payloadData.gifUrl || payloadData.image || payloadData.mediaUrl || payload.image || payload.mediaUrl,
        normalizedImage
      );

      const notificationOptions = {
        // 通知正文
        body: payload.body || defaultOptions.body,
        // ✅ 修改点：必须读取并传递 payload.image 到 showNotification options.image；GIF 是否动画播放取决于 iOS 系统支持
        image: normalizedImage,
        // 通知左侧图标
        icon: normalizeAssetUrl(payload.icon, defaultOptions.icon),
        // 通知角标图标（iOS 主屏幕 App 图标上的角标）
        badge: normalizeAssetUrl(payload.badge, defaultOptions.badge),
        // ✅ 修改点：使用服务端传来的唯一 tag，避免多次点击按钮后通知被同 tag 合并
        tag: payload.tag || defaultOptions.tag,
        // 自定义数据，在 notificationclick 事件中可用
        data: {
          ...defaultOptions.data,
          ...payloadData,
          url: payloadData.url || defaultOptions.data.url,
          gifUrl: payloadData.gifUrl || normalizedGifUrl,
          image: payloadData.image || normalizedImage,
          mediaUrl: payloadData.mediaUrl || normalizedMediaUrl
        },
        // 通知需要震动（移动端）
        vibrate: [200, 100, 200],
        // 通知需要声音
        silent: false,
        // 要求用户交互（通知不会自动消失）
        requireInteraction: true,
        // iOS 特有：通知重要性级别
        // 使用 'high' 确保即使在专注模式下也能送达
        ...(payload.urgency ? {} : {})
      };

      notificationPromise = self.registration.showNotification(
        title,
        notificationOptions
      ).catch((err) => {
        console.error('[SW] showNotification 失败:', err);
        return self.registration.showNotification(defaultTitle, defaultOptions);
      }); // ✅ 修改点：捕获 showNotification 异常，避免 Promise 未捕获导致推送事件中断
    } catch (err) {
      // JSON 解析失败，尝试使用纯文本 payload
      console.warn('[SW] Payload 非 JSON，使用纯文本:', err.message);
      const textBody = event.data.text();

      // 纯文本 payload：使用默认标题 + 文本作为 body
      const textNotificationOptions = {
        icon: defaultOptions.icon,
        badge: defaultOptions.badge,
        image: defaultOptions.image,
        tag: defaultOptions.tag,
        data: defaultOptions.data,
        vibrate: [200, 100, 200],
        silent: false,
        requireInteraction: true,
        body: textBody || defaultOptions.body
      };
      notificationPromise = self.registration.showNotification(
        defaultTitle,
        textNotificationOptions
      );
    }
  } else {
    // 无 payload 的空推送，使用默认通知
    console.log('[SW] 空 payload，使用默认通知');
    notificationPromise = self.registration.showNotification(
      defaultTitle,
      defaultOptions
    );
  }

  // waitUntil 确保 SW 在通知展示完成前不会被终止
  event.waitUntil(notificationPromise);
});

// -------------------- Notification Click 事件 --------------------
/**
 * 用户点击通知时的处理：
 * 1. 关闭通知
 * 2. 聚焦到已打开的页面，或打开新页面
 * 3. 如果 data.url 存在，导航到指定 URL
 */
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] 通知被点击');

  // 关闭通知
  event.notification.close();

  // 获取通知中携带的自定义数据
  const notificationData = event.notification.data || {};
  const rawTargetUrl = notificationData.url || '/';
  const targetUrl = new URL(rawTargetUrl, self.location.origin); // ✅ 修改点：通知点击 URL 统一为绝对同源地址，兼容 iOS PWA 打开/聚焦
  // ✅ 修改点：从通知 data 中按 gifUrl/image/mediaUrl 优先级取出本次推送 GIF 地址
  const gifUrl = notificationData.gifUrl || notificationData.image || notificationData.mediaUrl || '';

  if (gifUrl) {
    // ✅ 修改点：无已打开窗口时通过 previewGif 查询参数把 GIF 地址传给前端
    targetUrl.searchParams.set('previewGif', gifUrl);
  }

  const targetUrlWithPreview = targetUrl.toString();

  event.waitUntil(
    // 查找是否有已打开的页面窗口
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // 尝试聚焦到已有的同源窗口
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin) && 'focus' in client) {
            if (gifUrl && 'postMessage' in client) {
              // ✅ 修改点：已有页面优先 postMessage 通知前端打开已有 preview-overlay，避免导航破坏页面状态
              client.postMessage({ type: 'OPEN_GIF_PREVIEW', gifUrl });
            }
            return client.focus();
          }
        }
        // 没有已打开的窗口，打开新窗口
        if (clients.openWindow) {
          return clients.openWindow(targetUrlWithPreview);
        }
      })
  );
});

// -------------------- Push Subscription Change 事件 --------------------
/**
 * 推送订阅过期或被服务器端撤销时触发
 * 此处简单记录日志，实际可向服务器发送 unsubscribe 请求
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  console.log('[SW] 推送订阅已变更，请重新订阅');
  // 这里可以通知服务器订阅已失效
  // event.waitUntil(
  //   fetch('/unsubscribe', { method: 'POST', body: JSON.stringify({ ... }) })
  // );
}, false);

console.log('[SW] Service Worker 已加载，等待事件...');