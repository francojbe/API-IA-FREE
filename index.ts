import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamText } from 'hono/streaming';
import { groqService } from './services/groq';
import { cerebrasService } from './services/cerebras';
import { geminiService } from './services/gemini';
import { openRouterService } from './services/openrouter';
import type { AIService, ChatMessage } from './types';

// 1. Servicios principales para Rotación (Round Robin)
const availableServices: AIService[] = [];
if (process.env.GROQ_API_KEY) availableServices.push(groqService);
if (process.env.CEREBRAS_API_KEY) availableServices.push(cerebrasService);
if (process.env.GEMINI_API_KEY) availableServices.push(geminiService);

const rotationServices = availableServices.length > 0 ? availableServices : [groqService];

// 2. Servicio de última instancia (Last Resort)
const lastResortService = process.env.OPENROUTER_API_KEY ? openRouterService : null;

let currentServiceIndex = 0;

const app = new Hono();

// Middlewares
app.use('*', cors());

// Middleware de autenticación simple
app.use('/chat', async (c, next) => {
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret) {
    const apiKey = c.req.header('x-api-key');
    if (apiKey !== authSecret) {
      return c.json({ error: 'Unauthorized: Invalid API Key' }, 401);
    }
  }
  await next();
});

// Endpoint principal de chat con lógica de rotación + fallback final
app.post('/chat', async (c) => {
  const { messages } = await c.req.json() as { messages: ChatMessage[] };
  const startTime = Date.now();

  return streamText(c, async (stream) => {
    let success = false;
    let attempts = 0;
    let usedService = '';

    // FASE 1: Intentar con la rotación principal
    while (!success && attempts < rotationServices.length) {
      const service = rotationServices[currentServiceIndex];
      if (!service) {
        currentServiceIndex = (currentServiceIndex + 1) % rotationServices.length;
        attempts++;
        continue;
      }

      currentServiceIndex = (currentServiceIndex + 1) % rotationServices.length;
      attempts++;

      try {
        const aiStream = await service.chat(messages);
        usedService = service.name;

        for await (const chunk of aiStream) {
          await stream.write(chunk);
        }
        success = true;
      } catch (error) {
        console.error(`[FAIL] ${service.name} falló. Probando siguiente...`);
      }
    }

    // FASE 2: Fallback a OpenRouter
    if (!success && lastResortService) {
      try {
        const aiStream = await lastResortService.chat(messages);
        usedService = lastResortService.name;

        for await (const chunk of aiStream) {
          await stream.write(chunk);
        }
        success = true;
      } catch (error) {
        console.error(`[CRITICAL] Todos los servicios fallaron, incluido OpenRouter.`);
      }
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    if (success) {
      console.log(`[SUCCESS] Model: ${usedService} | Time: ${duration}ms`);
    } else {
      console.log(`[ERROR] No service could respond | Total Time: ${duration}ms`);
      await stream.write('\nError: No se pudo obtener respuesta de ningún modelo.');
    }
  });
});

// Health check
app.get('/health', (c) => {
  const serviceNames = rotationServices.map(s => s.name);
  if (lastResortService) {
    serviceNames.push(lastResortService.name + ' (last resort)');
  }
  return c.json({ status: 'ok', services: serviceNames });
});

// Inicio del servidor según el runtime
if (typeof Bun !== 'undefined') {
  console.log(`Server running on Bun port ${process.env.PORT ?? 3000}`);
  Bun.serve({
    fetch: app.fetch,
    port: process.env.PORT ?? 3000,
  });
} else {
  // Fallback para Node.js
  const { serve } = await import('@hono/node-server');
  const port = Number(process.env.PORT) || 3000;
  console.log(`Server running on Node.js port ${port}`);
  serve({
    fetch: app.fetch,
    port,
  });
}

export default app;
