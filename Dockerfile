FROM node:24-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Application code
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

# Role selected at runtime via APP_ROLE (server | prober | all). Default: all.
CMD ["node", "src/index.js"]
