import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AIService, ChatMessage } from '../types';

let genAI: GoogleGenerativeAI;

export const geminiService: AIService = {
    name: 'Gemini',
    async chat(messages: ChatMessage[]) {
        if (!genAI) {
            genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
        }

        const model = genAI.getGenerativeModel({ model: "gemini-3-flash" });

        // Mapear mensajes al formato de Gemini
        const history = messages.slice(0, -1).map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.content }],
        }));

        const lastItem = messages[messages.length - 1];
        if (!lastItem) return (async function* () { yield '' })();
        const lastMessage = lastItem.content;

        const chat = model.startChat({
            history: history as any,
        });

        const result = await chat.sendMessageStream(lastMessage);

        return (async function* () {
            for await (const chunk of result.stream) {
                yield chunk.text();
            }
        })();
    }
}
