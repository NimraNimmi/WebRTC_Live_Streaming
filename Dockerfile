# Lightweight Node image — this project has no build step (plain ES modules,
# no TypeScript/bundler), so we just install deps and run.
FROM node:22-alpine

WORKDIR /app

# Install dependencies first (better Docker layer caching — only re-runs
# npm install when package.json actually changes).
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Fly.io sets PORT via the [env] block in fly.toml; server.js already
# reads process.env.PORT, so no extra wiring needed here.
EXPOSE 3000

CMD ["npm", "start"]
