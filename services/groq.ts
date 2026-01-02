import { Groq } from 'groq-sdk';
import type { AIService, ChatMessage } from '../types';

let groq: Groq;

export const groqService: AIService = {
  name: 'Groq',
  async *chat(messages: ChatMessage[], tools?: any[]) {
    if (!groq) {
      groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    }

    const options: any = {
      messages,
      model: "llama-3.3-70b-versatile",
      temperature: 0.6,
      stream: true,
    };

    if (tools && tools.length > 0) {
      options.tools = tools;
    }

    const stream = await groq.chat.completions.create(options);

    for await (const chunk of stream) {
      yield {
        content: chunk.choices[0]?.delta?.content || "",
        tool_calls: chunk.choices[0]?.delta?.tool_calls
      };
    }
  }
};
