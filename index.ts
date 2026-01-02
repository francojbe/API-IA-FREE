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

app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} - ${c.res.status} (${ms}ms)`);
});

app.use('*', cors());

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

const cleanMessages = (messages: any[]): ChatMessage[] => {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => {
    let role = m.role || 'user';
    if (role === 'chat' || role === 'model') role = 'assistant';

    // Si el contenido viene como array de n8n, lo aplanamos
    let content = "";
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.map((v: any) => v.text || "").join(' ');
    else if (m.text) content = m.text;

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
    if (t.name) return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } };
    return t;
  }).filter(t => t.function?.name);
};

const handleChatCompletions = async (c: any) => {
  let body: any;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'Invalid JSON' }, 400); }

  const isResponsesApi = c.req.path.includes('/responses');
  console.log(`[IN] Path: ${c.req.path} | Mode: ${isResponsesApi ? 'Responses (Agent)' : 'Chat (Standard)'}`);

  let rawMessages = body.messages || [];
  if (rawMessages.length === 0 && Array.isArray(body.input)) {
    rawMessages = body.input.map((m: any) => ({
      role: m.role || (m.type === 'message' ? 'user' : 'system'),
      content: m.content || m.text || '',
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id
    }));
  }
  if (rawMessages.length === 0 && body.prompt) rawMessages = [{ role: 'user', content: body.prompt }];

  const messages = cleanMessages(rawMessages);
  const tools = normalizeTools(body.tools);
  const requestedModel = body.model || 'multi-ia-proxy';
  const requestId = (isResponsesApi ? 'resp_' : 'chatcmpl-') + Math.random().toString(36).substring(7);

  if (body.stream) {
    return streamText(c, async (stream) => {
      for (const service of rotationServices) {
        try {
          const aiStream = await service.chat(messages, tools);
          for await (const delta of aiStream) {
            const data = JSON.stringify({
              id: requestId,
              object: isResponsesApi ? 'response.chunk' : 'chat.completion.chunk',
              model: requestedModel,
              choices: isResponsesApi ? undefined : [{ delta, index: 0, finish_reason: null }],
              output: isResponsesApi ? [{ type: 'message', content: delta.content ? [{ type: 'text', text: delta.content }] : [], tool_calls: delta.tool_calls }] : undefined
            });
            await stream.write(`data: ${data}\n\n`);
          }
          await stream.write(`data: [DONE]\n\n`);
          return;
        } catch (e) { console.error(`[FAIL] ${service.name}: ${e}`); }
      }
    });
  } else {
    for (const service of [...rotationServices, openRouterService]) { // Fallback directo
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

        // Si no hay respuesta de ningún tipo, pasamos al siguiente servicio
        if (!fullText && toolCalls.length === 0) {
          console.warn(`[EMPTY] ${service.name} devolvió respuesta vacía. Saltando...`);
          continue;
        }

        const isTool = toolCalls.length > 0;
        console.log(`[SUCCESS] (${service.name}) ${isTool ? `Tools: ${toolCalls.length}` : `Chars: ${fullText.length}`}`);

        if (isResponsesApi) {
          // RESPUESTA DE AGENTE PURA (n8n v2/v3)
          return c.json({
            id: requestId,
            object: 'response',
            status: isTool ? 'requires_action' : 'completed',
            model: requestedModel,
            output: [{
              type: 'message',
              role: 'assistant',
              content: fullText ? [{ type: 'text', text: fullText }] : [],
              tool_calls: isTool ? toolCalls : undefined
            }],
            required_action: isTool ? {
              type: 'submit_tool_outputs',
              submit_tool_outputs: { tool_calls: toolCalls }
            } : undefined,
            usage: { prompt_tokens: messages.length * 10, completion_tokens: 50, total_tokens: 100 }
          });
        } else {
          // RESPUESTA CHAT CLÁSICA
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
            usage: { prompt_tokens: messages.length * 10, completion_tokens: 50, total_tokens: 100 }
          });
        }
      } catch (e) { console.error(`[FAIL] ${service.name}: ${e}`); }
    }

    // Respuesta de emergencia si todo falla
    return c.json({
      id: requestId,
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'text', text: "Lo siento, las IA están saturadas. Por favor reintenta en unos segundos." }] }]
    }, 200); // 200 para no romper el flujo de n8n
  }
};

app.post('/v1/chat/completions', handleChatCompletions);
app.post('/v1/responses', handleChatCompletions);

app.post('/chat', async (c) => {
  try {
    const body: any = await c.req.json();
    const messages = cleanMessages(body.messages || []);
    return streamText(c, async (stream) => {
      for (const service of [...rotationServices, openRouterService]) {
        if (!service) continue;
        try {
          const aiStream = await service.chat(messages);
          for await (const delta of aiStream) if (delta.content) await stream.write(delta.content);
          return;
        } catch (e) { }
      }
    });
  } catch (e) { return c.json({ error: 'Invalid Request' }, 400); }
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
