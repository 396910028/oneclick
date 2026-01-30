FROM node:20-alpine

WORKDIR /app

# 设置 npm 镜像源（使用淘宝镜像加速）
RUN npm config set registry https://registry.npmmirror.com && \
    npm config set fetch-timeout 300000 && \
    npm config set fetch-retries 5

COPY package.json package-lock.json* ./

# 使用 npm ci 而不是 npm install（更快、更可靠，需要 package-lock.json）
# 如果没有 package-lock.json，回退到 npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --production --verbose --progress=false; \
    else \
      npm install --production --verbose --progress=false; \
    fi

COPY src ./src

EXPOSE 3000

CMD ["node", "src/app.js"]

