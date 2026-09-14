/**
 * 后端基础地址（统一出口）
 *
 * 优先级：
 * 1. EXPO_PUBLIC_BACKEND_BASE_URL —— 本地 / 云端预览由启动脚本注入，原生端也走这里
 * 2. 当前页面 origin —— Web 端同源部署（前端静态产物与 API 由同一服务提供）时回退到此，
 *    避免把 localhost:9091 打进生产包
 * 3. localhost:9091 —— 兜底（原生端未注入时的本地开发）
 */
export const BACKEND_BASE_URL: string =
  process.env.EXPO_PUBLIC_BACKEND_BASE_URL ||
  (typeof window !== 'undefined' && window.location ? window.location.origin : '') ||
  'http://localhost:9091';

export default BACKEND_BASE_URL;
