import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'node:module';

// AI 网关通过 Anthropic 兼容接口调用，配置从环境变量（.env）读取：
//   ANTHROPIC_API_KEY    必填，网关 API key
//   ANTHROPIC_BASE_URL   网关地址，不设置时直连 Anthropic 官方 API
//   ANTHROPIC_MODEL      可选，覆盖默认模型
// key 缺失时服务仍可启动，仅在调用 AI 接口时抛错。

const _require = createRequire(import.meta.url);

try {
  const path = _require('path') as typeof import('path');
  const fs = _require('fs') as typeof import('fs');
  let envPath = path.resolve('.env');
  if (!fs.existsSync(envPath)) {
    envPath = path.resolve('..', '.env');
  }
  _require('dotenv').config({ path: envPath });
} catch {
  // dotenv 不可用时忽略，依赖外部注入的环境变量
}

const AI_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const AI_API_KEY = process.env.ANTHROPIC_API_KEY;

export const anthropic: Anthropic = AI_API_KEY
  ? new Anthropic({
      apiKey: AI_API_KEY,
      ...(AI_BASE_URL ? { baseURL: AI_BASE_URL } : {}),
    })
  : new Proxy({} as Anthropic, {
      get() {
        throw new Error(
          'ANTHROPIC_API_KEY is not set — 请在 .env 中配置后再调用 AI 接口'
        );
      },
    });

/** 当前使用的主模型 */
export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'kimi-for-coding';

/** 可用模型列表（智谱 BigModel 网关 /v1/models 返回） */
export const AVAILABLE_MODELS = [
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5-turbo',
  'glm-5',
  'glm-4.7',
  'glm-4.6',
  'glm-4.5-air',
  'glm-4.5',
] as const;

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];
