/**
 * Генератор каталога для командного бота (bot-catalog.js).
 *
 * Зачем: на сервере (services-catalog.js и др.) у каждой услуги есть только
 * цена, лимиты и ID twiboost. Человекочитаемые названия, категории и тип
 * ссылки (пост/канал/видео/профиль) живут во фронтенде — в index.html.
 * Этот скрипт достаёт их оттуда и кладёт в bot-catalog.js, чтобы бот мог
 * показать каталог в чате. ЦЕНЫ отсюда не берутся — бот всегда берёт
 * актуальные цены с сервера (*-services-catalog.js), как и при оплате.
 *
 * Когда запускать: каждый раз, когда вы обновили каталог в index.html
 * (вставили новый раздел, добавили/убрали услуги):
 *
 *     node build-bot-catalog.js
 *
 * и закоммитьте получившийся bot-catalog.js. Если забыть — бот просто не
 * покажет новые услуги (а при старте напишет в лог, сколько услуг не хватает).
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = html.indexOf('const TELEGRAM_SERVICES');
const end = html.indexOf('const SERVICES = [');
if (start < 0 || end < 0 || end < start) {
  console.error('Не нашёл блок каталога в index.html (const TELEGRAM_SERVICES … const SERVICES = [). Структура файла изменилась?');
  process.exit(1);
}

// Блок содержит только объявления const (массивы услуг, категории, сети).
// Выполняем его изолированно и забираем нужные переменные.
const api = new Function(
  html.slice(start, end) +
  ';return { NETWORKS, CATS_BY_NETWORK, lists: { telegram: TELEGRAM_SERVICES, tiktok: TIKTOK_SERVICES, facebook: FACEBOOK_SERVICES, instagram: INSTAGRAM_SERVICES, max: MAX_SERVICES, discord: DISCORD_SERVICES, youtube: YOUTUBE_SERVICES } };'
)();

const out = { networks: [], cats: {}, services: [] };
for (const n of api.NETWORKS) {
  const list = api.lists[n.id];
  if (!list) continue;
  out.networks.push({ id: n.id, label: n.label, icon: n.icon });
  out.cats[n.id] = api.CATS_BY_NETWORK[n.id].map(c => ({ id: c.id, label: c.label }));
  for (const s of list) {
    out.services.push({ id: s.id, net: n.id, cat: s.cat, name: String(s.name).trim(), target: s.target || 'channel' });
  }
}

const lines = [];
lines.push('/* АВТОГЕНЕРАЦИЯ: node build-bot-catalog.js — не редактируйте вручную. */');
lines.push('module.exports = {');
lines.push('  networks: ' + JSON.stringify(out.networks) + ',');
lines.push('  cats: {');
for (const [net, cats] of Object.entries(out.cats)) lines.push(`    ${JSON.stringify(net)}: ${JSON.stringify(cats)},`);
lines.push('  },');
lines.push('  services: [');
for (const s of out.services) lines.push('    ' + JSON.stringify(s) + ',');
lines.push('  ],');
lines.push('};');
lines.push('');

fs.writeFileSync(path.join(__dirname, 'bot-catalog.js'), lines.join('\n'));
console.log(`bot-catalog.js: сетей ${out.networks.length}, услуг ${out.services.length}`);
