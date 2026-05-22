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
const CACHE_NAME = 'heartbeat-signal-v1';

// 需要预缓存的静态资源列表
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/badge-96.png'
];

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

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // 缓存命中：直接返回
      if (cachedResponse) {
        return cachedResponse;
      }

      // 缓存未命中：从网络获取并动态加入缓存
      return fetch(event.request).then((networkResponse) => {
        // 只缓存成功的响应
        if (!networkResponse || networkResponse.status !== 200) {
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
 *   "icon": "/icons/icon-192.png",     // 通知图标
 *   "badge": "/icons/badge-96.png",    // 通知角标图标
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
  const defaultOptions = {
    body: 'TA给你发送了一个心动信号~',
    image: '/images/default-heartbeat.gif',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: 'heartbeat-signal',
    data: { url: '/' }
  };

  // 解析推送 payload
  let notificationPromise;

  if (event.data) {
    try {
      // 尝试解析 JSON payload
      const payload = event.data.json();
      console.log('[SW] Payload:', payload);

      // 通知标题（iOS 上会粗体显示）
      const title = payload.title || defaultTitle;

      const notificationOptions = {
        // 通知正文
        body: payload.body || defaultOptions.body,
        // === iOS 16.4+ 关键字段 ===
        // image: 通知中展示的图片/GIF，iOS 锁屏通知会显示这张图
        image: payload.image || defaultOptions.image,
        // 通知左侧图标
        icon: payload.icon || defaultOptions.icon,
        // 通知角标图标（iOS 主屏幕 App 图标上的角标）
        badge: payload.badge || defaultOptions.badge,
        // tag: 相同 tag 的通知会替代旧通知而非堆叠
        tag: payload.tag || defaultOptions.tag,
        // 自定义数据，在 notificationclick 事件中可用
        data: payload.data || defaultOptions.data,
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
      );
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
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    // 查找是否有已打开的页面窗口
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // 尝试聚焦到已有的同源窗口
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            // 如果已有窗口且需要导航到特定 URL
            if (targetUrl !== '/') {
              client.navigate(targetUrl);
            }
            return client.focus();
          }
        }
        // 没有已打开的窗口，打开新窗口
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
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