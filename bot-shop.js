/**
 * Магазин прямо в чате с ботом — без Mini App. Управление — инлайн-кнопками
 * (из команд остался только /start, открывающий главное меню).
 *
 * Что умеет: каталог услуг (сеть → категория → услуга) и поиск по названию, оформление заказа
 * (количество → ссылка → подтверждение), оплата Telegram Stars или с баланса,
 * пополнение баланса, промокоды, история заказов, заявка на вывод, поддержка.
 *
 * Что НЕ переписано, а переиспользуется из server.js как есть:
 *   • успешная оплата (bot.on('message') → successful_payment) — зачисление,
 *     кешбэк 5%, запись в историю, уведомление владельцу;
 *   • автовыдача через twiboost (fulfillOrder) и опрос статусов/возвраты;
 *   • pre_checkout_query, кнопки «Выплатил/Отклонить» у владельца, /admin.
 * Бот лишь создаёт заказ тем же способом, что и /api/create-invoice, и
 * отправляет счёт Stars в чат (sendInvoice) вместо ссылки для Mini App.
 *
 * Цены ВСЕГДА берутся с сервера (SERVICES из *-services-catalog.js), а
 * названия/категории — из bot-catalog.js (см. build-bot-catalog.js).
 */
const crypto = require('crypto');
const catalog = require('./bot-catalog');

const PAGE_SIZE = 8;
const STATE_TTL_MS = 60 * 60 * 1000;
const TOPUP_PRESETS = [50, 100, 250, 500, 1000];
const MAX_TOPUP = 100000;
const SEARCH_MAX_RESULTS = 64;     // сколько результатов поиска максимум храним/листаем
const SEARCH_MIN_LEN = 2;

// Синонимы соцсетей для поиска («тг», «инста», «ютуб» …)
const NET_ALIASES = {
  telegram:  'тг телеграм телега tg',
  tiktok:    'тикток тик ток тт tt',
  facebook:  'фейсбук фб fb',
  instagram: 'инстаграм инста инстаграмм ig insta',
  max:       'макс',
  discord:   'дискорд',
  youtube:   'ютуб ютьюб yt',
};

const LINK_TARGETS = {
  post:    { label: 'ссылку на пост',                    what: 'ссылка на пост',                    example: 'https://t.me/channel/123',                    needsUrl: true  },
  channel: { label: 'ссылку на канал (или @username)',   what: 'ссылка на канал или @username',     example: '@my_channel',                                 needsUrl: false },
  video:   { label: 'ссылку на видео',                   what: 'ссылка на видео',                   example: 'https://www.tiktok.com/@user/video/123456',   needsUrl: true  },
  profile: { label: 'ссылку на профиль (или @username)', what: 'ссылка на профиль или @username',   example: '@my_account',                                 needsUrl: false },
};

