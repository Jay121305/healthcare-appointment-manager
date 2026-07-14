// backend/src/services/llm/nimClient.ts
// NVIDIA NIM OpenAI-compatible client wrapper

import OpenAI from 'openai';

export interface NimClientConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
}

let cachedClient: OpenAI | null = null;

export function getNimClient(config: NimClientConfig): OpenAI {
  if (cachedClient) {
    return cachedClient;
  }

  cachedClient = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs,
    defaultHeaders: {
      'Authorization': `Bearer ${config.apiKey}`,
    },
  });

  return cachedClient;
}

export function resetNimClient(): void {
  cachedClient = null;
}