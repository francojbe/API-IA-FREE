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
// Función mejorada para limpiar mensajes de n8n (Roles: system, user, assistant)
const cleanMessages = (messages: ChatMessage[]): ChatMessage[] => {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => {
    let role = m.role || 'user';
    if (role === 'chat' || role === 'model') role = 'assistant'; // Mapeo de roles raros

    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map((c: any) => c.text || JSON.stringify(c)).join(' ');
    else content = JSON.stringify(m.content || '');

    return { role, content };
  }).filter(m => m.content && m.content.trim() !== '');
};

// POST /v1/chat/completions (Soporta streaming y no-streaming)
const handleChatCompletions = async (c: any) => {
  let body: any;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'Invalid JSON' }, 400); }

  // Extracción ultra-flexible
  let rawMessages = body.messages || [];
  if (rawMessages.length === 0 && Array.isArray(body.input)) {
    rawMessages = body.input.map((m: any) => ({
      role: m.role || (m.type === 'message' ? 'user' : 'system'),
      content: m.content || m.text || ''
    }));
  }
  if (rawMessages.length === 0 && body.prompt) rawMessages = [{ role: 'user', content: body.prompt }];

  const messages = cleanMessages(rawMessages);
  const requestedModel = body.model || 'multi-ia-proxy';
  const requestId = 'chatcmpl-' + Math.random().toString(36).substring(7);

  if (messages.length === 0) {
    console.warn(`[DEBUG] No se detectaron mensajes en n8n. Enviando respuesta de prueba.`);
    return c.json({
      id: requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: requestedModel,
      choices: [{ message: { role: 'assistant', content: 'Conexión activa. Por favor envía un mensaje.' }, finish_reason: 'stop', index: 0 }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
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
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
              model: requestedModel, choices: [{ delta: { content: chunk }, index: 0, finish_reason: null }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          success = true;
          break;
        } catch (e) { console.error(`[FAIL] ${service.name}: ${e}`); }
      }
      if (!success && lastResortService) {
        try {
          const aiStream = await lastResortService.chat(messages);
          for await (const chunk of aiStream) {
            const data = JSON.stringify({
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
              model: requestedModel, choices: [{ delta: { content: chunk }, index: 0, finish_reason: null }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          success = true;
        } catch (e) { }
      }
      await stream.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', model: requestedModel, choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}\n\n`);
      await stream.write('data: [DONE]\n\n');
    });
  } else {
    let fullText = '';
    let usedService = 'none';
    for (const service of rotationServices) {
      try {
        const aiStream = await service.chat(messages);
        for await (const chunk of aiStream) fullText += chunk;
        if (fullText) { usedService = service.name; break; }
      } catch (e) { console.error(`[FAIL] ${service.name}: ${e}`); }
    }
    if (!fullText && lastResortService) {
      try {
        const aiStream = await lastResortService.chat(messages);
        for await (const chunk of aiStream) fullText += chunk;
        if (fullText) usedService = lastResortService.name;
      } catch (e) { }
    }

    if (!fullText) fullText = "Lo siento, todos los servicios de IA están ocupados. Intenta de nuevo en unos segundos.";

    // Cálculo preciso de tokens (LangChain es estricto con los enteros y la suma total)
    const promptTokens = Math.max(1, messages.length * 10);
    const completionTokens = Math.ceil(fullText.length / 4);
    const totalTokens = promptTokens + completionTokens;

    const responseBody = {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: fullText },
        logprobs: null, // Obligatorio para algunas versiones de LangChain
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens
      }
    };

    console.log(`[SUCCESS] Respondido con ${usedService}. Tokens: ${totalTokens}`);

    return c.json(responseBody);
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
