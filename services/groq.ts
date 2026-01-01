import { Groq } from 'groq-sdk';
import type { AIService, ChatMessage } from '../types';

let groq: Groq;

export const groqService: AIService = {
  name: 'Groq',
  async chat(messages: ChatMessage[]) {
    if (!groq) {
      groq = new Groq();
    }
    const chatCompletion = await groq.chat.completions.create({
      messages,
      model: "moonshotai/kimi-k2-instruct-0905",
      temperature: 0.6,
      max_completion_tokens: 4096,
      top_p: 1,
      stream: true,
      stop: null
    });

    return (async function* () {
      for await (const chunk of chatCompletion) {
        yield chunk.choices[0]?.delta?.content || ''
      }
    })()
  }
}

