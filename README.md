# Bun AI API - Enhanced Edition 🚀

Este proyecto es una versión mejorada del original de midudev, diseñada para ser más robusta, segura y compatible.

## Mejoras Implementadas

- **Framework Hono**: Migrado de `Bun.serve` puro a Hono para mejores middlewares y extensibilidad.
- **Multi-Runtime**: Funciona nativamente tanto en **Bun** como en **Node.js** (usando `tsx`).
- **Lógica de Failover**: Si un servicio de IA falla (ej. Groq), el sistema automáticamente intenta con el siguiente (ej. Cerebras) en la misma petición.
- **Protección por API Key**: Soporte opcional para autenticación mediante el header `x-api-key`.
- **Soporte CORS**: Configurado para permitir peticiones desde navegadores.

## Requisitos

1. **Variables de Entorno**: Crea un archivo `.env` basado en `.env.example`:
   ```env
   GROQ_API_KEY=tu_propia_key
   CEREBRAS_API_KEY=tu_propia_key
   AUTH_SECRET=una_clave_para_tu_proxy (opcional)
   ```

2. **Instalación**:
   ```bash
   npm install
   # o si tienes bun
   bun install
   ```

## Ejecución

### Con Bun (Recomendado)
```bash
bun dev
```

### Con Node.js
```bash
npm run node:dev
```

## Uso de la API

### Endpoint `/chat` (POST)
Envía un JSON con los mensajes:
```json
{
  "messages": [
    { "role": "user", "content": "Hola, ¿quién eres?" }
  ]
}
```

**Headers**:
- `Content-Type: application/json`
- `x-api-key: tu_auth_secret` (si configuraste AUTH_SECRET)

### Endpoint `/health` (GET)
Verifica el estado de los servicios.
