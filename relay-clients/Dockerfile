FROM node:22.22.0-slim AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY relay/package.json relay/package.json
COPY relay-clients/package.json relay-clients/package.json
RUN npm ci --ignore-scripts

FROM dependencies AS builder
COPY relay-clients/tsconfig.json relay-clients/*.ts relay-clients/
RUN npm run build --workspace=oracle-relay-client

FROM node:22.22.0-slim AS runtime
WORKDIR /workspace/relay-clients
ENV NODE_ENV=production
COPY package.json package-lock.json /workspace/
COPY relay/package.json /workspace/relay/package.json
COPY relay-clients/package.json /workspace/relay-clients/package.json
RUN cd /workspace && npm ci --omit=dev --ignore-scripts --workspace=oracle-relay-client
COPY --from=builder /workspace/relay-clients/dist/relay-client.js ./relay-client.js
COPY --from=builder /workspace/relay-clients/dist/openbao-auth.js ./openbao-auth.js
USER node
CMD ["node", "relay-client.js"]
