FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY --chown=node:node . .
USER node
ENV BIND=0.0.0.0 PORT=3443
EXPOSE 3443
CMD ["node","server.js"]
