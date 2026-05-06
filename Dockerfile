FROM node:20-alpine

RUN npm install -g pnpm@10.26.1

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
