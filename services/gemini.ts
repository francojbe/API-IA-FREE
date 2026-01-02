import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AIService, ChatMessage } from '../types';

let genAI: GoogleGenerativeAI;

export const geminiService: AIService = {
    name: 'Gemini',
    async chat(messages: ChatMessage[], tools?: any[]) {
        if (!genAI) {
            genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

        // Mapear mensajes al formato de Gemini (simplificado por ahora)
        const history = messages.slice(0, -1).map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content || '' }],
        }));

        const lastItem = messages[messages.length - 1];
        if (!lastItem) return (async function* () { yield {} })();
        const lastMessage = lastItem.content;

        const chat = model.startChat({
            history: history as any,
        });

        const result = await chat.sendMessageStream(lastMessage);

        return (async function* () {
            for await (const chunk of result.stream) {
                yield { content: chunk.text() };
            }
        })();
    }
}
