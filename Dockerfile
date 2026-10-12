FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
RUN mkdir -p /app/tmp /app/output && chown -R node:node /app
USER node

EXPOSE 8080
CMD ["npm", "start"]
