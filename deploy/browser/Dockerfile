FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ cmake libstdc++ && npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && cp -a node_modules/playwright-core /opt/playwright-core && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
WORKDIR /app
RUN apk upgrade --no-cache && apk add --no-cache chromium iptables su-exec libstdc++ && \
    addgroup -g 1200 -S worker && adduser -u 1200 -S -G worker worker
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /opt/playwright-core ./node_modules/playwright-core
COPY --from=build /app/package.json ./package.json
COPY deploy/browser/entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
