FROM node:20-alpine

RUN npm install -g pnpm@10.26.1

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

# Запускаем миграции БД (игнорируем ошибки), потом стартуем бота
CMD ["sh", "-c", "pnpm --filter @workspace/db run push || echo 'DB migration failed, starting anyway'; node --enable-source-maps artifacts/api-server/dist/index.mjs"]
