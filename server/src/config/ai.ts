import Anthropic from '@anthropic-ai/sdk';

// Sub2API AI Gateway - 通过 Anthropic 兼容接口调用
// 当前可用的 key 和模型池:
//   Anthropic Key (sk-accc...): kimi-for-coding ✓, glm-5.2 / glm-5.1 / glm-5 / glm-4.7 (限流中)
//   OpenAI Key (sk-dd46...): 模型列表正常但 chat/completions 路由未配置

const AI_BASE_URL = 'http://110.42.53.85:11098';
const AI_API_KEY = 'sk-accc8ec8c8c0650aefe1d0e5498657961c041c13eb9e8f48ba3a579ea5934cb3';

export const anthropic = new Anthropic({
  apiKey: AI_API_KEY,
  baseURL: AI_BASE_URL,
});

/** 当前使用的主模型 */
export const DEFAULT_MODEL = 'kimi-for-coding';

/** 可用模型列表（通过此 API Key 可访问） */
export const AVAILABLE_MODELS = [
  'kimi-for-coding',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'glm-4.7',
] as const;

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];
