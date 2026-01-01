FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Exponer el puerto por defecto
EXPOSE 3000

# Comando para iniciar la aplicación en Node.js
CMD ["npm", "run", "node:start"]