module.exports = function registerShop(ctx) {
  const {
    bot, SERVICES, pendingOrders, withdrawalRequests, BALANCE_PROMO_CODES,
    MIN_WITHDRAW_AMOUNT, NEWS_CHANNEL, SUPPORT_USERNAME, OWNER_CHAT_ID,
    WEBAPP_URL, MINIAPP_ENABLED, ADMIN_PASSWORD,
    touchUser, saveData, round2, itemPrice, recomputeSubtotal, isSubscribed,
    orderToHistoryEntry, notifyOwner, fulfillOrder, withRetry,
  } = ctx;

  /* ---------- Каталог: склеиваем названия (bot-catalog) с ценами сервера ---------- */
  const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('base64url').slice(0, 8);

  const svcByHash = new Map();   // h -> service
  const catByHash = new Map();   // h -> { net, id, label, services: [] }
  const netInfo = new Map();     // net id -> { id, label, icon, cats: [catRecord] }
  let missingPrices = 0;

  for (const n of catalog.networks) netInfo.set(n.id, { ...n, cats: [] });
  for (const [net, cats] of Object.entries(catalog.cats)) {
    for (const c of cats) {
      const rec = { net, id: c.id, label: c.label, h: hash(net + '|' + c.id), services: [] };
      if (catByHash.has(rec.h)) throw new Error('bot-shop: коллизия хэша категории ' + c.id);
      catByHash.set(rec.h, rec);
      netInfo.get(net).cats.push(rec);
    }
  }
  for (const s of catalog.services) {
    const price = SERVICES[s.id];
    if (!price) { missingPrices++; continue; }          // услуга есть во фронтенде, но нет на сервере — не продаём
    const cat = catByHash.get(hash(s.net + '|' + s.cat));
    if (!cat) continue;
    const rec = { ...s, h: hash(s.id), catH: cat.h };
    if (svcByHash.has(rec.h)) throw new Error('bot-shop: коллизия хэша услуги ' + s.id);
    svcByHash.set(rec.h, rec);
    cat.services.push(rec);
  }
  for (const n of netInfo.values()) n.cats = n.cats.filter(c => c.services.length > 0);
  const visibleNets = [...netInfo.values()].filter(n => n.cats.length > 0);

  /* ---------- Поиск: индекс по названию + категории + соцсети ---------- */
  const normText = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  const splitWords = (s) => normText(s).split(/[^a-z0-9а-я]+/).filter(Boolean);
  // грубый «стеммер», чтобы «подписчиков» находило «Подписчики», «лайков» — «Лайки»
  const stem = (w) => (w.length >= 6 ? w.slice(0, -2) : w.length === 5 ? w.slice(0, -1) : w);

  const searchIndex = [];
  for (const svc of svcByHash.values()) {
    const cat = catByHash.get(svc.catH);
    const net = netInfo.get(svc.net);
    const syn = (str) => (/premium/i.test(str) ? ' премиум' : '');   // «премиум» → Premium
    const nameWords = splitWords(svc.name + syn(svc.name));
    const otherWords = splitWords(`${cat.label} ${net.label} ${NET_ALIASES[svc.net] || ''}${syn(cat.label)}`);
    searchIndex.push({
      svc,
      nameWords, otherWords,
      nameStr: nameWords.join(' '),
      otherStr: otherWords.join(' '),
    });
  }

  // Все слова запроса должны встретиться (в названии, категории или соцсети).
  // Короткие слова (1–2 символа, напр. «ru», «uz») — только как начало слова.
  function searchServices(query) {
    const tokens = splitWords(query).map(stem);
    if (!tokens.length) return [];
    const hit = (words, str, t) => words.some(w => w.startsWith(t)) || (t.length >= 3 && str.includes(t));
    const found = [];
    for (let i = 0; i < searchIndex.length; i++) {
      const e = searchIndex[i];
      let score = 0, ok = true;
      for (const t of tokens) {
        if (hit(e.nameWords, e.nameStr, t)) score += 2;
        else if (hit(e.otherWords, e.otherStr, t)) score += 1;
        else { ok = false; break; }
      }
      if (ok) found.push({ e, score, i });
    }
    found.sort((a, b) => b.score - a.score || a.i - b.i);
    return found.map(f => f.e.svc);
  }

  const botIds = new Set(catalog.services.map(s => s.id));
  const unsold = Object.keys(SERVICES).filter(id => !botIds.has(id)).length;
  console.log(`Магазин в боте: услуг ${svcByHash.size}, сетей ${visibleNets.length} · ПОИСК ВКЛЮЧЁН (индекс: ${searchIndex.length})`);
  if (unsold > 0) console.warn(`Магазин в боте: ${unsold} услуг на сервере без описания — запустите: node build-bot-catalog.js`);
  if (missingPrices > 0) console.warn(`Магазин в боте: ${missingPrices} услуг из bot-catalog.js нет в серверных каталогах — они скрыты`);

  /* ---------- Мелкие помощники ---------- */
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const btn = (text, data) => ({ text, callback_data: data });
  const urlBtn = (text, url) => ({ text, url });
  const supportUrl = 'https://t.me/' + String(SUPPORT_USERNAME).replace(/^@/, '');
  const newsUrl = 'https://t.me/' + String(NEWS_CHANNEL).replace(/^@/, '');
  const BACK_MENU = [btn('🏠 Меню', 'm:menu')];

  // Состояние диалога (ждём от пользователя число/ссылку/промокод). В памяти:
  // при рестарте сервера незавершённое оформление просто начнётся заново.
  const states = new Map();
  function getState(uid) {
    const s = states.get(uid);
    if (!s) return null;
    if (Date.now() - s.at > STATE_TTL_MS) { states.delete(uid); return null; }
    return s;
  }
  function setState(uid, s) { states.set(uid, { ...s, at: Date.now() }); }
  setInterval(() => { for (const uid of states.keys()) getState(uid); }, 10 * 60 * 1000).unref();

  // Последний поиск пользователя (нужен для листания и кнопки «К результатам»).
  const searches = new Map();   // uid -> { q, ids: [svcHash], at }
  function getSearch(uid) {
    const r = searches.get(uid);
    if (!r) return null;
    if (Date.now() - r.at > STATE_TTL_MS) { searches.delete(uid); return null; }
    return r;
  }
  setInterval(() => { for (const uid of searches.keys()) getSearch(uid); }, 10 * 60 * 1000).unref();

  async function render(target, text, rows) {
    const opts = { reply_markup: { inline_keyboard: rows || [] }, disable_web_page_preview: true };
    const body = String(text).slice(0, 4000);
    if (target.messageId) {
      try {
        await bot.editMessageText(body, { chat_id: target.chatId, message_id: target.messageId, ...opts });
        return;
      } catch (err) {
        if (/message is not modified/i.test(String((err && err.message) || ''))) return;
        // старое/удалённое сообщение — просто отправим новое
      }
    }
    await withRetry(() => bot.sendMessage(target.chatId, body, opts), { tries: 2, delayMs: 400 });
  }

  /* ---------- Экраны ---------- */
  let adminUrl = null;
  try { if (ADMIN_PASSWORD && WEBAPP_URL) adminUrl = new URL('/admin', WEBAPP_URL).toString(); }
  catch (err) { console.warn('Кнопка админ-панели отключена: некорректный WEBAPP_URL'); }
  const isOwner = (uid) => String(uid) === String(OWNER_CHAT_ID);

  function screenMenu(user, uid) {
    const rows = [
      [btn('🛒 Каталог услуг', 'm:cat'), btn('🔍 Поиск', 'm:find')],
      [btn('💰 Баланс', 'm:bal'), btn('📦 Мои заказы', 'm:ord')],
      [btn('🎁 Промокод', 'm:promo'), btn('💸 Вывод', 'm:wd')],
      [btn('🆘 Поддержка', 'm:sup')],
    ];
    if (MINIAPP_ENABLED && WEBAPP_URL) rows.push([{ text: '🛍 Открыть Mini App', web_app: { url: WEBAPP_URL } }]);
    if (isOwner(uid) && adminUrl) rows.push([urlBtn('🛠 Админ-панель', adminUrl)]);   // только владельцу, откроется в браузере
    return {
      text: `☀️ SMM Store — подписчики, просмотры и реакции с оплатой в Telegram Stars.\n\n💰 Баланс: ${round2(user.balance)} ⭐\n\nВыберите действие:`,
      rows,
    };
  }

  function screenNetworks() {
    const rows = [];
    for (let i = 0; i < visibleNets.length; i += 2) {
      rows.push(visibleNets.slice(i, i + 2).map(n => btn(`${n.icon} ${n.label}`, 'n:' + n.id)));
    }
    rows.push([btn('🔍 Поиск услуги', 'm:find')]);
    rows.push(BACK_MENU);
    return { text: '🛒 Каталог — выберите соцсеть (или найдите услугу поиском):', rows };
  }

  function screenCats(netId) {
    const n = netInfo.get(netId);
    if (!n) return screenNetworks();
    const rows = n.cats.map(c => [btn(`${c.label} (${c.services.length})`, `c:${c.h}:0`)]);
    rows.push([btn('⬅ Соцсети', 'm:cat'), btn('🏠 Меню', 'm:menu')]);
    return { text: `${n.icon} ${n.label} — выберите категорию:`, rows };
  }

  function screenList(catH, page) {
    const cat = catByHash.get(catH);
    if (!cat) return screenNetworks();
    const n = netInfo.get(cat.net);
    const pages = Math.max(1, Math.ceil(cat.services.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page | 0), pages - 1);
    const slice = cat.services.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

    const lines = slice.map((s, i) => {
      const p = SERVICES[s.id];
      return `${i + 1}. ${s.name}\n    от ${p.price1000} ⭐ за 1000 · ${fmt(p.min)}–${fmt(p.max)}`;
    });
    const text = `${n.icon} ${n.label} › ${cat.label}\nСтраница ${page + 1}/${pages} · услуг: ${cat.services.length}\n\n${lines.join('\n\n')}\n\nНажмите номер услуги:`;

    const rows = [];
    const numRow = slice.map((s, i) => btn(String(i + 1), 's:' + s.h));
    for (let i = 0; i < numRow.length; i += 4) rows.push(numRow.slice(i, i + 4));
    if (pages > 1) {
      const nav = [];
      if (page > 0) nav.push(btn('◀', `c:${catH}:${page - 1}`));
      nav.push(btn(`${page + 1}/${pages}`, `c:${catH}:${page}`));
      if (page < pages - 1) nav.push(btn('▶', `c:${catH}:${page + 1}`));
      rows.push(nav);
    }
    rows.push([btn('⬅ Категории', 'n:' + cat.net), btn('🏠 Меню', 'm:menu')]);
    return { text, rows };
  }

  function screenAskSearch() {
    return {
      text: '🔍 Поиск услуги\n\nНапишите, что ищете — например: «подписчики», «реакции тг», «лайки тикток», «просмотры youtube».',
      rows: [[btn('❌ Отмена', 'x')]],
    };
  }

  function screenSearch(uid, page) {
    const r = getSearch(uid);
    if (!r) return null;
    const total = r.ids.length;
    if (!total) {
      return {
        text: `🔍 По запросу «${clip(r.q, 60)}» ничего не нашлось.\n\nПопробуйте другое слово (например «подписчики», «лайки», «просмотры») или название соцсети.`,
        rows: [[btn('🔍 Искать снова', 'm:find')], [btn('🛒 Каталог услуг', 'm:cat'), btn('🏠 Меню', 'm:menu')]],
      };
    }
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    page = Math.min(Math.max(0, page | 0), pages - 1);
    const slice = r.ids.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map(h => svcByHash.get(h)).filter(Boolean);

    const lines = slice.map((s, i) => {
      const p = SERVICES[s.id];
      const n = netInfo.get(s.net);
      const cat = catByHash.get(s.catH);
      return `${i + 1}. ${s.name}\n    ${n.icon} ${n.label} › ${cat.label}\n    от ${p.price1000} ⭐ за 1000 · ${fmt(p.min)}–${fmt(p.max)}`;
    });
    const capped = r.capped ? '\n(показаны первые результаты — уточните запрос, чтобы сузить список)' : '';
    const text = `🔍 «${clip(r.q, 60)}» — найдено: ${total}${r.capped ? '+' : ''}\nСтраница ${page + 1}/${pages}\n\n${lines.join('\n\n')}${capped}\n\nНажмите номер услуги:`;

    const rows = [];
    const numRow = slice.map((s, i) => btn(String(i + 1), `s:${s.h}:f${page}`));
    for (let i = 0; i < numRow.length; i += 4) rows.push(numRow.slice(i, i + 4));
    if (pages > 1) {
      const nav = [];
      if (page > 0) nav.push(btn('◀', `f:${page - 1}`));
      nav.push(btn(`${page + 1}/${pages}`, `f:${page}`));
      if (page < pages - 1) nav.push(btn('▶', `f:${page + 1}`));
      rows.push(nav);
    }
    rows.push([btn('🔍 Новый поиск', 'm:find'), btn('🏠 Меню', 'm:menu')]);
    return { text, rows };
  }

  async function runSearch(target, uid, query) {
    const q = String(query || '').trim();
    if (q.length < SEARCH_MIN_LEN) {
      setState(uid, { step: 'search' });
      return render(target, `Слишком короткий запрос — напишите хотя бы ${SEARCH_MIN_LEN} символа.`, [[btn('❌ Отмена', 'x')]]);
    }
    const all = searchServices(q);
    searches.set(uid, { q, ids: all.slice(0, SEARCH_MAX_RESULTS).map(s => s.h), capped: all.length > SEARCH_MAX_RESULTS, at: Date.now() });
    const s = screenSearch(uid, 0);
    return render(target, s.text, s.rows);
  }

  // from — откуда открыли карточку: 'f<стр>' = из поиска, иначе из списка категории
  function screenService(svc, from) {
    const p = SERVICES[svc.id];
    const t = LINK_TARGETS[svc.target] || LINK_TARGETS.channel;
    const cat = catByHash.get(svc.catH);
    let back;
    const m = /^f(\d+)$/.exec(from || '');
    if (m) {
      back = btn('⬅ К результатам', `f:${m[1]}`);
    } else {
      const idx = cat.services.indexOf(svc);
      back = btn('⬅ К списку', `c:${svc.catH}:${Math.floor(idx / PAGE_SIZE)}`);
    }
    return {
      text: `${svc.name}\n\n💵 Цена: ${p.price1000} ⭐ за 1000\n📏 Количество: от ${fmt(p.min)} до ${fmt(p.max)}\n🔗 Понадобится: ${t.what}`,
      rows: [
        [btn('🛒 Заказать', 'o:' + svc.h)],
        [back, btn('🏠 Меню', 'm:menu')],
      ],
    };
  }

  function screenAskQty(svc) {
    const p = SERVICES[svc.id];
    const quick = [...new Set([p.min, 100, 500, 1000, 5000, 10000])]
      .filter(q => q >= p.min && q <= p.max).sort((a, b) => a - b).slice(0, 5);
    const rows = [];
    if (quick.length) rows.push(quick.map(q => btn(fmt(q), `q:${svc.h}:${q}`)));
    rows.push([btn('❌ Отмена', 'x')]);
    return {
      text: `${svc.name}\n\n🔢 Введите количество числом (от ${fmt(p.min)} до ${fmt(p.max)}) или выберите ниже.\nЦена: ${p.price1000} ⭐ за 1000.`,
      rows,
    };
  }

  function screenAskLink(svc, qty) {
    const t = LINK_TARGETS[svc.target] || LINK_TARGETS.channel;
    const price = itemPrice({ serviceId: svc.id, qty });
    return {
      text: `${svc.name}\nКоличество: ${fmt(qty)} · ${price} ⭐\n\n🔗 Отправьте ${t.label}.\nНапример: ${t.example}`,
      rows: [[btn('❌ Отмена', 'x')]],
    };
  }

  function calcOrder(user, svc, qty) {
    const subtotal = itemPrice({ serviceId: svc.id, qty });
    const balanceUsed = Math.min(user.balance, subtotal);
    const total = round2(Math.max(0, subtotal - balanceUsed));
    const stars = total > 0 ? Math.max(1, Math.ceil(total - 1e-9)) : 0;
    return { subtotal, balanceUsed, total, stars };
  }

  function screenConfirm(user, st) {
    const svc = svcByHash.get(st.sh);
    const c = calcOrder(user, svc, st.qty);
    let text = `🧾 Проверьте заказ\n\n${svc.name}\nКоличество: ${fmt(st.qty)}\nСсылка: ${st.link}\n\nСтоимость: ${c.subtotal} ⭐`;
    if (c.balanceUsed > 0) text += `\nСпишется с баланса: ${round2(c.balanceUsed)} ⭐`;
    text += c.stars > 0 ? `\nК оплате Stars: ${c.stars} ⭐` : '\nОплата полностью с баланса — Stars не нужны.';
    const roundUp = round2(c.stars - c.total);
    if (c.stars > 0 && roundUp > 0) text += `\n(Stars только целые — разница ${roundUp} ⭐ вернётся на ваш баланс.)`;
    return {
      text,
      rows: [
        [btn(c.stars > 0 ? `💳 Оплатить ${c.stars} ⭐` : '💰 Оплатить с баланса', 'pay')],
        [btn('✏️ Изменить', 'o:' + svc.h), btn('❌ Отмена', 'x')],
      ],
    };
  }

  function screenBalance(user) {
    const rows = [
      TOPUP_PRESETS.slice(0, 3).map(a => btn(`+${a} ⭐`, 't:' + a)),
      TOPUP_PRESETS.slice(3).map(a => btn(`+${a} ⭐`, 't:' + a)).concat([btn('Другая сумма', 't:c')]),
      BACK_MENU,
    ];
    return {
      text: `💰 Ваш баланс: ${round2(user.balance)} ⭐\n\nБаланс автоматически тратится при оплате заказов. С каждого заказа, оплаченного Stars, на баланс возвращается 5% кешбэка.\n\nПополнить баланс:`,
      rows,
    };
  }

  function screenOrders(user) {
    const list = user.orders.slice(0, 8);
    if (!list.length) return { text: '📦 У вас пока нет заказов.', rows: [[btn('🛒 Каталог услуг', 'm:cat')], BACK_MENU] };
    const lines = list.map((o, i) => {
      const items = Array.isArray(o.items) ? o.items : [];
      const first = items[0] ? `${clip(items[0].name, 70)} × ${fmt(items[0].qty)}` : 'Заказ';
      const more = items.length > 1 ? ` (+${items.length - 1})` : '';
      const link = o.link ? `\n    🔗 ${clip(o.link, 60)}` : '';
      return `${i + 1}. ${o.date || ''} — ${first}${more}${link}\n    ${o.total} ⭐ · ${o.status}`;
    });
    return { text: `📦 Последние заказы:\n\n${lines.join('\n\n')}`, rows: [BACK_MENU] };
  }

  function screenSupport() {
    return {
      text: `🆘 Есть вопрос по заказу? Напишите нам напрямую в Telegram: ${SUPPORT_USERNAME}`,
      rows: [[urlBtn('Написать в поддержку', supportUrl)], BACK_MENU],
    };
  }

  function screenGate() {
    return {
      text: `Чтобы пользоваться магазином, подпишитесь на наш канал ${NEWS_CHANNEL}, затем нажмите «Я подписался».`,
      rows: [[urlBtn('Открыть канал', newsUrl)], [btn('✅ Я подписался', 'chk')], BACK_MENU],
    };
  }

  /* ---------- Действия ---------- */
  function parseLink(raw, target) {
    const t = LINK_TARGETS[target] || LINK_TARGETS.channel;
    const s = String(raw || '').trim();
    if (!s) return { error: 'Отправьте ссылку текстом.' };
    if (s.length > 500 || /\s/.test(s)) return { error: 'Ссылка не должна содержать пробелов. Отправьте только ссылку.' };
    if (/^@[A-Za-z0-9_]{3,}$/.test(s)) {
      return t.needsUrl ? { error: `Для этой услуги нужна ${t.what}, а не @username.` } : { link: s };
    }
    if (/^https?:\/\/\S+\.\S+/i.test(s)) return { link: s };
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S+/i.test(s)) return { link: 'https://' + s };
    return { error: `Не похоже на ссылку. Отправьте ${t.label}, например: ${t.example}` };
  }

  async function startCheckout(target, tgUser) {
    const uid = tgUser.id;
    const st = getState(uid);
    if (!st || st.step !== 'confirm') {
      return render(target, 'Это оформление уже закрыто или устарело. Начните заново из каталога.', [[btn('🛒 Каталог услуг', 'm:cat')], BACK_MENU]);
    }
    if (st.busy) return;
    st.busy = true;
    try {
      if (!(await isSubscribed(uid))) { st.busy = false; const g = screenGate(); return render(target, g.text, g.rows); }
      const svc = svcByHash.get(st.sh);
      if (!svc) { states.delete(uid); return render(target, 'Эта услуга больше недоступна.', [[btn('🛒 Каталог услуг', 'm:cat')]]); }

      const user = touchUser(tgUser);
      const items = [{ serviceId: svc.id, name: svc.name, qty: st.qty, link: st.link }];
      const subtotal = recomputeSubtotal(items);
      const balanceUsed = Math.min(user.balance, subtotal);
      const total = round2(Math.max(0, subtotal - balanceUsed));
      const orderId = 'order_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      states.delete(uid); // с этого момента повторное нажатие «Оплатить» ничего не создаст

      if (total <= 0) {
        // Баланса хватило на всё — как в /api/create-invoice: списываем сразу, Stars не нужны.
        user.balance = round2(user.balance - balanceUsed);
        const historyEntry = orderToHistoryEntry(uid, items, subtotal, 'Оплачен', balanceUsed);
        user.orders.unshift(historyEntry);
        saveData();
        await render(target, `✅ Заказ оплачен с баланса (${round2(balanceUsed)} ⭐) и запущен.\n\n${svc.name}\nКоличество: ${fmt(st.qty)}\n\nО ходе выполнения сообщим в этом чате.`,
          [[btn('📦 Мои заказы', 'm:ord')], BACK_MENU]);
        await notifyOwner(tgUser, items, subtotal, 'баланс, без Stars');
        try {
          await fulfillOrder(historyEntry, items);
        } catch (err) {
          console.error('fulfillOrder упал:', err && err.message);
          saveData();
          bot.sendMessage(OWNER_CHAT_ID, `🚨 Автовыдача упала с ошибкой (${err && err.message}). Заказ оплачен — выдайте вручную.`).catch(() => {});
        }
        return;
      }

      // Stars принимают только целое число звёзд — округляем вверх, разницу
      // (roundingCredit) вернёт на баланс обработчик успешной оплаты.
      const starsCharged = Math.max(1, Math.ceil(total - 1e-9));
      const roundingCredit = round2(starsCharged - total);
      pendingOrders.set(orderId, { type: 'order', userId: uid, items, subtotal, balanceUsed, finalTotal: total, currency: 'XTR', providerLabel: 'Stars', starsCharged, roundingCredit });
      saveData();
      try {
        await withRetry(() => bot.sendInvoice(
          target.chatId,
          'Заказ SMM Store',
          clip(`${svc.name} × ${fmt(st.qty)}`, 250),
          orderId,
          '',      // provider_token — пусто для Stars
          'XTR',
          [{ label: 'Заказ', amount: starsCharged }]
        ));
      } catch (err) {
        pendingOrders.delete(orderId);
        saveData();
        throw err;
      }
      await render(target, `🧾 Счёт на ${starsCharged} ⭐ отправлен ниже. Нажмите «Оплатить» — после оплаты заказ запустится автоматически.`, [BACK_MENU]);
    } catch (err) {
      console.error('Оформление заказа в боте не удалось:', err && err.message);
      const cur = getState(uid);
      if (cur) cur.busy = false;
      await render(target, 'Не удалось создать счёт. Попробуйте ещё раз через минуту.', [[btn('🛒 Каталог услуг', 'm:cat')], BACK_MENU]).catch(() => {});
    }
  }

  async function startTopup(target, tgUser, amount) {
    const stars = Number(amount);
    if (!Number.isInteger(stars) || stars <= 0 || stars > MAX_TOPUP) {
      return render(target, `Укажите сумму пополнения целым числом от 1 до ${fmt(MAX_TOPUP)} ⭐.`, [BACK_MENU]);
    }
    if (!(await isSubscribed(tgUser.id))) { const g = screenGate(); return render(target, g.text, g.rows); }
    const orderId = 'topup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    pendingOrders.set(orderId, { type: 'topup', userId: tgUser.id, amount: stars, currency: 'XTR', providerLabel: 'Stars' });
    saveData();
    try {
      await withRetry(() => bot.sendInvoice(
        target.chatId,
        'Пополнение баланса',
        `Пополнение баланса SMM Store на ${stars} ⭐`,
        orderId,
        '',
        'XTR',
        [{ label: 'Пополнение', amount: stars }]
      ));
    } catch (err) {
      pendingOrders.delete(orderId);
      saveData();
      console.error('Счёт на пополнение не создан:', err && err.message);
      return render(target, 'Не удалось создать счёт. Попробуйте ещё раз через минуту.', [BACK_MENU]);
    }
    return render(target, `🧾 Счёт на пополнение ${stars} ⭐ отправлен ниже.`, [BACK_MENU]);
  }

  async function redeemPromo(target, tgUser, code) {
    if (!(await isSubscribed(tgUser.id))) { const g = screenGate(); return render(target, g.text, g.rows); }
    const key = String(code || '').trim().toUpperCase();
    const promo = BALANCE_PROMO_CODES[key];
    const back = [[btn('🎁 Ввести другой', 'm:promo')], BACK_MENU];
    if (!promo) return render(target, 'Такого промокода нет.', back);
    if (promo.redeemedBy.has(tgUser.id)) return render(target, 'Вы уже использовали этот промокод.', [BACK_MENU]);
    if (promo.uses >= promo.maxUses) return render(target, 'Промокод исчерпан — закончились использования.', [BACK_MENU]);

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
    return render(target, `🎉 +${promo.value} ⭐ зачислено на баланс.\nТеперь на балансе: ${round2(user.balance)} ⭐`, [[btn('🛒 Каталог услуг', 'm:cat')], BACK_MENU]);
  }

  async function requestWithdraw(target, tgUser, amount) {
    const user = touchUser(tgUser);
    const requested = round2(Number(amount));
    if (!Number.isFinite(requested) || requested <= 0) return render(target, 'Укажите сумму вывода числом.', [BACK_MENU]);
    if (requested < MIN_WITHDRAW_AMOUNT) return render(target, `Минимальная сумма вывода — ${MIN_WITHDRAW_AMOUNT} ⭐.`, [BACK_MENU]);
    if (requested > user.balance) return render(target, `Недостаточно средств. На балансе: ${round2(user.balance)} ⭐.`, [BACK_MENU]);
    if ([...withdrawalRequests.values()].some(w => w.userId === tgUser.id && w.status === 'pending')) {
      return render(target, 'У вас уже есть заявка на вывод в обработке. Дождитесь её завершения.', [BACK_MENU]);
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
    withdrawalRequests.set(requestId, { id: requestId, userId: tgUser.id, orderId: historyEntry.id, amount: requested, status: 'pending', createdAt: Date.now() });
    saveData();

    try {
      await bot.sendMessage(
        OWNER_CHAT_ID,
        `💸 Заявка на вывод ${requested} ⭐\n` +
          `Пользователь: ${tgUser.first_name || ''} ${tgUser.username ? '@' + tgUser.username : '(id ' + tgUser.id + ')'}\n\n` +
          `Выплатите вручную (лично звёздами/переводом), затем нажмите «Выплатил». «Отклонить» вернёт сумму на баланс пользователя.`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ Выплатил', callback_data: `wd_paid_${requestId}` },
          { text: '❌ Отклонить', callback_data: `wd_decline_${requestId}` },
        ]] } }
      );
    } catch (err) {
      console.error('Не удалось отправить заявку на вывод владельцу:', err.message);
    }
    return render(target, `✅ Заявка на вывод ${requested} ⭐ принята. Сумма списана с баланса, о выплате сообщим в этом чате.`, [BACK_MENU]);
  }

  function showMenu(target, tgUser) {
    const s = screenMenu(touchUser(tgUser), tgUser.id);
    return render(target, s.text, s.rows);
  }

  /* ---------- Вход в бота ----------
     Единственная команда — /start (и алиас /menu): она открывает главное меню,
     дальше всё делается инлайн-кнопками. Остальные слэш-команды убраны. */
  const privateOnly = (fn) => async (msg, match) => {
    if (!msg.from || msg.chat.type !== 'private') return;
    states.delete(msg.from.id);
    try { await fn(msg, match); } catch (err) { console.error('Команда бота упала:', err && err.message); }
  };
  const to = (msg) => ({ chatId: msg.chat.id });
  const cmd = (name) => new RegExp(`^\\/${name}(?:@\\w+)?(?:\\s+([\\s\\S]*))?$`, 'i');

  bot.onText(cmd('(?:start|menu)'), privateOnly((msg) => showMenu(to(msg), msg.from)));

  function askWithdraw(target, tgUser) {
    const user = touchUser(tgUser);
    setState(tgUser.id, { step: 'withdraw' });
    return render(target,
      `💸 Вывод баланса\n\nНа балансе: ${round2(user.balance)} ⭐. Минимум для вывода: ${MIN_WITHDRAW_AMOUNT} ⭐.\nОтправьте сумму числом:`,
      [[btn('❌ Отмена', 'x')]]);
  }

  /* ---------- Текстовые ответы в диалоге ---------- */
  bot.on('message', async (msg) => {
    try {
      if (!msg.from || msg.chat.type !== 'private' || msg.successful_payment) return;
      if (typeof msg.text !== 'string') return;
      if (msg.text.startsWith('/')) {
        // /start, /menu и /admin обрабатываются отдельно; любую другую команду просто сводим к меню с кнопками
        if (/^\/(start|menu|admin)(@\w+)?(\s|$)/i.test(msg.text)) return;
        states.delete(msg.from.id);
        return showMenu(to(msg), msg.from);
      }
      const uid = msg.from.id;
      const st = getState(uid);
      const target = to(msg);

      if (!st) {
        // Просто написали слово без кнопок — считаем это поиском услуги
        return runSearch(target, uid, msg.text);
      }

      if (st.step === 'search') {
        states.delete(uid);
        return runSearch(target, uid, msg.text);
      }

      if (st.step === 'qty') {
        const svc = svcByHash.get(st.sh);
        const p = svc && SERVICES[svc.id];
        if (!p) { states.delete(uid); return showMenu(target, msg.from); }
        const qty = Number(msg.text.replace(/[\s,_]/g, ''));
        if (!Number.isInteger(qty) || qty < p.min || qty > p.max) {
          return render(target, `Введите целое число от ${fmt(p.min)} до ${fmt(p.max)}.`, [[btn('❌ Отмена', 'x')]]);
        }
        setState(uid, { step: 'link', sh: svc.h, qty });
        const s = screenAskLink(svc, qty);
        return render(target, s.text, s.rows);
      }

      if (st.step === 'link') {
        const svc = svcByHash.get(st.sh);
        if (!svc) { states.delete(uid); return showMenu(target, msg.from); }
        const parsed = parseLink(msg.text, svc.target);
        if (parsed.error) return render(target, parsed.error, [[btn('❌ Отмена', 'x')]]);
        setState(uid, { step: 'confirm', sh: svc.h, qty: st.qty, link: parsed.link });
        const s = screenConfirm(touchUser(msg.from), getState(uid));
        return render(target, s.text, s.rows);
      }

      if (st.step === 'topup') {
        states.delete(uid);
        return startTopup(target, msg.from, msg.text.trim().replace(',', '.'));
      }
      if (st.step === 'promo') {
        states.delete(uid);
        return redeemPromo(target, msg.from, msg.text);
      }
      if (st.step === 'withdraw') {
        states.delete(uid);
        return requestWithdraw(target, msg.from, msg.text.trim().replace(',', '.'));
      }
      // step === 'confirm': человек пишет вместо нажатия кнопки — напомним про кнопки
      if (st.step === 'confirm') {
        const s = screenConfirm(touchUser(msg.from), st);
        return render(target, s.text, s.rows);
      }
    } catch (err) {
      console.error('Обработка сообщения в боте упала:', err && err.message);
    }
  });

  /* ---------- Кнопки ---------- */
  bot.on('callback_query', async (query) => {
    const data = String(query.data || '');
    if (data.startsWith('wd_')) return;                       // кнопки владельца обрабатываются в server.js
    if (!/^(m|n|c|s|o|q|t|x|f|pay|chk)(:|$)/.test(data)) return;
    if (!query.message || !query.from) { bot.answerCallbackQuery(query.id).catch(() => {}); return; }

    const uid = query.from.id;
    const target = { chatId: query.message.chat.id, messageId: query.message.message_id };
    let alertText;
    try {
      const [kind, a, b] = data.split(':');

      if (kind === 'm') {
        states.delete(uid);
        if (a === 'menu') await showMenu(target, query.from);
        else if (a === 'cat') { const s = screenNetworks(); await render(target, s.text, s.rows); }
        else if (a === 'find') { setState(uid, { step: 'search' }); const s = screenAskSearch(); await render(target, s.text, s.rows); }
        else if (a === 'bal') { const s = screenBalance(touchUser(query.from)); await render(target, s.text, s.rows); }
        else if (a === 'ord') { const s = screenOrders(touchUser(query.from)); await render(target, s.text, s.rows); }
        else if (a === 'sup') { const s = screenSupport(); await render(target, s.text, s.rows); }
        else if (a === 'promo') { setState(uid, { step: 'promo' }); await render(target, '🎁 Отправьте промокод одним сообщением.', [[btn('❌ Отмена', 'x')]]); }
        else if (a === 'wd') await askWithdraw(target, query.from);
      } else if (kind === 'n') {
        const s = screenCats(a); await render(target, s.text, s.rows);
      } else if (kind === 'c') {
        const s = screenList(a, Number(b) || 0); await render(target, s.text, s.rows);
      } else if (kind === 'f') {
        const s = screenSearch(uid, Number(a) || 0);
        if (!s) alertText = 'Результаты поиска устарели — повторите поиск';
        else await render(target, s.text, s.rows);
      } else if (kind === 's') {
        const svc = svcByHash.get(a);
        if (!svc) alertText = 'Услуга больше недоступна — откройте каталог заново';
        else { const s = screenService(svc, b); await render(target, s.text, s.rows); }
      } else if (kind === 'o') {
        const svc = svcByHash.get(a);
        if (!svc) alertText = 'Услуга больше недоступна — откройте каталог заново';
        else {
          setState(uid, { step: 'qty', sh: svc.h });
          const s = screenAskQty(svc); await render(target, s.text, s.rows);
        }
      } else if (kind === 'q') {
        const svc = svcByHash.get(a);
        const p = svc && SERVICES[svc.id];
        const qty = Number(b);
        if (!p || !Number.isInteger(qty) || qty < p.min || qty > p.max) alertText = 'Недопустимое количество';
        else {
          setState(uid, { step: 'link', sh: svc.h, qty });
          const s = screenAskLink(svc, qty); await render(target, s.text, s.rows);
        }
      } else if (kind === 't') {
        if (a === 'c') {
          setState(uid, { step: 'topup' });
          await render(target, `💳 Отправьте сумму пополнения числом (от 1 до ${fmt(MAX_TOPUP)} ⭐).`, [[btn('❌ Отмена', 'x')]]);
        } else {
          await startTopup(target, query.from, a);
        }
      } else if (kind === 'x') {
        states.delete(uid);
        await showMenu(target, query.from);
      } else if (kind === 'chk') {
        if (!(await isSubscribed(uid))) alertText = `Подписка на ${NEWS_CHANNEL} не найдена`;
        else {
          const st = getState(uid);
          if (st && st.step === 'confirm') { const s = screenConfirm(touchUser(query.from), st); await render(target, s.text, s.rows); }
          else await showMenu(target, query.from);
        }
      } else if (kind === 'pay') {
        await startCheckout(target, query.from);
      }
    } catch (err) {
      console.error('Кнопка бота упала:', data, err && err.message);
      alertText = 'Что-то пошло не так, попробуйте ещё раз';
    }
    bot.answerCallbackQuery(query.id, alertText ? { text: alertText, show_alert: true } : {}).catch(() => {});
  });

  /* ---------- Меню команд (слева от поля ввода) ----------
     Оставляем одну команду — вернуться в главное меню; всё остальное — кнопки. */
  const commands = [
    { command: 'start', description: '🏠 Главное меню' },
  ];
  Promise.resolve(bot.setMyCommands(commands)).catch((err) => console.warn('Не удалось установить список команд:', err && err.message));
};
