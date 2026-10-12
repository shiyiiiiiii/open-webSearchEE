# 使用受支持的 Node.js 22 LTS Alpine 基础镜像
FROM node:22-alpine AS build

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
# linux/arm64 Alpine 可能没有 koffi 预编译包，需要临时工具链从源码编译 native 模块。
RUN apk upgrade --no-cache && \
    apk add --no-cache libstdc++ && \
    apk add --no-cache --virtual .native-build-deps python3 make g++ cmake && \
    npm ci && \
    npm cache clean --force && \
    apk del .native-build-deps

# 拷贝源码
COPY . .

# 构建项目
RUN npm run build && \
    cp -a node_modules/playwright-core /opt/playwright-core && \
    npm prune --omit=dev --ignore-scripts && \
    npm cache clean --force

# 运行镜像保留构建产物、生产依赖及浏览器核心客户端。
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk upgrade --no-cache && \
    apk add --no-cache libstdc++ && \
    rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /opt/playwright-core ./node_modules/playwright-core

# 创建非root用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 更改文件所有权
RUN chown -R nodejs:nodejs /app
USER nodejs

# 设置环境变量
ENV NODE_ENV=production
# 默认端口设置，可被部署环境覆盖
ENV PORT=3000

# 暴露端口（使用ARG允许构建时覆盖）
EXPOSE ${PORT}

# 启动命令
CMD ["node", "build/index.js"]
