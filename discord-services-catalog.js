BOT_TOKEN=8924068346:AAFXpIqN5FC6nNFby-YiTWgDiBmM2jofEUI
OWNER_CHAT_ID=7857672682
WEBAPP_URL=https://afafafaf-production.up.railway.app/
PORT=3000
TWIBOOST_API_KEY=CnKHTkjxIgNntS22aIH5Qs4IWVlONnjLpgels0lYiC5efQYX5DenZO2HFcaZ
# Один и тот же ключ используется и для автовыдачи (server.js), и для
# скрипта fetch-twiboost-services.js, которым генерируются новые разделы
# (например TikTok) — см. инструкцию в начале того скрипта.

# Пароль для админ-панели (https://ваш-домен/admin). Без него /admin
# отвечает 503. Логин браузер не спросит отдельно — подойдёт любой,
# главное пароль. Открывайте панель только по https.
ADMIN_PASSWORD=придумайте_надёжный_пароль

# Необязательно: ссылка, куда бот просит покупателя оставить отзыв после
# выполнения заказа. Если не задать — используется ссылка по умолчанию,
# зашитая в server.js.
REVIEW_LINK=https://t.me/yanvismokcoded/12

# Необязательно: путь к файлу, где хранятся балансы/история заказов.
# Если в Railway подключён Volume (Settings → Volumes), сервер САМ найдёт
# его через переменную RAILWAY_VOLUME_MOUNT_PATH — эту переменную задавать
# не нужно. Указывайте DATA_FILE вручную только если хотите другой путь/имя.
# DATA_FILE=data.json
