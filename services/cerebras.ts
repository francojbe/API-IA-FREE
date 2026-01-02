import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { AIService, ChatMessage } from '../types';

let cerebras: Cerebras;

export const cerebrasService: AIService = {
  name: 'Cerebras',
  async chat(messages: ChatMessage[], tools?: any[]) {
    if (!cerebras) {
      cerebras = new Cerebras();
    }

    const options: any = {
      messages: messages as any,
      model: 'llama3.1-70b',
      stream: true,
      max_completion_tokens: 40960,
      temperature: 0.6,
    };

    if (tools && tools.length > 0) {
      options.tools = tools;
    }

    const stream = await cerebras.chat.completions.create(options);

    return (async function* () {
      for await (const chunk of stream) {
        yield (chunk as any).choices[0]?.delta || {}
      }
    })()
  }
}