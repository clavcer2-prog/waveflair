/**
 * Генератор каталога услуг с twiboost.com для новой "сети" (раздела СММ) —
 * TikTok, Instagram, YouTube и т.п. Полностью копирует ВСЕ категории и ВСЕ
 * варианты услуг внутри них (как уже сделано для Telegram в
 * services-catalog.js), применяет наценку и генерирует два файла в том же
 * формате, что уже использует проект:
 *
 *   <network>-services-catalog.js  — для сервера (server.js подключает его
 *                                     автоматически, если файл существует)
 *   <network>-services-client.js   — для фронтенда (вставьте содержимое
 *                                     вместо TIKTOK_SERVICES/CATS_TIKTOK
 *                                     в index.html)
 *
 * ЗАПУСК (на своей машине/сервере, НЕ в чате — тут нужен ваш реальный
 * TWIBOOST_API_KEY из .env, светить его посторонним нельзя):
 *
 *   node fetch-twiboost-services.js tiktok
 *   node fetch-twiboost-services.js tiktok 15        (наценка 15% вместо 10%)
 *   node fetch-twiboost-services.js instagram         (для другой сети — по аналогии)
 *
 * Требования: Node.js 18+ (встроенный fetch), .env рядом с этим файлом
 * с TWIBOOST_API_KEY=ваш_ключ_из_ЛК_twiboost.com → API.
 *
 * Как twiboost.com называет категории — предсказать нельзя, поэтому скрипт
 * НЕ пытается разложить их по своим "умным" корзинам (как когда-то вручную
 * сделали для Telegram: Подписчики/Просмотры/Реакции/...) — вместо этого
 * каждая категория twiboost становится ровно одной вкладкой на сайте.
 * Это самый надёжный способ "полностью скопировать все категории 1:1".
 */

require('dotenv').config();

const TWIBOOST_API_KEY = process.env.TWIBOOST_API_KEY;
const TWIBOOST_API_URL = 'https://twiboost.com/api/v2';

const network = (process.argv[2] || '').trim().toLowerCase();
const markupPercent = Number(process.argv[3]) || 10; // по умолчанию +10%, как договорились
const markupMultiplier = 1 + markupPercent / 100;

if (!network) {
  console.error('Укажите сеть первым аргументом, например: node fetch-twiboost-services.js tiktok');
  process.exit(1);
}
if (!TWIBOOST_API_KEY) {
  console.error('TWIBOOST_API_KEY не задан в .env — без него нельзя получить список услуг.');
  process.exit(1);
}

// Ключевые слова для поиска категорий нужной сети в списке twiboost —
// сайт двуязычный, поэтому проверяем и английские, и русские варианты.
// Если сети нет в списке — просто ищем по названию сети как есть.
const NETWORK_KEYWORDS = {
  tiktok: ['tiktok', 'tik tok', 'тикток', 'тик ток'],
  instagram: ['instagram', 'инстаграм', 'инста'],
  youtube: ['youtube', 'ютуб'],
  vk: ['vkontakte', 'вконтакте', ' vk ', 'вк '],
  telegram: ['telegram', 'телеграм'],
};
const keywords = NETWORK_KEYWORDS[network] || [network];

// Слова-маркеры для угадывания, что нужно спросить у покупателя:
// ссылку на видео/пост или ссылку/юзернейм профиля/канала.
const VIDEO_TARGET_HINTS = /видео|video|пост|post|reels|рилс|shorts|шортс/i;
const PROFILE_TARGET_HINTS = /подпис|follow|фолловер|фоловер|профил|аккаунт|profile|account|канал|channel/i;

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function pickStep(min, max) {
  const candidates = [10, 50, 100, 500, 1000, 5000, 10000];
  for (const c of candidates) {
    if (c >= min && c <= max) return c;
  }
  return Math.max(1, Math.round(min));
}

function guessTarget(name, category) {
  const text = `${category} ${name}`;
  if (PROFILE_TARGET_HINTS.test(text) && !VIDEO_TARGET_HINTS.test(text)) return 'profile';
  if (VIDEO_TARGET_HINTS.test(text)) return 'video';
  return 'profile'; // по умолчанию — подписчики/фолловеры чаще всего самая частая категория
}

async function twiboostServices() {
  const res = await fetch(TWIBOOST_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: TWIBOOST_API_KEY, action: 'services' }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('Неожиданный ответ twiboost API: ' + JSON.stringify(data).slice(0, 300));
  }
  return data;
}

