import * as path from 'path';

/**
 * 运行时数据目录。
 *
 * 两者默认落在 server/ 下，与本地开发布局一致；容器化部署时用
 * UPLOAD_DIR / HF_CACHE_DIR 指向挂载的持久化卷，否则实例重启后
 * 上传的资料与嵌入模型缓存都会丢失。
 */
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

export const HF_CACHE_DIR =
  process.env.HF_CACHE_DIR || path.join(process.cwd(), '.cache', 'huggingface');
