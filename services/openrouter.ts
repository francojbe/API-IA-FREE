import type { AIService, ChatMessage } from '../types';

const FREE_MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-2.0-flash-exp:free',
    'mistralai/mistral-small-3.1-24b-instruct:free'
];

export const openRouterService: AIService = {
    name: 'OpenRouter (Last Resort)',
    async chat(messages: ChatMessage[]) {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OpenRouter API Key no configurada');

        let lastError: any;

        // El propio servicio de OpenRouter intentará sus modelos gratuitos uno por uno
        for (const model of FREE_MODELS) {
            try {
                console.log(`[OpenRouter Fallback] Intentando con modelo: ${model}`);

                const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                        "HTTP-Referer": "http://localhost:3000", // Opcional para OpenRouter ranking
                        "X-Title": "Multi-IA Proxy",
                    },
                    body: JSON.stringify({
                        "model": model,
                        "messages": messages,
                        "stream": true
                    })
                });

                if (!response.ok) {
                    const errorData = await response.text();
                    throw new Error(`OpenRouter Error (${model}): ${errorData}`);
                }

                const reader = response.body?.getReader();
                const decoder = new TextDecoder();

                return (async function* () {
                    while (true) {
                        const { done, value } = await reader!.read();
                        if (done) break;

                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n').filter(line => line.trim() !== '');

                        for (const line of lines) {
                            if (line.includes('data: [DONE]')) return;
                            if (line.startsWith('data: ')) {
                                try {
                                    const data = JSON.parse(line.replace('data: ', ''));
                                    const content = data.choices[0]?.delta?.content || '';
                                    if (content) yield content;
                                } catch (e) {
                                    // Ignorar errores de parseo intermedios
                                }
                            }
                        }
                    }
                })();
            } catch (error) {
                console.error(`Fallo en modelo ${model} de OpenRouter:`, error instanceof Error ? error.message : error);
                lastError = error;
                continue; // Probar el siguiente modelo gratuito de la lista
            }
        }

        throw lastError || new Error('Todos los modelos gratuitos de OpenRouter fallaron');
    }
}
