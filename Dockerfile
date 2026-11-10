FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY proxy.mjs ./
COPY tools ./tools
COPY vendor ./vendor
ENV NODE_ENV=production
ENV FREEPI_PROXY_PORT=8080
ENV FREEPI_AUTO_SPONSOR=0
EXPOSE 8080
CMD ["node", "proxy.mjs"]
