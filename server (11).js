/**
 * SMM Store — пример бэкенда: оплата Stars, профиль (баланс + история),
 * промокоды.
 *
 * Установка:
 *   npm init -y
 *   npm install express node-telegram-bot-api dotenv
 *   node server.js
 *
 * .env:
 *   BOT_TOKEN=123456789:ВАШ_ТОКЕН_ОТ_BOTFATHER
 *   OWNER_CHAT_ID=123456789
 *   PORT=3000
 *   TWIBOOST_API_KEY=ваш_ключ_из_ЛК_twiboost.com   (необязательно — без него автовыдачи не будет)
 *   ADMIN_PASSWORD=придумайте_пароль   (обязательно для доступа к /admin — без него панель отключена)
 *
 * OWNER_CHAT_ID: напишите боту любое сообщение, затем откройте
 * https://api.telegram.org/bot<ВАШ_ТОКЕН>/getUpdates и возьмите message.chat.id.
 *
 * Автовыдача заказов через twiboost.com: нужен Node.js 18+ (используется
 * встроенный fetch). Впишите соответствие ваших услуг ID услуг twiboost в
 * TWIBOOST_SERVICE_MAP ниже — иначе заказы, как и раньше, будут просто
 * приходить вам в чат для ручной обработки.
 *
 * Хранилище: здесь всё в памяти (Map), для реального запуска замените на
 * БД (Postgres/SQLite/Redis) — иначе баланс и история обнулятся при рестарте.
 */

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL; // публичный https-адрес, где хостится index.html
// По умолчанию бот работает БЕЗ Mini App — всё через команды и кнопки в чате
// (см. bot-shop.js). Чтобы вернуть кнопку «Открыть магазин» (Mini App) в меню и
// в /start, задайте MINIAPP_ENABLED=true. WEBAPP_URL при этом нужен и для /admin.
const MINIAPP_ENABLED = String(process.env.MINIAPP_ENABLED || '').toLowerCase() === 'true';
const PORT = process.env.PORT || 3000;
const TWIBOOST_API_KEY = process.env.TWIBOOST_API_KEY; // ключ из личного кабинета twiboost.com → API
const TWIBOOST_API_URL = 'https://twiboost.com/api/v2';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // пароль для /admin — без него панель недоступна

if (!ADMIN_PASSWORD) {
  console.warn(
    'ADMIN_PASSWORD не задан в .env — админ-панель (/admin) будет отвечать 503,\n' +
    'пока вы не зададите пароль и не перезапустите сервер.'
  );
}

// Файл, в котором хранятся балансы/история заказов/использование промокодов —
// переживает перезапуск процесса (в отличие от простого Map в памяти).
// ВАЖНО: на Railway (и аналогичных хостингах) при каждом РЕДЕПЛОЕ контейнер
// пересоздаётся с чистым диском — обычный файл рядом с server.js стирается,
// даже если между обычными рестартами он сохранялся. Чтобы данные
// действительно переживали редеплой, в Railway нужно подключить Volume
// (Service → Settings → Volumes → Add Volume, например с mount path
// "/data"). Как только Volume подключён, Railway сам прокидывает переменную
// окружения RAILWAY_VOLUME_MOUNT_PATH — сервер ниже автоматически положит
// data.json именно туда, никаких других правок не нужно. DATA_FILE в .env
// по-прежнему можно задать вручную, если хотите путь/имя файла другими.
const RAILWAY_VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DATA_FILE = process.env.DATA_FILE
  || (RAILWAY_VOLUME_DIR ? path.join(RAILWAY_VOLUME_DIR, 'data.json') : path.join(__dirname, 'data.json'));

if (!RAILWAY_VOLUME_DIR && !process.env.DATA_FILE) {
  console.warn(
    `ВНИМАНИЕ: данные пишутся в ${DATA_FILE} — это диск контейнера, который\n` +
    'Railway стирает при каждом редеплое. Баланс и история заказов будут\n' +
    'обнуляться и дальше, пока вы не подключите Volume в настройках сервиса\n' +
    '(Settings → Volumes → Add Volume) и не сделаете редеплой — тогда эта\n' +
    'переменная сама переключится на постоянное хранилище.'
  );
}

if (!BOT_TOKEN || !OWNER_CHAT_ID) {
  console.error('Заполните BOT_TOKEN и OWNER_CHAT_ID в .env');
  process.exit(1);
}
if (!TWIBOOST_API_KEY) {
  console.warn(
    'TWIBOOST_API_KEY не задан в .env — автовыдача заказов работать не будет,\n' +
    'заказы будут только приходить вам в чат для ручной обработки, как раньше.'
  );
}
if (!WEBAPP_URL) {
  console.warn(
    'WEBAPP_URL не задан в .env — кнопка открытия Mini App работать не будет.\n' +
    'Укажите публичный https-адрес (например, из Render/Railway/ngrok), где доступен index.html.'
  );
} else if (!/^https:\/\//i.test(WEBAPP_URL)) {
  console.warn('WEBAPP_URL должен начинаться с https:// — Telegram не откроет Mini App по http-ссылке.');
}

const bot = new TelegramBot(BOT_TOKEN, {
  // long polling: 30 c ожидания на стороне Telegram, короткая пауза между запросами.
  // allowed_updates задаём ЯВНО: Telegram запоминает список от последнего запроса,
  // и без callback_query / pre_checkout_query кнопки и оплата Stars молчат.
  polling: {
    autoStart: false, // стартуем вручную ниже, после сброса allowed_updates
    interval: 300,
    params: {
      timeout: 30,
      allowed_updates: JSON.stringify(['message', 'callback_query', 'pre_checkout_query', 'my_chat_member']),
    },
  },
  // keepAlive + принудительный IPv4: на части хостингов (в т.ч. Railway) запросы
  // к api.telegram.org по IPv6 виснут/падают с 502 и ETELEGRAM/EFATAL.
  request: { agentOptions: { keepAlive: true, family: 4 } },
});

// Страховка: одна неудачная отправка сообщения (например, боту закрыли
// личку) не должна ронять весь сервер и уводить его в краш-луп с потерей
// уже оплаченных заказов. Логируем и продолжаем работу.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.message ? err.message : err);
});

/** Повторяет вызов Telegram API при временных сбоях (502/сеть). */
async function withRetry(fn, { tries = 3, delayMs = 700 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries) await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw lastErr;
}

/* Ошибки long polling (502 и т.п.). Пока бот не получает апдейты, он не видит
   pre_checkout_query, и оплата Stars «висит» — поэтому: 1) не засоряем лог
   (одна строка раз в 30 с), 2) при серии ошибок подряд перезапускаем polling —
   это пересоздаёт соединение с Telegram. */
let pollingErrCount = 0;
let lastPollingErrAt = 0;
let lastPollingErrLogAt = 0;
let pollingRestarting = false;
bot.on('polling_error', (err) => {
  pollingErrCount++;
  lastPollingErrAt = Date.now();
  if (Date.now() - lastPollingErrLogAt > 30000) {
    lastPollingErrLogAt = Date.now();
    console.error(`[polling_error] x${pollingErrCount}: ${err && err.code} ${err && err.message}`);
  }
  if (pollingErrCount >= 15 && !pollingRestarting) {
    pollingRestarting = true;
    console.warn('Много ошибок polling подряд — перезапускаю polling');
    Promise.resolve(bot.stopPolling())
      .catch(() => {})
      .then(() => new Promise((r) => setTimeout(r, 5000)))
      .then(() => bot.startPolling())
      .catch((e) => console.error('Не удалось перезапустить polling:', e && e.message))
      .finally(() => { pollingRestarting = false; pollingErrCount = 0; });
  }
});
// Если минуту не было ошибок — считаем, что соединение восстановилось.
setInterval(() => {
  if (pollingErrCount > 0 && Date.now() - lastPollingErrAt > 60000) pollingErrCount = 0;
}, 30000);
/* Telegram запоминает allowed_updates от ПОСЛЕДНЕГО запроса getUpdates, где он был
   указан. Если когда-то токен использовали со списком без callback_query, кнопки
   молчат. Поэтому до старта polling один раз шлём getUpdates со своим списком
   напрямую (не через библиотеку) и пишем в лог, что получилось. */
