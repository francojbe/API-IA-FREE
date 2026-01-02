import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamText } from 'hono/streaming';
import { groqService } from './services/groq';
import { cerebrasService } from './services/cerebras';
import { geminiService } from './services/gemini';
import { openRouterService } from './services/openrouter';
import type { AIService, ChatMessage } from './types';

const availableServices: AIService[] = [];
if (process.env.GROQ_API_KEY) availableServices.push(groqService);
if (process.env.CEREBRAS_API_KEY) availableServices.push(cerebrasService);
if (process.env.GEMINI_API_KEY) availableServices.push(geminiService);

const rotationServices = availableServices.length > 0 ? availableServices : [groqService];
const lastResortService = process.env.OPENROUTER_API_KEY ? openRouterService : null;

const app = new Hono();

// Logger profesional para depuración en tiempo real
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} - ${c.res.status} (${ms}ms)`);
});

app.use('*', cors());

// Middleware de Autenticación
app.use('/v1/*', async (c, next) => {
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) return await next();
  const authHeader = c.req.header('Authorization');
  const apiKey = authHeader ? authHeader.replace('Bearer ', '') : c.req.header('x-api-key');
  if (apiKey !== authSecret) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

app.get('/v1/models', (c) => c.json({
  object: 'list',
  data: [{ id: 'multi-ia-proxy', object: 'model', created: 1677610602, owned_by: 'antigravity' }]
}));

// Normalizador de mensajes súper-robusto para n8n
const cleanMessages = (messages: any[]): ChatMessage[] => {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => {
    // Detectar rol y normalizar a minúsculas
    let role = (m.role || m.type || 'user').toLowerCase();
    if (role === 'human' || role === 'user') role = 'user';
    else if (role === 'ai' || role === 'assistant' || role === 'model') role = 'assistant';
    else if (role === 'system') role = 'system';
    else if (role === 'tool') role = 'tool';

    // Extraer contenido de texto (aplanar arrays de n8n)
    let content = "";
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map((v: any) => v.text || v.text?.content || "").join(' ');
    } else if (m.text) {
      content = typeof m.text === 'string' ? m.text : (m.text.content || "");
    }

    const cleaned: ChatMessage = { role: role as any, content };
    if (m.tool_calls) cleaned.tool_calls = m.tool_calls;
    if (m.tool_call_id) cleaned.tool_call_id = m.tool_call_id;
    if (m.name) cleaned.name = m.name;

    return cleaned;
  }).filter(m => (m.content && m.content.trim() !== '') || m.tool_calls || m.role === 'tool');
};

const normalizeTools = (tools: any[]): any[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(t => {
    if (t.type === 'function' && t.function?.name) return t;
    const name = t.name || t.function?.name;
    const desc = t.description || t.function?.description || '';
    const params = t.parameters || t.function?.parameters || { type: 'object', properties: {} };
    return { type: 'function', function: { name, description: desc, parameters: params } };
  }).filter(t => t.function?.name);
};

const handleChatCompletions = async (c: any) => {
  let body: any;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'Invalid JSON' }, 400); }

  const isResponsesApi = c.req.path.includes('/responses');
  const messages = cleanMessages(body.messages || body.input || []);
  const tools = normalizeTools(body.tools);
  const requestedModel = body.model || 'multi-ia-proxy';
  const requestId = (isResponsesApi ? 'resp_' : 'chatcmpl-') + Math.random().toString(36).substring(7);

  if (body.stream) {
    // ... [Streaming logic maintained, focusing on non-streaming for the tool fix] ...
    return streamText(c, async (stream) => {
      for (const service of rotationServices) {
        try {
          const aiStream = await service.chat(messages, tools);
          for await (const delta of aiStream) {
            const data = JSON.stringify({
              id: requestId,
              object: isResponsesApi ? 'response.chunk' : 'chat.completion.chunk',
              choices: [{ delta, index: 0, finish_reason: null }],
              output: [{ type: 'message', content: delta.content ? [{ type: 'text', text: delta.content }] : [], tool_calls: delta.tool_calls }]
            });
            await stream.write(`data: ${data}\n\n`);
          }
          await stream.write(`data: [DONE]\n\n`);
          return;
        } catch (e) { console.error(`[FAIL] ${service.name}: ${e}`); }
      }
    });
  } else {
    for (const service of [...rotationServices, openRouterService]) {
      if (!service) continue;
      try {
        let fullText = '';
        const toolCallMap = new Map<number, any>();
        const aiStream = await service.chat(messages, tools);

        for await (const delta of aiStream) {
          if (delta.content) fullText += delta.content;
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallMap.has(idx)) toolCallMap.set(idx, { id: tc.id || `call_${Math.random().toString(36).substring(7)}`, type: 'function', function: { name: '', arguments: '' } });
              const entry = toolCallMap.get(idx);
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.function.name += tc.function.name;
              if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
            }
          }
        }

        const toolCalls = Array.from(toolCallMap.values());
        if (!fullText && toolCalls.length === 0) continue;

        const isTool = toolCalls.length > 0;
        console.log(`[SUCCESS] (${service.name}) ${isTool ? `Tools: ${toolCalls.length}` : `Chars: ${fullText.length}`}`);

        // Usage con camelCase para n8n
        const usage = {
          prompt_tokens: messages.length * 10,
          completion_tokens: isTool ? 50 : Math.ceil(fullText.length / 4),
          total_tokens: (messages.length * 10) + 50,
          promptTokens: messages.length * 10,
          completionTokens: isTool ? 50 : Math.ceil(fullText.length / 4),
          totalTokens: (messages.length * 10) + 50
        };

        if (isResponsesApi) {
          // FORMATO RESPONSES API (n8n v2 mejorado)
          return c.json({
            id: requestId,
            object: 'response',
            status: isTool ? 'requires_action' : 'completed',
            model: requestedModel,
            choices: [{ // Algunas versiones de n8n lo siguen necesitando
              index: 0,
              message: { role: 'assistant', content: fullText || null, tool_calls: isTool ? toolCalls : undefined },
              finish_reason: isTool ? 'tool_calls' : 'stop'
            }],
            output: [{
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: fullText ? [{ type: 'text', text: fullText }] : [],
              tool_calls: isTool ? toolCalls : undefined,
              finish_reason: isTool ? 'tool_calls' : 'stop' // CRÍTICO: Añadido finish_reason aquí
            }],
            required_action: isTool ? {
              type: 'submit_tool_outputs',
              submit_tool_outputs: { tool_calls: toolCalls }
            } : undefined,
            usage: usage,
            usage_metadata: usage // Alias extra
          });
        } else {
          // FORMATO CHAT COMPLETION
          return c.json({
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: fullText || null, tool_calls: isTool ? toolCalls : undefined },
              finish_reason: isTool ? 'tool_calls' : 'stop'
            }],
            usage: usage
          });
        }
      } catch (e) { console.error(`[FAIL] ${service.name}: ${e}`); }
    }
    return c.json({ error: 'Fallo total de red' }, 503);
  }
};

app.post('/v1/chat/completions', handleChatCompletions);
app.post('/v1/responses', handleChatCompletions);

app.post('/chat', async (c) => {
  try {
    const body: any = await c.req.json();
    const messages = cleanMessages(body.messages || []);
    return streamText(c, async (stream) => {
      for (const service of rotationServices) {
        try {
          const aiStream = await service.chat(messages);
          for await (const delta of aiStream) if (delta.content) await stream.write(delta.content);
          return;
        } catch (e) { }
      }
    });
  } catch (e) { return c.json({ error: 'Invalid' }, 400); }
});

app.get('/health', (c) => c.json({ status: 'ok', services: rotationServices.map(s => s.name) }));

if (typeof Bun !== 'undefined') {
  const { serveStatic } = await import('hono/bun');
  app.use('/*', serveStatic({ root: './public' }));
  console.log(`Server running on Bun port ${process.env.PORT ?? 3000}`);
} else {
  const { serveStatic } = await import('@hono/node-server/serve-static');
  app.use('/*', serveStatic({ root: './public' }));
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port: Number(process.env.PORT) || 3000 });
}
export default app;
