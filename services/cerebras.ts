import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { AIService, ChatMessage } from '../types';

let cerebras: Cerebras;

export const cerebrasService: AIService = {
  name: 'Cerebras',
  async chat(messages: ChatMessage[]) {
    if (!cerebras) {
      cerebras = new Cerebras();
    }
    const stream = await cerebras.chat.completions.create({
      messages: messages as any,
      model: 'zai-glm-4.6',
      stream: true,
      max_completion_tokens: 40960,
      temperature: 0.6,
      top_p: 0.95
    });

    return (async function* () {
      for await (const chunk of stream) {
        yield (chunk as any).choices[0]?.delta?.content || ''
      }
    })()
  }
}