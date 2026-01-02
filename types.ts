export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface AIService {
  name: string;
  chat: (messages: ChatMessage[], tools?: any[]) => Promise<AsyncIterable<any>>;
}