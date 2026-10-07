# Small image: Node has no dependencies to install. Runs as a non-root user.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json server.js adapters.js poller.js notifier.js baseline.js ./
COPY public ./public
# State is saved here. Without a volume it is lost on restart, which is fine: data refetches within seconds.
RUN mkdir -p /data && chown -R node:node /data /app
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data TRUST_PROXY=1
USER node
EXPOSE 8787
# /healthz needs no password. Hosting platforms usually probe the port themselves.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