const WANTED_UPDATES = ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member'];
(async () => {
  const api = (method, params) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await api('getUpdates', { timeout: 0, limit: 1, allowed_updates: WANTED_UPDATES });
      if (!r.ok) throw new Error(JSON.stringify(r));
      const info = await api('getWebhookInfo');
      console.log('allowed_updates у Telegram:', JSON.stringify(info.result && info.result.allowed_updates), '| url:', JSON.stringify(info.result && info.result.url));
      break;
    } catch (err) {
      console.error(`Сброс allowed_updates (попытка ${attempt}) не удался:`, err && err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try { await bot.startPolling(); console.log('Polling запущен'); }
  catch (err) { console.error('Не удалось запустить polling:', err && err.message); }
})();
const app = express();
// Лог каждого запроса к серверу (удобно проверять, доходит ли трафик до приложения).
app.use((req, res, next) => { console.log(req.method, req.url); next(); });
// Для /admin/api/restore тело читаем сырым (там свой парсер с большим лимитом).
app.use((req, res, next) =>
  req.path === '/admin/api/restore' ? next() : express.json()(req, res, next));

/* ---------- Админ-панель (/admin) ----------
   Простая защита паролем через HTTP Basic Auth — без него это отдельный
   логин/сессии, что для панели на одного-двух администраторов избыточно.
   Браузер сам показывает окно ввода пароля и сам пересылает его на все
   последующие запросы к /admin/*, включая fetch() из admin/index.html.
   ВАЖНО: значение ADMIN_PASSWORD передаётся по сети в открытом виде при
   каждом запросе (в заголовке Authorization) — используйте эту панель
   только по https (см. WEBAPP_URL/хостинг), не по обычному http. */
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send('Админ-панель отключена: задайте ADMIN_PASSWORD в .env и перезапустите сервер.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  let password = null;
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    password = sepIdx === -1 ? decoded : decoded.slice(sepIdx + 1);
  }
  if (password !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="SMM Store Admin"');
    return res.status(401).send('Требуется пароль администратора');
  }
  next();
}
app.use('/admin', adminAuth);

/* ---------- Разовое восстановление data.json (/admin/api/restore) ----------
   Принимает содержимое data.json в теле POST-запроса, пишет его в DATA_FILE
   (на volume) и сразу перечитывает в память. После переноса удалите. */
app.post('/admin/api/restore', express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
  try {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.users)) {
      return res.status(400).send('Неверный формат: в файле нет массива users');
    }
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak-' + Date.now());
    fs.writeFileSync(DATA_FILE + '.tmp', text, 'utf8');
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    users.clear(); pendingOrders.clear(); withdrawalRequests.clear(); processedCharges.clear();
    loadData();
    res.json({ ok: true, users: users.size, pendingOrders: pendingOrders.size });
  } catch (err) {
    res.status(400).send('Ошибка восстановления: ' + err.message);
  }
});

app.get('/admin/api/stats', (req, res) => {
  let ordersCount = 0;
  let totalRevenue = 0;
  for (const user of users.values()) {
    ordersCount += user.orders.length;
    for (const order of user.orders) totalRevenue = round2(totalRevenue + (order.total || 0));
  }
  res.json({
    usersCount: users.size,
    ordersCount,
    totalRevenue,
    pendingManualCount: getPendingManualItems().length,
  });
});

/** Список всех заказов по всем пользователям (для общей вкладки "Заказы").
 *  Необязательные query-параметры: status (точное совпадение), limit. */
