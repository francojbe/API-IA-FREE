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

const app = new Hono();

// 1. Logger de solicitudes para Easypanel
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} - ${c.res.status} (${ms}ms)`);
});

app.use('*', cors());

// --- ENDPOINTS OPENAI COMPATIBLES ---

// Middleware de Autenticación para /v1
app.use('/v1/*', async (c, next) => {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) return await next();

  const authHeader = c.req.header('Authorization');
  const apiKey = authHeader ? authHeader.replace('Bearer ', '') : c.req.header('x-api-key');

  if (apiKey !== authSecret) {
    console.warn(`[AUTH FAIL] Clave inválida desde: ${c.req.header('user-agent')}`);
    return c.json({ error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401);
  }
  await next();
});

// GET /v1/models (Obligatorio para n8n)
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [{ id: 'multi-ia-proxy', object: 'model', created: 1677610602, owned_by: 'antigravity' }]
  });
});

// Función para limpiar mensajes de n8n/LangChain
const cleanMessages = (messages: ChatMessage[]): ChatMessage[] => {
  return messages.map(m => ({
    role: m.role || 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  })).filter(m => m.content && m.content.trim() !== '');
};

// POST /v1/chat/completions (Soporta streaming y no-streaming)
const handleChatCompletions = async (c: any) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch (e) {
    console.error(`[ERROR] No se pudo parsear el JSON de la petición`);
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Lógica de extracción ultra-flexible para n8n
  let rawMessages = body.messages || [];

  // Si no hay messages, probamos con 'prompt' (común en algunos nodos)
  if (rawMessages.length === 0 && body.prompt) {
    rawMessages = [{ role: 'user', content: body.prompt }];
  }

  const messages = cleanMessages(rawMessages);
  const modelId = 'multi-ia-proxy';
  const requestId = 'chatcmpl-' + Math.random().toString(36).substring(7);

  // Si después de todo sigue vacío, logueamos el cuerpo COMPLETO para investigar
  if (messages.length === 0) {
    console.warn(`[DEBUG] Petición recibida sin mensajes. Cuerpo completo: ${JSON.stringify(body)}`);
    // En lugar de error, devolvemos un saludo de prueba para que n8n no se rompa
    return c.json({
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ message: { role: 'assistant', content: 'Conexión exitosa. Esperando mensajes...' }, finish_reason: 'stop', index: 0 }]
    });
  }

  if (body.stream) {
    return streamText(c, async (stream) => {
      let success = false;
      for (const service of rotationServices) {
        try {
          const aiStream = await service.chat(messages);
          for await (const chunk of aiStream) {
            const data = JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ delta: { content: chunk }, index: 0, finish_reason: null }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          success = true;
          break;
        } catch (e) {
          console.error(`[FAIL] ${service.name}:`, e instanceof Error ? e.message : e);
        }
      }

      if (!success && lastResortService) {
        try {
          const aiStream = await lastResortService.chat(messages);
          for await (const chunk of aiStream) {
            const data = JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{ delta: { content: chunk }, index: 0, finish_reason: null }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          success = true;
        } catch (e) {
          console.error(`[CRITICAL] Error en Fallback final:`, e instanceof Error ? e.message : e);
        }
      }

      const finalData = JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }]
      });
      await stream.write(`data: ${finalData}\n\n`);
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
      } catch (e) {
        console.error(`[FAIL NON-STREAM] ${service.name}:`, e instanceof Error ? e.message : e);
      }
    }

    if (!success && lastResortService) {
      try {
        const aiStream = await lastResortService.chat(messages);
        for await (const chunk of aiStream) fullText += chunk;
        success = true;
      } catch (e) {
        console.error(`[CRITICAL NON-STREAM] Fallback:`, e instanceof Error ? e.message : e);
      }
    }

    return c.json({
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ message: { role: 'assistant', content: fullText }, finish_reason: 'stop', index: 0 }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  }
};

app.post('/v1/chat/completions', handleChatCompletions);
app.post('/v1/chat/completions/', handleChatCompletions);
app.post('/v1/responses', handleChatCompletions); // Soporte para n8n/LangChain específico
app.post('/v1/responses/', handleChatCompletions);

// --- ENDPOINTS ORIGINALES ---

app.post('/chat', async (c) => {
  const { messages } = await c.req.json() as { messages: ChatMessage[] };
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret && c.req.header('x-api-key') !== authSecret) return c.json({ error: 'Unauthorized' }, 401);

  return streamText(c, async (stream) => {
    for (const service of rotationServices) {
      try {
        const aiStream = await service.chat(messages);
        for await (const chunk of aiStream) await stream.write(chunk);
        return;
      } catch (e) { }
    }
    if (lastResortService) {
      try {
        const aiStream = await lastResortService.chat(messages);
        for await (const chunk of aiStream) await stream.write(chunk);
        return;
      } catch (e) { }
    }
    await stream.write('Error: No se pudo obtener respuesta.');
  });
});

app.get('/health', (c) => c.json({ status: 'ok', services: rotationServices.map(s => s.name) }));

// --- SERVIDOR DE ARCHIVOS Y RUTAS ---

if (typeof Bun !== 'undefined') {
  const { serveStatic } = await import('hono/bun');
  app.use('/*', serveStatic({ root: './public' }));
} else {
  const { serveStatic } = await import('@hono/node-server/serve-static');
  app.use('/*', serveStatic({ root: './public' }));
}

if (typeof Bun !== 'undefined') {
  console.log(`Server running on Bun port ${process.env.PORT ?? 3000}`);
} else {
  const { serve } = await import('@hono/node-server');
  const port = Number(process.env.PORT) || 3000;
  console.log(`Server running on Node.js port ${port}`);
  serve({ fetch: app.fetch, port });
}

export default app;
