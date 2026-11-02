# FleetDispatch Server — Docker 版。Node 24 直接執行 TypeScript、使用內建的 node:sqlite：執行時沒有任何 npm 套件。
# 架設步驟：docs/setup-docker.md
FROM node:24-slim

ENV NODE_ENV=production \
    FD_DATA_DIR=/data \
    FD_PORT=8080 \
    FD_HOST=0.0.0.0

WORKDIR /app
COPY package.json ./
COPY core ./core
COPY docker ./docker

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FD_PORT||8080)+'/api/v1/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "docker/src/server.ts"]