app.get('/admin/api/orders', (req, res) => {
  const { status, limit } = req.query;
  const rows = [];
  for (const [userId, user] of users) {
    const buyer = user.username ? '@' + user.username : (user.firstName || String(userId));
    for (const order of user.orders) {
      if (status && order.status !== status) continue;
      rows.push({ ...order, userId, buyer });
    }
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const capped = limit ? rows.slice(0, Number(limit) || rows.length) : rows;
  res.json({ orders: capped, total: rows.length });
});

/** Ручное изменение статуса произвольного заказа (например, отметить
 *  "Выполнен" по заказу, который выдавался вручную не через раздел
 *  Premium Реакции). */
app.post('/admin/api/orders/:userId/:orderId/status', (req, res) => {
  const { status } = req.body;
  if (!status || typeof status !== 'string') return res.status(400).json({ error: 'Не передан статус' });
  const user = users.get(Number(req.params.userId)) || users.get(req.params.userId);
  const order = user && user.orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  order.status = status;
  saveData();
  res.json({ success: true, order });
});

/** Очередь Premium Реакций (и других услуг из MANUAL_FULFILLMENT_SERVICE_IDS) —
 *  позиции заказов, ещё не отмеченные выданными, плюс готовый текст
 *  в формате "1. ссылка × кол-во" для копирования. */
app.get('/admin/api/premium-reactions', (req, res) => {
  const items = getPendingManualItems();
  res.json({ items, text: formatManualFulfillmentText(items) });
});

/** Прислать текущую очередь Premium Реакций себе в Telegram (OWNER_CHAT_ID)
 *  тем же ботом — удобно, если проще читать список в телефоне, чем в браузере. */
app.post('/admin/api/premium-reactions/notify', async (req, res) => {
  const items = getPendingManualItems();
  const text = formatManualFulfillmentText(items);
  try {
    await bot.sendMessage(OWNER_CHAT_ID, `✋ Очередь на ручную выдачу (Premium Реакции):\n\n${text}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Не удалось отправить очередь ручной выдачи:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Отметить одну позицию/заказ выданными — заказ целиком пропадает из
 *  очереди Premium Реакций (упрощение: если в заказе была всего одна
 *  услуга для ручной выдачи, что почти всегда и есть). Статус заказа в
 *  истории покупателя тоже обновляется. */
app.post('/admin/api/premium-reactions/mark-done', (req, res) => {
  const { userId, orderId } = req.body;
  const user = users.get(Number(userId)) || users.get(userId);
  const order = user && user.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  order.fulfilledManually = true;
  order.status = 'Выдано вручную';
  saveData();
  res.json({ success: true });
});

/* ---------- Рассылка (/admin/api/broadcast) ----------
   Отправляет текстовое сообщение всем известным пользователям бота
   (всем ключам из users). Идёт в фоне асинхронно — панель сразу
   получает ответ "started" и дальше опрашивает прогресс отдельным
   запросом (/admin/api/broadcast/status), т.к. на большой базе
   пользователей сама отправка может занять минуты.
   Между сообщениями — небольшая пауза (~20/сек), чтобы не упереться
   в лимит Telegram (около 30 сообщений в секунду разным чатам) и не
   получить 429 Too Many Requests. Если пользователь заблокировал
   бота — просто считаем как "не доставлено" и идём дальше, это
   ожидаемо для части базы. */
let broadcastState = {
  running: false,
  total: 0,
  sent: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

app.post('/admin/api/broadcast/start', (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Пустой текст рассылки' });
  }
  if (broadcastState.running) {
    return res.status(409).json({ error: 'Рассылка уже выполняется, дождитесь её завершения' });
  }
  const userIds = [...users.keys()];
  broadcastState = {
    running: true,
    total: userIds.length,
    sent: 0,
    failed: 0,
    startedAt: Date.now(),
    finishedAt: null,
  };
  res.json({ success: true, total: userIds.length });

  (async () => {
    for (const userId of userIds) {
      try {
        await bot.sendMessage(userId, text);
        broadcastState.sent++;
      } catch (err) {
        broadcastState.failed++;
      }
      await sleep(50);
    }
    broadcastState.running = false;
    broadcastState.finishedAt = Date.now();
  })().catch(err => {
    console.error('Ошибка рассылки:', err.message);
    broadcastState.running = false;
    broadcastState.finishedAt = Date.now();
  });
});

/** Прогресс текущей/последней рассылки — панель опрашивает это,
 *  пока running === true. */
app.get('/admin/api/broadcast/status', (req, res) => {
  res.json(broadcastState);
});

app.use(express.static(__dirname)); // раздаёт index.html как есть

/* ---------- Каталог (дублируем с фронтендом) ----------
   Цена и сумма ВСЕГДА пересчитываются здесь из qty — клиенту нельзя
   доверять присланную цену, иначе её можно подменить в консоли браузера.
   Сам каталог — в services-catalog.js (Telegram, собрано автоматически из
   вашего аккаунта twiboost, наценка +10% к цене уже применена). Чтобы
   обновить цены/категории — см. инструкцию в начале того файла.

   Другие "сети" (например TikTok) живут в отдельных файлах такого же
   формата (tiktok-services-catalog.js) и генерируются скриптом
   fetch-twiboost-services.js — см. инструкцию в начале того скрипта.
   Каталоги объединяются здесь: если файл сети ещё не сгенерирован,
   просто пропускаем его (сайт продолжит работать с тем, что есть). */
const telegramCatalog = require('./services-catalog');
const catalogFiles = ['./tiktok-services-catalog', './facebook-services-catalog', './instagram-services-catalog', './max-services-catalog', './discord-services-catalog', './youtube-services-catalog']; // добавляйте сюда новые сети по мере генерации
const SERVICES = { ...telegramCatalog.SERVICES };
const TWIBOOST_SERVICE_MAP = { ...telegramCatalog.TWIBOOST_SERVICE_MAP };
for (const file of catalogFiles) {
  try {
    const cat = require(file);
    Object.assign(SERVICES, cat.SERVICES);
    Object.assign(TWIBOOST_SERVICE_MAP, cat.TWIBOOST_SERVICE_MAP);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    console.warn(`Каталог ${file} ещё не сгенерирован — раздел будет пуст, пока вы не запустите fetch-twiboost-services.js`);
  }
}

/* ---------- Промокоды ----------
   Промокод больше не даёт скидку на заказ — при активации он сразу
   зачисляет фиксированное количество Stars на баланс покупателя.
   uses/redeemedBy — общий счётчик использований и список ID уже
   воспользовавшихся (каждый пользователь может применить код один раз,
   пока не кончится общий лимit maxUses). Хранится в памяти — как и
   users/pendingOrders, при рестарте сервера обнуляется (см. комментарий
   про Map выше по файлу — для прода нужна БД). */
const BALANCE_PROMO_CODES = {
  WAVEFLAIR: { value: 20, maxUses: 10, uses: 0, redeemedBy: new Set(), label: 'Промокод WAVEFLAIR — +20 ⭐ на баланс' },
};

// Канал, подписка на который обязательна для использования магазина.
// ВАЖНО: чтобы проверка подписки работала, бот должен быть добавлен
// администратором канала @yanvismokcoded (иначе Bot API вернёт ошибку
// на getChatMember, и это будет видно в логах сервера).
const NEWS_CHANNEL = '@yanvismokcoded';
const SUPPORT_USERNAME = '@loserpilled';

/* ---------- Услуги для ручной выдачи (Premium Реакции) ----------
   Для этих serviceId автовыдача через twiboost НЕ запускается, даже если
   для них есть мапинг в TWIBOOST_SERVICE_MAP, — заказ остаётся в статусе
   "Ожидает ручной выдачи" и попадает в раздел "Premium Реакции" в
   админ-панели (/admin), откуда список для выдачи можно скопировать или
   прислать себе в Telegram в формате "1. ссылка × кол-во".
   Список составлен по services-catalog.js / index.html — все позиции с
   "Premium" в названии из категории "Реакции". Отредактируйте под себя:
   добавьте свой serviceId (см. id в каталоге) или уберите лишние. */
const MANUAL_FULFILLMENT_SERVICE_IDS = new Set([
  'telegram_реакции_premium_кастомные',
  'telegram_реакции_с_premium_аккаунтов_микс_реакций',
  'telegram_реакции_с_premium_аккаунтов_микс_реакций_4475',
  'telegram_реакции_с_premium_аккаунтов_реакция',
  'telegram_реакции_с_premium_аккаунтов_реакция_4477',
  'telegram_реакции_с_premium_аккаунтов_реакция_4478',
]);

// userId -> { balance, orders: [], username?, firstName? }
const users = new Map();
function getUser(id) {
  if (!users.has(id)) users.set(id, { balance: 0, orders: [] });
  return users.get(id);
}

/** Как getUser, но заодно запоминает username/имя из данных Telegram —
 *  чтобы в админ-панели покупателя можно было узнать и написать ему,
 *  а не только видеть числовой id. */
function touchUser(tgUser) {
  const user = getUser(tgUser.id);
  if (tgUser.username) user.username = tgUser.username;
  if (tgUser.first_name) user.firstName = tgUser.first_name;
  return user;
}

// orderId -> { userId, items, subtotal, promoCode, balanceUsed, finalTotal }
const pendingOrders = new Map();
// Каждому «заказу в процессе оплаты» ставим время создания: сохраняем их в
// data.json (переживают рестарт), а просроченные (>48 ч) отбрасываем.
const PENDING_TTL_MS = 48 * 3600 * 1000;
const _pendingSet = pendingOrders.set.bind(pendingOrders);
pendingOrders.set = (key, value) => {
  if (value && !value.createdAt) value.createdAt = Date.now();
  return _pendingSet(key, value);
};
// telegram_payment_charge_id уже обработанных платежей — защита от двойного
// зачисления, если Telegram доставит successful_payment повторно после рестарта.
const processedCharges = new Set();

// requestId -> { id, userId, orderId, amount, status: 'pending'|'paid'|'declined', createdAt }
// Заявки пользователей на вывод баланса — деньги СРАЗУ списываются с баланса
// (чтобы нельзя было создать вторую заявку на те же средства), а сама
// выплата делается владельцем вручную (переводом/звёздами лично, вне Bot
// API — см. обсуждение в README про sendGift) после нажатия кнопки в чате.
const withdrawalRequests = new Map();
const MIN_WITHDRAW_AMOUNT = 50; // минимальная сумма заявки на вывод, в ⭐

/* ---------- Персистентное хранилище (файл data.json) ----------
   Раньше users и статистика промокодов жили только в оперативной памяти
   (Map/Set) — при каждом рестарте процесса (деплой, падение, "засыпание"
   на бесплатном хостинге) баланс и история заказов у всех пользователей
   обнулялись. Теперь состояние загружается из файла при старте и
   сохраняется на диск после каждого изменения. pendingOrders (заказы в процессе оплаты) тоже сохраняются — иначе
   рестарт между созданием инвойса и оплатой терял заказ. */
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(raw.users)) {
      for (const [id, u] of raw.users) {
        const user = { balance: u.balance || 0, orders: Array.isArray(u.orders) ? u.orders : [] };
        if (u.username) user.username = u.username;
        if (u.firstName) user.firstName = u.firstName;
        users.set(id, user);
      }
    }
    if (raw.promoState) {
      for (const [code, state] of Object.entries(raw.promoState)) {
        if (BALANCE_PROMO_CODES[code]) {
          BALANCE_PROMO_CODES[code].uses = state.uses || 0;
          BALANCE_PROMO_CODES[code].redeemedBy = new Set(state.redeemedBy || []);
        }
      }
    }
    if (Array.isArray(raw.withdrawalRequests)) {
      for (const [id, w] of raw.withdrawalRequests) withdrawalRequests.set(id, w);
    }
    if (Array.isArray(raw.pendingOrders)) {
      for (const [id, o] of raw.pendingOrders) {
        if (Date.now() - (o.createdAt || 0) < PENDING_TTL_MS) pendingOrders.set(id, o);
      }
    }
    if (Array.isArray(raw.processedCharges)) {
      for (const c of raw.processedCharges) processedCharges.add(c);
    }
    console.log(`Данные загружены из ${DATA_FILE}: пользователей ${users.size}, ожидающих оплаты ${pendingOrders.size}`);
  } catch (err) {
    console.error(`Не удалось загрузить ${DATA_FILE}, стартуем с чистого состояния:`, err.message);
  }
}

function saveData() {
  try {
    const promoState = {};
    for (const [code, promo] of Object.entries(BALANCE_PROMO_CODES)) {
      promoState[code] = { uses: promo.uses, redeemedBy: [...promo.redeemedBy] };
    }
    const payload = JSON.stringify(
      {
        users: [...users.entries()],
        promoState,
        withdrawalRequests: [...withdrawalRequests.entries()],
        pendingOrders: [...pendingOrders.entries()].filter(([, o]) => Date.now() - (o.createdAt || 0) < PENDING_TTL_MS),
        processedCharges: [...processedCharges].slice(-2000),
      },
      null,
      2
    );
    // На случай, если целевая директория (например, только что подключённый
    // volume) ещё не существует на диске — создаём её, иначе запись упадёт.
    const dir = path.dirname(DATA_FILE);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Пишем во временный файл и переименовываем — так при падении сервера
    // ровно в момент записи старые данные не окажутся повреждены/обрезаны.
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error(`Не удалось сохранить ${DATA_FILE}:`, err.message);
  }
}

loadData();

/** Официальная проверка подписи initData от Telegram Mini Apps.
 *  https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

// Округление до копеек/сотых звезды — убирает мусор от float-арифметики
// (0.1+0.2 и т.п.), но НЕ округляет цену до целой звезды. Целые Stars
// нужны только в момент выставления инвойса (см. ниже).
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function recomputeSubtotal(items) {
  return round2(items.reduce((sum, i) => sum + itemPrice(i), 0));
}

/** Точная цена одной позиции корзины (без округления по всей корзине) —
 *  нужна, чтобы вернуть на баланс именно долю той позиции, которую не
 *  удалось создать в панели twiboost. */
function itemPrice(item) {
  const svc = SERVICES[item.serviceId];
  if (!svc) return 0;
  const qty = Math.min(svc.max, Math.max(svc.min, Number(item.qty) || svc.min));
  return round2((qty / 1000) * svc.price1000);
}

/** Проверка подписки пользователя на новостной канал (обязательное условие
 *  для пользования магазином). Требует, чтобы бот был администратором
 *  канала NEWS_CHANNEL — иначе getChatMember вернёт ошибку доступа. */
async function isSubscribed(userId) {
  try {
    const member = await withRetry(() => bot.getChatMember(NEWS_CHANNEL, userId), { tries: 2, delayMs: 500 });
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (err) {
    console.error('Не удалось проверить подписку на канал:', err && err.message);
    return false;
  }
}

/* ---------- Профиль: баланс + история заказов ---------- */
app.get('/api/profile', (req, res) => {
  const tgUser = verifyInitData(req.query.initData);
  if (!tgUser) return res.status(401).json({ error: 'Не удалось проверить пользователя' });
  const user = touchUser(tgUser);
  res.json({ balance: user.balance, orders: user.orders, supportUsername: SUPPORT_USERNAME });
});

/* ---------- Проверка обязательной подписки на канал ---------- */
app.get('/api/check-subscription', async (req, res) => {
  const tgUser = verifyInitData(req.query.initData);
  if (!tgUser) return res.status(401).json({ error: 'Не удалось проверить пользователя' });
  const subscribed = await isSubscribed(tgUser.id);
  res.json({ subscribed, channel: NEWS_CHANNEL });
});

/* ---------- Промокод: зачисление Stars на баланс ---------- */
app.post('/api/redeem-promo', async (req, res) => {
  const { code, initData } = req.body;
  const tgUser = verifyInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Не удалось проверить пользователя' });
  if (!(await isSubscribed(tgUser.id))) {
    return res.status(403).json({ error: 'subscription_required', message: `Подпишитесь на ${NEWS_CHANNEL}, чтобы использовать промокод`, channel: NEWS_CHANNEL });
  }

  const key = String(code || '').trim().toUpperCase();
  const promo = BALANCE_PROMO_CODES[key];
  if (!promo) return res.json({ success: false, message: 'Такого промокода нет' });
  if (promo.redeemedBy.has(tgUser.id)) {
    return res.json({ success: false, message: 'Вы уже использовали этот промокод' });
  }
  if (promo.uses >= promo.maxUses) {
    return res.json({ success: false, message: 'Промокод исчерпан — закончились использования' });
  }

  promo.uses += 1;
  promo.redeemedBy.add(tgUser.id);

  const user = touchUser(tgUser);
  user.balance = round2(user.balance + promo.value);
  user.orders.unshift({
    id: crypto.randomUUID(),
    userId: tgUser.id,
    date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
    items: [{ name: `Промокод ${key}`, qty: 1 }],
    link: '',
    total: promo.value,
    status: 'Начислено',
  });
  saveData();

  res.json({
    success: true,
    message: `+${promo.value} ⭐ зачислено на баланс`,
    balance: user.balance,
    remaining: promo.maxUses - promo.uses,
  });
});

/* ---------- Создание инвойса ---------- */
app.post('/api/create-invoice', async (req, res) => {
  try {
    const { items, initData } = req.body;
    const tgUser = verifyInitData(initData);
    if (!tgUser) return res.status(401).json({ error: 'Не удалось проверить пользователя' });
    if (!(await isSubscribed(tgUser.id))) {
      return res.status(403).json({ error: 'subscription_required', message: `Подпишитесь на ${NEWS_CHANNEL}, чтобы оформить заказ`, channel: NEWS_CHANNEL });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Корзина пуста' });
    }

    const user = touchUser(tgUser);
    const subtotal = recomputeSubtotal(items);
    const finalTotal = subtotal; // скидок по промокоду больше нет — цена заказа не меняется
    // Баланс списывается автоматически на каждый заказ, если на нём есть
    // средства — раньше это зависело от переключателя на клиенте, из-за
    // чего покупатели путались и платили Stars, забыв его включить. Теперь
    // решение принимается на сервере и клиентский флаг ни на что не влияет.
    const balanceUsed = Math.min(user.balance, finalTotal);
    const total = round2(Math.max(0, finalTotal - balanceUsed));

    const orderId = 'order_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // Если баланса хватило на всю сумму — платить Stars не нужно,
    // списываем баланс сразу и не создаём инвойс.
    if (total <= 0) {
      pendingOrders.set(orderId, { type: 'order', userId: tgUser.id, items, subtotal, balanceUsed, finalTotal: total, starsCharged: 0, roundingCredit: 0 });
      user.balance = round2(user.balance - balanceUsed);
      const historyEntry = orderToHistoryEntry(tgUser.id, items, subtotal, 'Оплачен', balanceUsed);
      user.orders.unshift(historyEntry);
      pendingOrders.delete(orderId);
      saveData();
      await notifyOwner(tgUser, items, subtotal, 'баланс, без Stars');
      await fulfillOrder(historyEntry, items);
      return res.json({ invoiceLink: null, orderId, paidWithBalanceOnly: true });
    }

    // Telegram Stars (XTR) принимают только ЦЕЛОЕ число звёзд в инвойсе —
    // дробную сумму выставить нельзя. Поэтому округляем сумму к оплате
    // ВВЕРХ до целой звезды (чтобы магазин никогда не терял на округлении),
    // а разницу между тем, что реально списалось, и точной ценой заказа
    // (roundingCredit) зачисляем покупателю на баланс сразу после успешной
    // оплаты — раньше эта разница просто пропадала.
    const starsCharged = Math.max(1, Math.ceil(total - 1e-9));
    const roundingCredit = round2(starsCharged - total);

    pendingOrders.set(orderId, { type: 'order', userId: tgUser.id, items, subtotal, balanceUsed, finalTotal: total, currency: 'XTR', providerLabel: 'Stars', starsCharged, roundingCredit });

    const description = items.map(i => `${i.name} × ${i.qty}`).join(', ').slice(0, 250);
    const invoiceLink = await withRetry(() => bot.createInvoiceLink(
      'Продвижение в Telegram',
      description,
      orderId,
      '',        // provider_token — пусто для Stars
      'XTR',     // currency — обязательно XTR для Stars
      [{ label: 'Заказ', amount: starsCharged }] // для Stars — ровно один элемент, целое число
    ));
    saveData(); // сохраняем ожидающий оплаты заказ на диск (переживёт рестарт)

    res.json({ invoiceLink, orderId });
  } catch (err) {
    console.error('create-invoice error:', err);
    res.status(500).json({ error: 'Не удалось создать инвойс' });
  }
});

/* ---------- Пополнение баланса (без товаров, просто зачисление Stars) ---------- */
app.post('/api/create-topup-invoice', async (req, res) => {
  try {
    const { amount, initData } = req.body;
    const tgUser = verifyInitData(initData);
    if (!tgUser) return res.status(401).json({ error: 'Не удалось проверить пользователя' });
    if (!(await isSubscribed(tgUser.id))) {
      return res.status(403).json({ error: 'subscription_required', message: `Подпишитесь на ${NEWS_CHANNEL}, чтобы пополнить баланс`, channel: NEWS_CHANNEL });
    }

    const stars = Math.round(Number(amount));
    if (!Number.isFinite(stars) || stars <= 0 || stars > 100000) {
      return res.status(400).json({ error: 'Некорректная сумма' });
    }

    const orderId = 'topup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    pendingOrders.set(orderId, { type: 'topup', userId: tgUser.id, amount: stars, currency: 'XTR', providerLabel: 'Stars' });

    const invoiceLink = await withRetry(() => bot.createInvoiceLink(
      'Пополнение баланса',
      `Пополнение баланса SMM Store на ${stars} ⭐`,
      orderId,
      '',     // provider_token — пусто для Stars
      'XTR',  // currency — обязательно XTR для Stars
      [{ label: 'Пополнение', amount: stars }]
    ));
    saveData();

    res.json({ invoiceLink, orderId });
  } catch (err) {
    console.error('create-topup-invoice error:', err);
    res.status(500).json({ error: 'Не удалось создать инвойс' });
  }
});

/* ---------- Заявка на вывод баланса ---------- *
 * ВАЖНО: Telegram Bot API не даёт боту переводить Stars со своего баланса
 * произвольному пользователю — sendGift лишь дарит подарок, который
 * получатель НЕ может обменять обратно на звёзды. Поэтому реальная выплата
 * делается владельцем вручную (см. кнопки в уведомлении ниже), а этот
 * эндпоинт только принимает заявку и списывает сумму с баланса, чтобы её
 * нельзя было потратить дважды, пока заявка обрабатывается. */
app.post('/api/withdraw-request', async (req, res) => {
  const { amount, initData } = req.body;
  const tgUser = verifyInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Не удалось проверить пользователя' });
  const user = touchUser(tgUser);

  const requested = round2(Number(amount));
  if (!Number.isFinite(requested) || requested <= 0) {
    return res.status(400).json({ error: 'invalid_amount', message: 'Укажите сумму вывода' });
  }
  if (requested < MIN_WITHDRAW_AMOUNT) {
    return res.status(400).json({ error: 'too_small', message: `Минимальная сумма вывода — ${MIN_WITHDRAW_AMOUNT} ⭐` });
  }
  if (requested > user.balance) {
    return res.status(400).json({ error: 'insufficient_balance', message: 'Недостаточно средств на балансе' });
  }
  const hasPending = [...withdrawalRequests.values()].some(w => w.userId === tgUser.id && w.status === 'pending');
  if (hasPending) {
    return res.status(409).json({ error: 'pending_exists', message: 'У вас уже есть заявка на вывод в обработке' });
  }

  user.balance = round2(user.balance - requested);
  const historyEntry = {
    id: crypto.randomUUID(),
    userId: tgUser.id,
    date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
    createdAt: Date.now(),
    items: [{ name: 'Заявка на вывод', qty: requested, serviceId: null, link: null }],
    link: '',
    total: requested,
    status: 'Заявка на вывод',
    refundAmount: 0,
    refunded: false,
  };
  user.orders.unshift(historyEntry);

  const requestId = crypto.randomUUID();
  withdrawalRequests.set(requestId, {
    id: requestId,
    userId: tgUser.id,
    orderId: historyEntry.id,
    amount: requested,
    status: 'pending',
    createdAt: Date.now(),
  });
  saveData();

  try {
    await bot.sendMessage(
      OWNER_CHAT_ID,
      `💸 Заявка на вывод ${requested} ⭐\n` +
        `Пользователь: ${tgUser.first_name || ''} ${tgUser.username ? '@' + tgUser.username : '(id ' + tgUser.id + ')'}\n\n` +
        `Выплатите вручную (лично звёздами/переводом), затем нажмите «Выплатил». ` +
        `«Отклонить» вернёт сумму на баланс пользователя.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Выплатил', callback_data: `wd_paid_${requestId}` },
            { text: '❌ Отклонить', callback_data: `wd_decline_${requestId}` },
          ]],
        },
      }
    );
  } catch (err) {
    console.error('Не удалось отправить заявку на вывод владельцу:', err.message);
  }

  res.json({ ok: true, balance: user.balance });
});

