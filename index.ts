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

// Servir archivos estáticos (Frontend)
if (typeof Bun !== 'undefined') {
  const { serveStatic } = await import('hono/bun');
  app.use('/*', serveStatic({ root: './public' }));
} else {
  const { serveStatic } = await import('@hono/node-server/serve-static');
  app.use('/*', serveStatic({ root: './public' }));
}

// Endpoint compatible con OpenAI (Para n8n, Cursor, TypingMind, etc.)
app.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json();
  const messages = body.messages as ChatMessage[];
  const streamRequested = body.stream === true;

  if (streamRequested) {
    return streamText(c, async (stream) => {
      let success = false;
      let usedService = '';

      // Usamos la misma lógica de failover que el endpoint original
      for (const service of rotationServices) {
        try {
          const aiStream = await service.chat(messages);
          usedService = service.name;
          for await (const chunk of aiStream) {
            // Formato de streaming de OpenAI (SSE)
            const data = JSON.stringify({
              choices: [{ delta: { content: chunk } }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          success = true;
          break;
        } catch (e) {
          console.error(`[OpenAI-Compat] Falló ${service.name}`);
        }
      }

      if (!success && lastResortService) {
        try {
          const aiStream = await lastResortService.chat(messages);
          usedService = lastResortService.name;
          for await (const chunk of aiStream) {
            const data = JSON.stringify({
              choices: [{ delta: { content: chunk } }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          success = true;
        } catch (e) {
          console.error(`[OpenAI-Compat] Falló Fallback`);
        }
      }

      await stream.write('data: [DONE]\n\n');
    });
  } else {
    // Si no se pide streaming, recolectamos todo y respondemos un JSON normal
    let fullText = '';
    let success = false;
    for (const service of rotationServices) {
      try {
        const aiStream = await service.chat(messages);
        for await (const chunk of aiStream) fullText += chunk;
        success = true;
        break;
      } catch (e) { }
    }

    if (!success && lastResortService) {
      try {
        const aiStream = await lastResortService.chat(messages);
        for await (const chunk of aiStream) fullText += chunk;
        success = true;
      } catch (e) { }
    }

    return c.json({
      choices: [{ message: { role: 'assistant', content: fullText } }]
    });
  }
});

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

// Alias para el middleware en la ruta OpenAI-compatible
app.use('/v1/*', async (c, next) => {
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret) {
    // n8n envía la clave como "Authorization: Bearer Clave"
    const authHeader = c.req.header('Authorization');
    const apiKey = authHeader ? authHeader.replace('Bearer ', '') : c.req.header('x-api-key');

    if (apiKey !== authSecret) {
      return c.json({ error: 'Unauthorized' }, 401);
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
  // En Bun, no llamamos a Bun.serve() manualmente porque 
  // la exportación por defecto de Hono ya lo activa.
  console.log(`Server running on Bun port ${process.env.PORT ?? 3000}`);
} else {
  // Solo en Node.js necesitamos el servidor manual
  const { serve } = await import('@hono/node-server');
  const port = Number(process.env.PORT) || 3000;
  console.log(`Server running on Node.js port ${port}`);
  serve({
    fetch: app.fetch,
    port,
  });
}

export default app;
