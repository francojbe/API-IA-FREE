import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AIService, ChatMessage } from '../types';

let genAI: GoogleGenerativeAI;

export const geminiService: AIService = {
    name: 'Gemini',
    async chat(messages: ChatMessage[], tools?: any[]) {
        if (!genAI) {
            genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        // Mapear mensajes al formato de Gemini soportando multimodalidad
        const history = messages.slice(0, -1).map(m => {
            const parts: any[] = [];
            
            // Si el contenido ya es un array (multimodal), procesar cada parte
            if (Array.isArray(m.content)) {
                (m.content as any[]).forEach(part => {
                    if (part.type === 'text') parts.push({ text: part.text });
                    if (part.type === 'image_url') {
                        // Extraer base64 y mimeType de data:image/jpeg;base64,xxxx
                        const matches = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
                        if (matches) {
                            parts.push({
                                inlineData: {
                                    mimeType: matches[1],
                                    data: matches[2]
                                }
                            });
                        }
                    }
                });
            } else {
                parts.push({ text: m.content || '' });
            }

            return {
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: parts,
            };
        });

        const lastItem = messages[messages.length - 1];
        if (!lastItem) return (async function* () { yield {} })();

        // Procesar el último mensaje (pude ser texto o multimodal)
        const lastParts: any[] = [];
        if (Array.isArray(lastItem.content)) {
            (lastItem.content as any[]).forEach(part => {
                if (part.type === 'text') lastParts.push({ text: part.text });
                if (part.type === 'image_url') {
                    const matches = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
                    if (matches) {
                        lastParts.push({
                            inlineData: {
                                mimeType: matches[1],
                                data: matches[2]
                            }
                        });
                    }
                }
            });
        } else {
            lastParts.push({ text: lastItem.content || '' });
        }

        const chat = model.startChat({
            history: history as any,
        });

        const result = await chat.sendMessageStream(lastParts);

        return (async function* () {
            for await (const chunk of result.stream) {
                yield { content: chunk.text() };
            }
        })();
    }
}