function orderToHistoryEntry(userId, items, total, status, refundAmount = 0) {
  return {
    id: crypto.randomUUID(),
    userId,
    date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
    // Числовая метка времени — для сортировки заказов в админ-панели
    // (date — просто "28 авг", по ней год/порядок в течение дня не разобрать).
    createdAt: Date.now(),
    // serviceId и link на каждой позиции (а не только общей строкой link
    // ниже) нужны, чтобы админ-панель могла собрать выдачу по конкретной
    // услуге (например, Premium Реакции) даже если в заказе несколько
    // разных позиций сразу.
    items: items.map(i => ({ name: i.name, qty: i.qty, serviceId: i.serviceId, link: i.link })),
    link: items.map(i => i.link).join(', '),
    total,
    status,
    // Сколько всего было реально уплачено за заказ (баланс + Stars) —
    // справочное поле для истории/аудита. Возврат при ошибке/отмене на
    // стороне поставщика теперь считается и начисляется ПОЗИЦИЮ ЗА
    // ПОЗИЦИЕЙ, по цене конкретной услуги (см. twiboostOrders и
    // pollTwiboostStatuses) — а не одной суммой на весь заказ, чтобы при
    // сбое одной услуги из корзины не возвращались деньги за остальные,
    // которые выполняются нормально.
    refundAmount,
    refunded: false,
    // Отмечается true из админ-панели, когда позиции для ручной выдачи
    // (см. MANUAL_FULFILLMENT_SERVICE_IDS) фактически выданы вручную —
    // после этого заказ пропадает из очереди "Premium Реакции".
    fulfilledManually: false,
  };
}

