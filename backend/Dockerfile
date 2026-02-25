# backend/Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copiar dependencias primero (cacheo de capas)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copiar código
COPY . .

# Railway inyecta PORT automáticamente
EXPOSE $PORT

CMD ["node", "server.js"]