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
      // 分类链路单次 LLM 调用可能达数十秒：放宽单次请求超时，并把 SDK 默认的
      // 2 次自动重试降为 1 次，避免网关抖动时整链指数级变慢（issue #7 Task 3）
      timeout: 120_000,
      maxRetries: 1,
    })
  : new Proxy({} as Anthropic, {
      get() {
        throw new Error('ANTHROPIC_API_KEY is not set — 请在 .env 中配置后再调用 AI 接口');
      },
    });

/** 当前使用的主模型 */
export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'kimi-for-coding';

/** 笔记生成专用快速模型（非思考型）：首字节从思考型的 ~30s 降到 ~2s。
 *  思考型留给 tutor/反思等需要深度推理的场景；NOTE_MODEL 可经 .env 覆盖 */
export const NOTE_MODEL = process.env.NOTE_MODEL || 'deepseek-chat';

/** 可用模型列表：跟随 ANTHROPIC_MODEL 配置的网关模型（如 deepseek-v4-pro） */
export const AVAILABLE_MODELS = [DEFAULT_MODEL];

export type AvailableModel = (typeof AVAILABLE_MODELS)[number];

// ==========================================
// 视觉预处理配置（扫描件 OCR 兜底，issue 跟进）
// DeepSeek 的 Anthropic 兼容端点不转发图片块，视觉必须走
// OpenAI 兼容端点 /v1/chat/completions（实测 deepseek-v4-flash-vision-exp 可用）
// ==========================================
const VISION_API_KEY = process.env.VISION_API_KEY || process.env.ANTHROPIC_API_KEY;
const VISION_BASE_URL = process.env.VISION_BASE_URL || 'https://api.deepseek.com';
const VISION_MODEL = process.env.VISION_MODEL || 'deepseek-v4-flash-vision-exp';

export const VISION_CONFIG = {
  apiKey: VISION_API_KEY,
  baseUrl: VISION_BASE_URL,
  model: VISION_MODEL,
};
export const VISION_MODEL_NAME = VISION_MODEL;