/* ---------- Автовыдача через API twiboost.com ---------- */

/** Один запрос к API панели (form-urlencoded, как требует twiboost). */
async function twiboostRequest(params) {
  // Панель иногда отдаёт HTML (страница ошибки/Cloudflare/техработы) вместо
  // JSON — раньше это превращалось в загадочное "Unexpected token <".
  // Теперь читаем ответ как текст, парсим сами и пишем в ошибку HTTP-статус.
  // Повторяем до 3 раз. Но 'add' создаёт заказ и списывает деньги в панели,
  // поэтому его НЕ повторяем при таймауте/обрыве (заказ мог уже создаться →
  // дубль), только когда панель явно отдала ошибку сервера (5xx/429).
  const isAdd = params.action === 'add';
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let retryable = false;
    try {
      let res;
      try {
        res = await fetch(TWIBOOST_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ key: TWIBOOST_API_KEY, ...params }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (netErr) {
        retryable = !isAdd;
        throw new Error(`twiboost недоступен: ${netErr.message}`);
      }
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        retryable = !isAdd || res.status >= 500 || res.status === 429;
        const snippet = text.slice(0, 80).replace(/\s+/g, ' ').trim();
        throw new Error(`twiboost вернул не JSON (HTTP ${res.status}): ${snippet}`);
      }
      if (data && data.error) { retryable = false; throw new Error(data.error); }
      return data;
    } catch (err) {
      lastErr = err;
      if (!retryable || attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

/** Создать заказ в twiboost. Возвращает numeric order id панели. */
async function createTwiboostOrder(serviceId, link, quantity) {
  const data = await twiboostRequest({
    action: 'add',
    service: String(serviceId),
    link,
    quantity: String(quantity),
  });
  return data.order;
}

/** Статусы пачки заказов одним запросом: {orderId: {status, remains, ...}} */
async function getTwiboostStatuses(orderIds) {
  if (orderIds.length === 0) return {};
  const data = await twiboostRequest({ action: 'status', orders: orderIds.join(',') });
  // API отдаёт массив [{order, status, ...}] или объект {orderId: {...}} —
  // приводим к единому виду {orderId: {...}}.
  if (Array.isArray(data)) {
    const map = {};
    for (const row of data) map[row.order] = row;
    return map;
  }
  return data;
}

// historyEntryId -> { userId, twiboostOrders: [{id,name,qty,link,price,status}] } — что опрашивается на статус
const pollingOrders = new Map();

/** После рестарта восстанавливаем опрос статусов: ищем в истории заказы, у
 *  которых есть позиции twiboost в статусе 'processing'. Раньше pollingOrders
 *  жил только в памяти — после каждого рестарта такие заказы зависали
 *  «в обработке» навсегда, а возврат при отмене поставщиком не срабатывал. */
function restorePollingOrders() {
  let restored = 0;
  for (const [userId, user] of users) {
    for (const entry of user.orders) {
      const list = entry.twiboostOrders;
      if (Array.isArray(list) && list.some((o) => o.status === 'processing')) {
        pollingOrders.set(entry.id, { userId, twiboostOrders: list });
        restored++;
      }
    }
  }
  if (restored) console.log(`Восстановлен опрос статусов twiboost для заказов: ${restored}`);
}
restorePollingOrders();

/** Пытается автоматически выдать каждую позицию заказа через twiboost.
 *  Позиции, для которых нет мапинга в TWIBOOST_SERVICE_MAP, или те, что
 *  упали с ошибкой API, просто остаются на ручную обработку — как и раньше,
 *  вы уже получили уведомление в чат через notifyOwner(). */
async function fulfillOrder(historyEntry, items) {
  // Заказы с услугами для ручной выдачи (Premium Реакции и т.п.) должны
  // получить понятный статус независимо от того, настроена ли автовыдача
  // twiboost вообще — сама очередь в /admin строится по serviceId в
  // items, а не по этому статусу, но статус в истории заказов у
  // покупателя тоже должен быть осмысленным, а не просто "Оплачен".
  if (items.length > 0 && items.every(i => MANUAL_FULFILLMENT_SERVICE_IDS.has(i.serviceId))) {
    historyEntry.status = 'Ожидает ручной выдачи';
    saveData();
  }

  if (!TWIBOOST_API_KEY) return; // автовыдача не настроена — молча пропускаем

  // Каждая успешно созданная в twiboost заявка отслеживается отдельно —
  // со своей ценой, ссылкой и статусом. Это важно для заказов из
  // нескольких позиций сразу: если поставщик потом отменит/провалит ОДНУ
  // из них, на баланс должна вернуться цена именно этой позиции, а не
  // всего заказа (см. pollTwiboostStatuses).
  const twiboostOrders = [];
  const results = [];
  let failedAmount = 0; // сумма позиций, для которых заявка не создалась из-за ошибки API

  for (const item of items) {
    if (MANUAL_FULFILLMENT_SERVICE_IDS.has(item.serviceId)) {
      // Эта услуга всегда выдаётся вручную (см. MANUAL_FULFILLMENT_SERVICE_IDS) —
      // не отправляем в twiboost, даже если для неё есть мапинг. Заказ
      // найдётся в разделе "Premium Реакции" в /admin.
      results.push(`✋ ${item.name} — услуга для ручной выдачи, см. раздел "Premium Реакции" в /admin`);
      continue;
    }
    const twiboostServiceId = TWIBOOST_SERVICE_MAP[item.serviceId];
    if (!twiboostServiceId) {
      results.push(`⚠️ ${item.name} — нет мапинга на услугу twiboost, выдайте вручную`);
      continue;
    }
    try {
      const orderId = await createTwiboostOrder(twiboostServiceId, item.link, item.qty);
      twiboostOrders.push({
        id: orderId, name: item.name, qty: item.qty, link: item.link,
        price: itemPrice(item), status: 'processing',
      });
      results.push(`✅ ${item.name} — заявка twiboost #${orderId} создана`);
    } catch (err) {
      console.error('twiboost create order error:', err.message);
      results.push(`❌ ${item.name} — ошибка автовыдачи (${err.message}), выдайте вручную`);
      // Заявка вообще не ушла в панель (например, не хватает денег на
      // балансе twiboost) — в отличие от уже отправленных заявок, эта
      // позиция никогда не попадёт в опрос статуса (pollTwiboostStatuses
      // отслеживает только twiboostOrders), поэтому возвращаем деньги
      // за неё прямо сейчас, а не ждём несуществующего статуса.
      failedAmount = round2(failedAmount + itemPrice(item));
    }
  }

  historyEntry.twiboostOrders = twiboostOrders;

  if (failedAmount > 0) {
    const buyer = users.get(historyEntry.userId);
    if (buyer) {
      buyer.balance = round2(buyer.balance + failedAmount);

      bot.sendMessage(
        historyEntry.userId,
        `⚠️ По части вашего заказа произошла ошибка на стороне поставщика, поэтому мы вернули ${failedAmount} ⭐ на ваш баланс. Приносим извинения за неудобства.`
      ).catch(err => console.error('Не удалось уведомить пользователя о возврате:', err.message));
    }
  }

  // Позиции, помеченные на ручную выдачу, — не ошибка, поэтому если ВСЕ
  // "недостающие до items.length" позиции объясняются именно этим (а не
  // сбоем API), даём отдельный, не тревожный статус.
  const manualCount = items.filter(i => MANUAL_FULFILLMENT_SERVICE_IDS.has(i.serviceId)).length;

  if (twiboostOrders.length === items.length) {
    historyEntry.status = 'В обработке (авто)';
  } else if (failedAmount > 0) {
    historyEntry.status = `Требует внимания — ${failedAmount} ⭐ автоматически возвращены на баланс`;
  } else if (manualCount > 0 && twiboostOrders.length + manualCount === items.length) {
    historyEntry.status = 'Ожидает ручной выдачи';
  } else {
    historyEntry.status = 'Требует внимания';
  }

  saveData();

  // Ставим на опрос статуса СРАЗУ после сохранения (до отправки сообщений).
  if (twiboostOrders.length > 0) {
    pollingOrders.set(historyEntry.id, { userId: historyEntry.userId, twiboostOrders });
  }

  try {
    await bot.sendMessage(OWNER_CHAT_ID, `🤖 Автовыдача заказа:\n${results.join('\n')}`);
  } catch (err) {
    console.error('Не удалось отправить отчёт по автовыдаче:', err.message);
  }
}

/** Раз в 5 минут обходит все заказы, отданные в twiboost, и подтягивает
 *  актуальный статус выполнения в историю заказов пользователя.
 *
 *  Каждая позиция заказа (twiboostOrders[i]) отслеживается и, если нужно,
 *  возвращается на баланс НЕЗАВИСИМО от остальных. Так заказ из нескольких
 *  услуг, где поставщик отменил только одну из них, вернёт деньги только
 *  за эту одну услугу — остальные продолжат штатно выполняться. (Раньше
 *  при отмене/ошибке любой ОДНОЙ позиции возвращалась вся сумма заказа.) */
async function pollTwiboostStatuses() {
  if (!TWIBOOST_API_KEY || pollingOrders.size === 0) return;

  const allIds = [...new Set(
    [...pollingOrders.values()]
      .flatMap(v => v.twiboostOrders)
      .filter(o => o.status === 'processing')
      .map(o => o.id)
  )];
  if (allIds.length === 0) return;

  let statuses;
  try {
    statuses = await getTwiboostStatuses(allIds);
  } catch (err) {
    console.error('twiboost status poll error:', err.message);
    return;
  }

  for (const [historyEntryId, meta] of pollingOrders) {
    const user = users.get(meta.userId);
    if (!user) { pollingOrders.delete(historyEntryId); continue; }
    const entry = user.orders.find(o => o.id === historyEntryId);
    if (!entry) { pollingOrders.delete(historyEntryId); continue; }

    for (const order of meta.twiboostOrders) {
      if (order.status !== 'processing') continue; // уже обработана раньше
      const row = statuses[order.id];
      if (!row) continue; // пока нет данных от API — оставляем как есть
      const rowStatus = String(row.status).toLowerCase();

      if (rowStatus === 'completed') {
        order.status = 'completed';
      } else if (['canceled', 'cancelled', 'error'].includes(rowStatus)) {
        order.status = 'canceled';

        // Возвращаем деньги ТОЛЬКО за эту позицию — остальные заявки из
        // этого же заказа (если есть) отслеживаются отдельно и не трогаются.
        user.balance = round2(user.balance + order.price);

        bot.sendMessage(
          meta.userId,
          `⚠️ "${order.name}" (${order.qty} шт) — ошибка на стороне поставщика, вернули ${order.price} ⭐ на ваш баланс. Приносим извинения за неудобства.`
        ).catch(err => console.error('Не удалось уведомить пользователя о возврате:', err.message));

        bot.sendMessage(
          OWNER_CHAT_ID,
          `↩️ Возврат ${order.price} ⭐ на баланс пользователя (id ${meta.userId}) — позиция "${order.name}" в заказе от ${entry.date} завершилась ошибкой в панели twiboost.`
        ).catch(err => console.error('Не удалось уведомить владельца о возврате:', err.message));
      }
      // иначе — всё ещё в обработке у поставщика, статус позиции не меняем
    }

    const total = meta.twiboostOrders.length;
    const completed = meta.twiboostOrders.filter(o => o.status === 'completed').length;
    const canceled = meta.twiboostOrders.filter(o => o.status === 'canceled').length;
    const stillProcessing = total - completed - canceled;

    if (stillProcessing > 0) {
      entry.status = `В обработке (${completed + canceled}/${total})`;
    } else if (canceled === 0) {
      entry.status = 'Выполнен';
    } else if (completed === 0) {
      entry.status = 'Ошибка выполнения — возвращено на баланс';
    } else {
      const refunded = round2(meta.twiboostOrders.filter(o => o.status === 'canceled').reduce((s, o) => s + o.price, 0));
      entry.status = `Частично выполнен — возвращено ${refunded} ⭐ за ${canceled} из ${total} позиций`;
    }

    if (stillProcessing === 0) pollingOrders.delete(historyEntryId);
  }
  saveData();
}
setInterval(() => { pollTwiboostStatuses().catch(err => console.error('pollTwiboostStatuses:', err.message)); }, 5 * 60 * 1000);

/* ---------- Очередь ручной выдачи (Premium Реакции и т.п.) ---------- */

/** Собирает по всем пользователям позиции заказов из MANUAL_FULFILLMENT_SERVICE_IDS,
 *  которые ещё не отмечены выданными. Возвращает в порядке поступления
 *  (старые — первыми), чтобы выдавать по очереди. */
function getPendingManualItems() {
  const pending = [];
  for (const [userId, user] of users) {
    for (const order of user.orders) {
      if (order.fulfilledManually) continue;
      if (!Array.isArray(order.items)) continue;
      for (const item of order.items) {
        if (item.serviceId && MANUAL_FULFILLMENT_SERVICE_IDS.has(item.serviceId)) {
          pending.push({
            userId,
            orderId: order.id,
            date: order.date,
            createdAt: order.createdAt || 0,
            serviceId: item.serviceId,
            name: item.name,
            qty: item.qty,
            link: item.link || order.link || '',
          });
        }
      }
    }
  }
  pending.sort((a, b) => a.createdAt - b.createdAt);
  return pending;
}

/** Формат "1. ссылка × кол-во" — по одной строке на позицию, для удобного
 *  копирования при ручной выдаче. */
function formatManualFulfillmentText(items) {
  if (items.length === 0) return 'Нет заказов, ожидающих ручной выдачи.';
  return items.map((it, idx) => `${idx + 1}. ${it.link || '—'} × ${it.qty}`).join('\n');
}

async function notifyOwner(tgUser, items, total, method) {
  const itemsText = items.map(i => `• ${i.name} — ${i.qty} шт, ссылка: ${i.link}`).join('\n');
  const text =
    `🆕 Новый оплаченный заказ (${method})\n` +
    `Сумма: ${total} ⭐\n` +
    `Покупатель: ${tgUser.first_name || ''} ${tgUser.username ? '@' + tgUser.username : '(id ' + tgUser.id + ')'}\n\n` +
    `${itemsText}`;
  try {
    await bot.sendMessage(OWNER_CHAT_ID, text);
  } catch (err) {
    // Не роняем процесс, если уведомление владельцу не доставилось
    // (неверный OWNER_CHAT_ID, бот заблокирован и т.п.) — заказ уже оплачен
    // и сохранён у пользователя, потерять его из-за этого нельзя.
    console.error('Не удалось отправить уведомление владельцу:', err.message);
  }
}

/* /start и весь магазин в чате — в bot-shop.js (подключается внизу файла). */

/* ---------- Открытие админ-панели из бота (только для владельца) ----------
   ВАЖНО: кнопка сделана через "url", а НЕ "web_app". Админ-панель защищена
   HTTP Basic Auth (браузерное окно логин/пароль) — WebView, в котором
   Telegram открывает Mini App (web_app), как правило НЕ показывает это окно
   нормально. Обычная ссылка ("url") открывает панель в системном браузере
   телефона, где ввод пароля работает штатно. */
bot.onText(/\/admin/, async (msg) => {
  if (String(msg.chat.id) !== String(OWNER_CHAT_ID)) return; // не отвечаем никому, кроме владельца
  if (!ADMIN_PASSWORD) {
    return bot.sendMessage(msg.chat.id, 'Админ-панель отключена: задайте ADMIN_PASSWORD в .env и перезапустите сервер.');
  }
  if (!WEBAPP_URL) {
    return bot.sendMessage(msg.chat.id, 'Не задан WEBAPP_URL в .env — не могу собрать ссылку на панель.');
  }
  const adminUrl = new URL('/admin', WEBAPP_URL).toString();
  await bot.sendMessage(
    msg.chat.id,
    '🛠 Админ-панель (откроется в браузере телефона, там же спросит пароль):',
    { reply_markup: { inline_keyboard: [[{ text: 'Открыть админ-панель', url: adminUrl }]] } }
  );
});

// Кнопка меню слева от поля ввода. Режим Mini App (MINIAPP_ENABLED=true) —
// открывает магазин в один тап; иначе — обычное меню команд бота. Явно
// ставим 'commands', иначе у пользователей останется старая кнопка «Магазин»,
// сохранённая Telegram с прошлых запусков.
// Необязательная фича — если не сработает, это не должно ронять сервер.
if (typeof bot.setChatMenuButton === 'function') {
  const menuButton = (MINIAPP_ENABLED && WEBAPP_URL)
    ? { type: 'web_app', text: 'Магазин', web_app: { url: WEBAPP_URL } }
    : { type: 'commands' };
  try {
    Promise.resolve(bot.setChatMenuButton({ menu_button: menuButton }))
      .then(() => console.log('Кнопка меню установлена'))
      .catch((err) => console.warn('Не удалось установить кнопку меню:', err && err.message));
  } catch (err) {
    console.warn('Не удалось установить кнопку меню (синхронная ошибка):', err && err.message);
  }
}

/* ---------- Кнопки «Выплатил» / «Отклонить» у заявки на вывод ----------
 * Реагируем только на владельца — иначе кто угодно, кому переслали
 * сообщение, мог бы подтверждать чужие выплаты. */
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const isPaid = data.startsWith('wd_paid_');
  const isDecline = data.startsWith('wd_decline_');
  if (!isPaid && !isDecline) return;

  if (String(query.from.id) !== String(OWNER_CHAT_ID)) {
    return bot.answerCallbackQuery(query.id, { text: 'Только владелец может это подтверждать', show_alert: true });
  }

  const requestId = data.slice(isPaid ? 'wd_paid_'.length : 'wd_decline_'.length);
  const request = withdrawalRequests.get(requestId);
  if (!request) {
    return bot.answerCallbackQuery(query.id, { text: 'Заявка не найдена', show_alert: true });
  }
  if (request.status !== 'pending') {
    return bot.answerCallbackQuery(query.id, { text: 'Эта заявка уже обработана', show_alert: true });
  }

  const user = getUser(request.userId);
  const historyEntry = user.orders.find(o => o.id === request.orderId);

  if (isPaid) {
    request.status = 'paid';
    if (historyEntry) historyEntry.status = 'Выплачено';
    try {
      await bot.sendMessage(request.userId, `✅ Ваша заявка на вывод ${request.amount} ⭐ выполнена.`);
    } catch (err) { console.error('Не удалось уведомить пользователя о выплате:', err.message); }
  } else {
    request.status = 'declined';
    user.balance = round2(user.balance + request.amount);
    if (historyEntry) historyEntry.status = 'Отклонена (возврат на баланс)';
    try {
      await bot.sendMessage(request.userId, `❌ Заявка на вывод ${request.amount} ⭐ отклонена, средства возвращены на баланс.`);
    } catch (err) { console.error('Не удалось уведомить пользователя об отклонении:', err.message); }
  }
  saveData();

  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    );
    await bot.editMessageText(
      `${query.message.text}\n\n${isPaid ? '✅ Отмечено как выплачено' : '❌ Отклонено, деньги возвращены на баланс'}`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    );
  } catch (err) {
    // Сообщение могли удалить/оно устарело — не критично, статус уже сохранён
  }

  await bot.answerCallbackQuery(query.id, { text: isPaid ? 'Отмечено как выплачено' : 'Отклонено, деньги возвращены' });
});

