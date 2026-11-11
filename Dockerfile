FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY proxy.mjs ./
COPY tools ./tools
COPY vendor ./vendor
ENV NODE_ENV=production
ENV PORT=8080
ENV FREEPI_PROXY_HOST=0.0.0.0
ENV FREEPI_PROXY_PORT=8080
ENV FREEPI_AUTO_SPONSOR=0
ENV FREEPI_ACCOUNTS_PATH=/tmp/freepi/accounts.json
ENV FREEPI_ACCOUNTS_SEED_PATH=/secrets/accounts.json
ENV FREEPI_STATE_DIR=/tmp/freepi
EXPOSE 8080
CMD ["node", "proxy.mjs"]
