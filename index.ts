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

// 1. Logger Global (Para ver en Easypanel qué está pasando)
app.use('*', async (c, next) => {
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.url}`);
  await next();
});

// 2. Middleware de CORS
app.use('*', cors());

// --- ENDPOINTS COMPATIBLES CON OPENAI (/v1) ---

// Middleware de autenticación para /v1
app.use('/v1/*', async (c, next) => {
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret) {
    const authHeader = c.req.header('Authorization');
    const apiKey = authHeader ? authHeader.replace('Bearer ', '') : c.req.header('x-api-key');
    if (apiKey !== authSecret) {
      console.warn(`[AUTH] Intento de acceso no autorizado a ${c.req.url}`);
      return c.json({ error: 'Unauthorized: Invalid API Key' }, 401);
    }
  }
  await next();
});

// Listar modelos (Obligatorio para n8n)
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      { id: 'multi-ia-proxy', object: 'model', created: 1677610602, owned_by: 'antigravity' }
    ]
  });
});

app.get('/v1', (c) => c.json({ status: 'active', compatible: 'openai' }));

// Endpoint de Chat Completions
app.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json();
  const messages = body.messages as ChatMessage[];
  const streamRequested = body.stream === true;

  if (streamRequested) {
    return streamText(c, async (stream) => {
      let success = false;
      for (const service of rotationServices) {
        try {
          const aiStream = await service.chat(messages);
          for await (const chunk of aiStream) {
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
          for await (const chunk of aiStream) {
            const data = JSON.stringify({
              choices: [{ delta: { content: chunk } }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          success = true;
        } catch (e) { }
      }
      await stream.write('data: [DONE]\n\n');
    });
  } else {
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
      id: 'chatcmpl-' + Math.random().toString(36).substring(7),
      object: 'chat.completion',
      created: Date.now(),
      model: 'multi-ia-proxy',
      choices: [{ message: { role: 'assistant', content: fullText }, finish_reason: 'stop', index: 0 }]
    });
  }
});

// --- ENDPOINTS ORIGINALES (/chat) ---

app.use('/chat', async (c, next) => {
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret && c.req.header('x-api-key') !== authSecret) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

app.post('/chat', async (c) => {
  const { messages } = await c.req.json() as { messages: ChatMessage[] };
  return streamText(c, async (stream) => {
    let success = false;
    for (const service of rotationServices) {
      try {
        const aiStream = await service.chat(messages);
        for await (const chunk of aiStream) await stream.write(chunk);
        success = true;
        break;
      } catch (e) { }
    }
    if (!success && lastResortService) {
      try {
        const aiStream = await lastResortService.chat(messages);
        for await (const chunk of aiStream) await stream.write(chunk);
        success = true;
      } catch (e) { }
    }
    if (!success) await stream.write('\nError: No se pudo obtener respuesta.');
  });
});

app.get('/health', (c) => c.json({ status: 'ok', services: rotationServices.map(s => s.name) }));

// --- ARCHIVOS ESTÁTICOS ---
if (typeof Bun !== 'undefined') {
  const { serveStatic } = await import('hono/bun');
  app.use('/*', serveStatic({ root: './public' }));
} else {
  const { serveStatic } = await import('@hono/node-server/serve-static');
  app.use('/*', serveStatic({ root: './public' }));
}

// Iniciar servidor
if (typeof Bun !== 'undefined') {
  console.log(`Server running on Bun port ${process.env.PORT ?? 3000}`);
} else {
  const { serve } = await import('@hono/node-server');
  const port = Number(process.env.PORT) || 3000;
  console.log(`Server running on Node.js port ${port}`);
  serve({ fetch: app.fetch, port });
}

export default app;
