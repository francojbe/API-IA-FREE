FROM oven/bun:latest

WORKDIR /app

# Copiar archivos de dependencias
COPY package.json bun.lock ./

# Instalar dependencias usando Bun
RUN bun install --frozen-lockfile

# Copiar el resto del código
COPY . .

# Exponer el puerto
EXPOSE 3000

# Comando para iniciar la aplicación con Bun
CMD ["bun", "run", "index.ts"]
