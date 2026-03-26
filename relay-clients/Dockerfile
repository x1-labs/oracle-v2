FROM node:22-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY relay-client.ts .
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY --from=builder /app/dist/relay-client.js .
CMD ["node", "relay-client.js"]
