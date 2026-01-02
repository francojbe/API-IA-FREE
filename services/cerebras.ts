import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { AIService, ChatMessage } from '../types';

let cerebras: Cerebras;

export const cerebrasService: AIService = {
  name: 'Cerebras',
  async *chat(messages: ChatMessage[], tools?: any[]) {
    if (!cerebras) {
      cerebras = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });
    }

    const options: any = {
      model: "llama3.1-70b",
      messages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      options.tools = tools;
    }

    const stream = await cerebras.chat.completions.create(options);

    for await (const chunk of stream) {
      yield {
        content: chunk.choices[0]?.delta?.content || "",
        tool_calls: chunk.choices[0]?.delta?.tool_calls
      };
    }
  }
};