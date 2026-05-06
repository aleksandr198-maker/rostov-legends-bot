# Легенды Ростова — Telegram Referral Bot

Telegram бот для канала @rostovlegends, который раздаёт звёзды пользователям за привлечение новых подписчиков через реферальные ссылки.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — запустить API сервер + Telegram бот (port 5000)
- `pnpm run typecheck` — полная проверка типов
- `pnpm run build` — typecheck + сборка всех пакетов
- `pnpm --filter @workspace/db run push` — применить изменения схемы БД (только dev)
- Required env: `DATABASE_URL` — строка подключения к Postgres
- Required secret: `TELEGRAM_BOT_TOKEN` — токен бота от @BotFather

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Telegram: node-telegram-bot-api (polling mode)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/lib/bot.ts` — весь код Telegram бота
- `lib/db/src/schema/users.ts` — таблица пользователей с реферальной статистикой
- `lib/db/src/schema/referrals.ts` — таблица реферальных связей
- `artifacts/api-server/src/routes/` — Express маршруты

## Architecture decisions

- Бот работает в polling режиме, встроен в Express сервер (импортируется в `index.ts`)
- Реферальный код генерируется в формате `ref_<telegramId>_<random>` и передаётся через deep link (`?start=ref_...`)
- Подписка на канал проверяется через `getChatMember` при каждом реферале
- Начисление звёзд происходит только если новый пользователь реально подписан на канал
- Повторное начисление защищено проверкой по таблице `referrals` (уникальный `inviteeTelegramId`)

## Product

- `/start` — регистрация, выдача персональной реферальной ссылки
- `/stats` — статистика: сколько приглашено, сколько звёзд заработано
- `/pay` — запрос на выплату звёзд (минимум 10 приглашённых, максимум 50 звёзд)
- `/help` — список команд
- Автоматическое уведомление пригласившего при новом подписчике

## User preferences

- Канал: @rostovlegends
- 1 звезда за каждого приглашённого подписчика
- Минимум для выплаты: 10 человек
- Максимум звёзд: 50

## Gotchas

- Бот должен быть администратором канала, чтобы проверять подписку через `getChatMember`
- При polling режиме нельзя запускать два экземпляра бота одновременно
- Токен хранится в Replit Secrets как `TELEGRAM_BOT_TOKEN`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
