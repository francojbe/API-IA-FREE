import { Groq } from 'groq-sdk';
import type { AIService, ChatMessage } from '../types';

let groq: Groq;

export const groqService: AIService = {
  name: 'Groq',
  async chat(messages: ChatMessage[], tools?: any[]) {
    if (!groq) {
      groq = new Groq();
    }

    // Solo enviamos tools si vienen definidas (Groq falla si es null)
    const options: any = {
      messages,
      model: "llama-3.3-70b-versatile", // Modelo con buen soporte de tools
      temperature: 0.6,
      stream: true,
    };

    if (tools && tools.length > 0) {
      options.tools = tools;
    }

    const chatCompletion = await groq.chat.completions.create(options);

    return (async function* () {
      for await (const chunk of chatCompletion) {
        yield chunk.choices[0]?.delta || {}
      }
    })()
  }
}

