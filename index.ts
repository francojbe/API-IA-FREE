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

// Función mejorada para limpiar mensajes de n8n (Roles: system, user, assistant, tool)
const cleanMessages = (messages: ChatMessage[]): ChatMessage[] => {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => {
    let role = m.role || 'user';
    if (role === 'chat' || role === 'model') role = 'assistant';

    const cleaned: any = { role };

    if (m.content !== undefined) {
      if (typeof m.content === 'string') cleaned.content = m.content;
      else if (Array.isArray(m.content)) cleaned.content = m.content.map((c: any) => c.text || JSON.stringify(c)).join(' ');
      else cleaned.content = JSON.stringify(m.content);
    } else {
      cleaned.content = "";
    }

    if (m.tool_calls) cleaned.tool_calls = m.tool_calls;
    if (m.tool_call_id) cleaned.tool_call_id = m.tool_call_id;
    if (m.name) cleaned.name = m.name;

    return cleaned;
  }).filter(m => (m.content && m.content.trim() !== '') || m.tool_calls);
};

// Función para asegurar que las herramientas tengan el formato exacto que Groq/Cerebras piden
const normalizeTools = (tools: any[]): any[] => {
  if (!Array.isArray(tools)) return undefined as any;
  return tools.map(t => {
    // Si ya tiene el formato correcto, lo dejamos
    if (t.type === 'function' && t.function?.name) return t;

    // Si viene "plano" (común en algunas integraciones), lo envolvemos
    if (t.name && (t.parameters || t.arguments)) {
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || t.arguments
        }
      };
    }
    return t;
  }).filter(t => t.function?.name);
};

// POST /v1/chat/completions (Soporta streaming y no-streaming)
const handleChatCompletions = async (c: any) => {
  let body: any;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'Invalid JSON' }, 400); }

  const isResponsesApi = c.req.path.includes('/responses');

  // Extracción ultra-flexible
  let rawMessages = body.messages || [];
  if (rawMessages.length === 0 && Array.isArray(body.input)) {
    rawMessages = body.input.map((m: any) => ({
      role: m.role || (m.type === 'message' ? 'user' : 'system'),
      content: Array.isArray(m.content) ? m.content.map((c: any) => c.text || '').join(' ') : (m.content || m.text || ''),
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id
    }));
  }
  if (rawMessages.length === 0 && body.prompt) rawMessages = [{ role: 'user', content: body.prompt }];

  const messages = cleanMessages(rawMessages);
  const tools = normalizeTools(body.tools); // NORMALIZAR HERRAMIENTAS AQUÍ
  const requestedModel = body.model || 'multi-ia-proxy';
  const requestId = (isResponsesApi ? 'resp_' : 'chatcmpl-') + Math.random().toString(36).substring(7);

  if (messages.length === 0) {
    if (isResponsesApi) {
      return c.json({
        id: requestId, object: 'response', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'text', text: 'Conexión activa.' }] }]
      });
    }
    return c.json({
      id: requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: requestedModel,
      choices: [{ message: { role: 'assistant', content: 'Conexión activa.' }, finish_reason: 'stop', index: 0 }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    });
  }

  if (body.stream) {
    return streamText(c, async (stream) => {
      let success = false;
      for (const service of rotationServices) {
        try {
          const aiStream = await service.chat(messages, tools);
          for await (const delta of aiStream) {
            let data = isResponsesApi ? JSON.stringify({
              id: requestId, object: 'response.chunk', status: 'in_progress',
              output: [{ type: 'message', content: delta.content ? [{ type: 'text', text: delta.content }] : [], tool_calls: delta.tool_calls }]
            }) : JSON.stringify({
              id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
              model: requestedModel, choices: [{ delta, index: 0, finish_reason: null }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          success = true;
          break;
        } catch (e) { console.error(`[FAIL] ${service.name}: ${e}`); }
      }

      const finalData = isResponsesApi
        ? { id: requestId, object: 'response.chunk', status: 'completed' }
        : { id: requestId, object: 'chat.completion.chunk', model: requestedModel, choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] };

      await stream.write(`data: ${JSON.stringify(finalData)}\n\n`);
      await stream.write('data: [DONE]\n\n');
    });
  } else {
    let fullText = '';
    let usedService = 'none';
    let toolCalls: any[] | undefined;

    for (const service of rotationServices) {
      try {
        const aiStream = await service.chat(messages, tools);
        for await (const delta of aiStream) {
          if (delta.content) fullText += delta.content;
          if (delta.tool_calls) {
            if (!toolCalls) toolCalls = [];
            toolCalls.push(...delta.tool_calls);
          }
        }
        if (fullText || toolCalls) { usedService = service.name; break; }
      } catch (e) { console.error(`[FAIL] ${service.name}: ${e}`); }
    }

    if (!fullText && !toolCalls) fullText = "Servicio no disponible.";
    const pTokens = Math.max(1, messages.length * 10);
    const cTokens = Math.ceil(fullText.length / 4);

    console.log(`[SUCCESS] (${isResponsesApi ? 'API Resp' : 'API Chat'}). Service: ${usedService} ${toolCalls ? '(Tool Call)' : ''}`);

    if (isResponsesApi) {
      return c.json({
        id: requestId, object: 'response', status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: fullText ? [{ type: 'text', text: fullText }] : [],
          tool_calls: toolCalls
        }],
        usage: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: pTokens + cTokens }
      });
    }

    return c.json({
      id: requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: requestedModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: fullText || null, tool_calls: toolCalls },
        logprobs: null,
        finish_reason: toolCalls ? 'tool_calls' : 'stop'
      }],
      usage: { prompt_tokens: pTokens, completion_tokens: cTokens, total_tokens: pTokens + cTokens }
    });
  }
};

app.post('/v1/chat/completions', handleChatCompletions);
app.post('/v1/chat/completions/', handleChatCompletions);
app.post('/v1/responses', handleChatCompletions);
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
        for await (const delta of aiStream) await stream.write(delta.content || '');
        return;
      } catch (e) { }
    }
    if (lastResortService) {
      try {
        const aiStream = await lastResortService.chat(messages);
        for await (const delta of aiStream) await stream.write(delta.content || '');
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