// Обязательно ответить в течение 10 секунд
bot.on('pre_checkout_query', async (query) => {
  const order = pendingOrders.get(query.invoice_payload);
  const ok = !!order;
  // Отвечать нужно быстро (лимит Telegram — 10 с) — при сбое сети пробуем ещё.
  try {
    await withRetry(
      () => bot.answerPreCheckoutQuery(query.id, ok, ok ? undefined : { error_message: 'Заказ не найден, попробуйте оформить заново' }),
      { tries: 3, delayMs: 400 }
    );
  } catch (err) {
    console.error('answerPreCheckoutQuery не удался:', err && err.message);
  }
});

// Приходит ТОЛЬКО после реального списания Stars — вот здесь заказ ваш
bot.on('message', async (msg) => {
  if (!msg.successful_payment) return;
  const payment = msg.successful_payment;

  // Защита от повторной обработки одного и того же платежа.
  if (processedCharges.has(payment.telegram_payment_charge_id)) {
    console.warn('Платёж уже обработан, пропускаю:', payment.telegram_payment_charge_id);
    return;
  }
  processedCharges.add(payment.telegram_payment_charge_id);

  const order = pendingOrders.get(payment.invoice_payload);
  pendingOrders.delete(payment.invoice_payload);

  // Stars списаны, а заказ не найден (не должно случаться, т.к. pre_checkout
  // такой платёж отклоняет) — не создаём «пустой» заказ, а сразу сообщаем владельцу.
  if (!order) {
    saveData();
    console.error('Платёж без заказа:', payment.invoice_payload, payment.telegram_payment_charge_id);
    const b = msg.from || {};
    await bot.sendMessage(OWNER_CHAT_ID,
      `🚨 Оплата Stars без найденного заказа!\n` +
      `Сумма: ${payment.total_amount} ⭐\n` +
      `Пользователь: ${b.first_name || ''} ${b.username ? '@' + b.username : '(id ' + b.id + ')'}\n` +
      `payload: ${payment.invoice_payload}\n` +
      `ID транзакции: ${payment.telegram_payment_charge_id}\n` +
      `Разберитесь вручную (выдать заказ или сделать возврат).`
    ).catch((e) => console.error('Не удалось уведомить владельца:', e.message));
    await bot.sendMessage(msg.chat.id, 'Платёж получен, но заказ не удалось найти автоматически. Мы уже разбираемся и свяжемся с вами.')
      .catch((e) => console.error('Не удалось написать покупателю:', e.message));
    return;
  }

  const buyer = msg.from;
  const user = touchUser(buyer);
  const chargeId = payment.telegram_payment_charge_id;

  if (order?.type === 'topup') {
    // Это пополнение баланса — товаров нет, просто зачисляем Stars целиком
    user.balance += payment.total_amount;
    user.orders.unshift(orderToHistoryEntry(
      buyer.id,
      [{ name: 'Пополнение баланса', qty: payment.total_amount }],
      payment.total_amount,
      'Выполнен'
    ));
    saveData();

    try {
      await bot.sendMessage(OWNER_CHAT_ID,
        `💰 Пополнение баланса на ${payment.total_amount} ⭐\n` +
        `Пользователь: ${buyer.first_name || ''} ${buyer.username ? '@' + buyer.username : '(id ' + buyer.id + ')'}\n` +
        `ID транзакции: ${chargeId}`
      );
    } catch (err) {
      console.error('Не удалось отправить уведомление владельцу:', err.message);
    }
    await bot.sendMessage(msg.chat.id, `Баланс пополнен на ${payment.total_amount} ⭐. Спасибо!`)
      .catch((e) => console.error('Не удалось написать покупателю:', e.message));
    return;
  }

  // Обычный заказ услуги.
  // На баланс возвращается: (1) roundingCredit — переплата из-за того, что
  // Stars можно списать только целым числом (см. /api/create-invoice), и
  // (2) кешбэк 5% от оплаченной суммы.
  user.balance = round2(
    Math.max(0, user.balance - (order?.balanceUsed || 0))
    + (order?.roundingCredit || 0)
    + payment.total_amount * 0.05
  );
  const refundAmount = round2((order?.balanceUsed || 0) + payment.total_amount);
  const historyEntry = orderToHistoryEntry(buyer.id, order?.items || [], payment.total_amount, 'Оплачен', refundAmount);
  user.orders.unshift(historyEntry);
  saveData();

  await notifyOwner(buyer, order?.items || [], payment.total_amount, 'Stars, transaction ' + chargeId);
  // Ошибка отправки сообщения (Telegram 502 и т.п.) не должна срывать автовыдачу.
  await bot.sendMessage(msg.chat.id, 'Спасибо за заказ! Мы уже начали выполнение — обновления пришлём в этот чат.')
    .catch((e) => console.error('Не удалось написать покупателю:', e.message));

  // Автовыдача: создаём заказ(ы) в панели twiboost.com через её API.
  // Если для услуги нет мапинга в TWIBOOST_SERVICE_MAP или запрос к API
  // упал с ошибкой — заказ остаётся у вас в чате на ручную обработку,
  // ничего не теряется.
  try {
    await fulfillOrder(historyEntry, order?.items || []);
  } catch (err) {
    console.error('fulfillOrder упал:', err && err.message);
    saveData();
    bot.sendMessage(OWNER_CHAT_ID, `🚨 Автовыдача упала с ошибкой (${err && err.message}). Заказ оплачен — выдайте вручную.`).catch(() => {});
  }
});

/* ---------- Магазин в чате (команды и кнопки, без Mini App) ---------- */
require('./bot-shop')({
  bot, SERVICES, pendingOrders, withdrawalRequests, BALANCE_PROMO_CODES,
  MIN_WITHDRAW_AMOUNT, NEWS_CHANNEL, SUPPORT_USERNAME, OWNER_CHAT_ID,
  WEBAPP_URL, MINIAPP_ENABLED,
  touchUser, saveData, round2, itemPrice, recomputeSubtotal, isSubscribed,
  orderToHistoryEntry, notifyOwner, fulfillOrder, withRetry,
});

app.listen(PORT, () => console.log(`Server on :${PORT}`));
