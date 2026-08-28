FROM node:20-slim

# 安装中文字体支持 (防止 Canvas 中文乱码)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-wqy-microhei \
    fonts-wqy-zenhei \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# 设置时区为上海
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# 复制依赖定义并安装
COPY package*.json ./
RUN npm install --omit=dev

# 复制项目源码
COPY . .

# 启动服务
CMD ["node", "futures-tracker/index.js"]