async function main() {
  console.log(`Тяну список услуг с twiboost.com для сети "${network}" (наценка +${markupPercent}%)...`);
  const all = await twiboostServices();
  console.log(`Всего услуг у twiboost: ${all.length}`);

  const filtered = all.filter(item => {
    const cat = String(item.category || '').toLowerCase();
    return keywords.some(kw => cat.includes(kw));
  });
  console.log(`Из них по сети "${network}": ${filtered.length}`);

  if (filtered.length === 0) {
    console.error(
      'Ничего не найдено. Откройте свой ЛК twiboost → API → Список услуг и посмотрите,\n' +
      'как реально называются категории для этой сети — возможно, нужно добавить\n' +
      'ключевое слово в NETWORK_KEYWORDS в начале этого скрипта.'
    );
    process.exit(1);
  }

  // Категории twiboost — как есть, 1 категория = 1 вкладка на сайте.
  const categoriesOrder = [];
  const categoriesSeen = new Set();
  for (const item of filtered) {
    const cat = String(item.category || 'Без категории').trim();
    if (!categoriesSeen.has(cat)) { categoriesSeen.add(cat); categoriesOrder.push(cat); }
  }

  const usedIds = new Set();
  const services = []; // { id, cat, catLabel, name, desc, price1000, min, max, step, target, twiboostId, twiboostRate }

  for (const item of filtered) {
    const catLabel = String(item.category || 'Без категории').trim();
    const catId = `${network}_${slugify(catLabel)}`;
    const name = String(item.name || '').trim();
    let id = `${network}_${slugify(catLabel)}_${slugify(name)}`;
    if (!id || id === `${network}_${slugify(catLabel)}_`) id = `${network}_${slugify(catLabel)}_${item.service}`;
    if (usedIds.has(id)) id = `${id}_${item.service}`; // дедупликация как у Telegram-каталога
    usedIds.add(id);

    const rate = Number(item.rate) || 0;
    const price1000 = Math.round(rate * markupMultiplier * 1000) / 1000;
    const min = Number(item.min) || 1;
    const max = Number(item.max) || min;

    services.push({
      id,
      cat: catId,
      catLabel,
      name: name || `Услуга #${item.service}`,
      desc: `#${item.service}`,
      price1000,
      min,
      max,
      step: pickStep(min, max),
      target: guessTarget(name, catLabel),
      twiboostId: item.service,
      twiboostRate: rate,
    });
  }

  /* ---------- Файл для сервера: <network>-services-catalog.js ---------- */
  const backendLines = [];
  backendLines.push('/**');
  backendLines.push(` * Каталог услуг ${network} — сгенерирован автоматически из вашего аккаунта`);
  backendLines.push(' * twiboost.com (скрипт fetch-twiboost-services.js). Наценка уже применена:');
  backendLines.push(` * price1000 (на вашем сайте) = цена twiboost за 1000 * ${markupMultiplier}.`);
  backendLines.push(' *');
  backendLines.push(' * Чтобы обновить цены/категории — запустите скрипт ещё раз и замените');
  backendLines.push(' * этот файл целиком (и ...-services-client.js для фронтенда).');
  backendLines.push(` * Сгенерировано: ${new Date().toISOString()}`);
  backendLines.push(' */');
  backendLines.push('');
  backendLines.push('const SERVICES = {');
  for (const s of services) {
    backendLines.push(`  ${s.id}: { price1000: ${s.price1000}, min: ${s.min}, max: ${s.max} }, // twiboost #${s.twiboostId}, было ${s.twiboostRate}/1000 у twiboost`);
  }
  backendLines.push('};');
  backendLines.push('');
  backendLines.push('const TWIBOOST_SERVICE_MAP = {');
  for (const s of services) {
    backendLines.push(`  ${s.id}: ${s.twiboostId},`);
  }
  backendLines.push('};');
  backendLines.push('');
  backendLines.push('module.exports = { SERVICES, TWIBOOST_SERVICE_MAP };');
  backendLines.push('');

  const fs = require('fs');
  const backendFile = `${network}-services-catalog.js`;
  fs.writeFileSync(backendFile, backendLines.join('\n'), 'utf8');
  console.log(`Записан ${backendFile} (${services.length} услуг) — сервер подключит его автоматически.`);

  /* ---------- Файл для фронтенда: <network>-services-client.js ---------- */
  const escapeTpl = s => String(s).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const clientLines = [];
  clientLines.push(`// Вставьте это ВМЕСТО объявления const ${network.toUpperCase()}_SERVICES = [ ... ]; в index.html`);
  clientLines.push(`const ${network.toUpperCase()}_SERVICES = [`);
  for (const s of services) {
    clientLines.push(`  { id:'${s.id}', cat:'${s.cat}', name:\`${escapeTpl(s.name)}\`, desc:'${s.desc}', price1000:${s.price1000}, min:${s.min}, max:${s.max}, step:${s.step}, target:'${s.target}' },`);
  }
  clientLines.push('];');
  clientLines.push('');
  clientLines.push(`// Вставьте это ВМЕСТО объявления const CATS_${network.toUpperCase()} = [ ... ]; в index.html`);
  clientLines.push(`const CATS_${network.toUpperCase()} = [`);
  for (const cat of categoriesOrder) {
    const catId = `${network}_${slugify(cat)}`;
    const count = services.filter(s => s.cat === catId).length;
    clientLines.push(`  { id:'${catId}', label:'${escapeTpl(cat)}' }, // ${count} услуг`);
  }
  clientLines.push('];');
  clientLines.push('');

  const clientFile = `${network}-services-client.js`;
  fs.writeFileSync(clientFile, clientLines.join('\n'), 'utf8');
  console.log(`Записан ${clientFile} — скопируйте его содержимое в index.html вместо заглушек.`);

  console.log('\nГотово. Проверьте несколько случайных target (video/profile) в файлах —');
  console.log('угадывание по ключевым словам не идеально, поправьте руками, где ошиблось.');
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
