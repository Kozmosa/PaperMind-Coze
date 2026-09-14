import * as path from 'path';

/**
 * 运行时数据目录。
 *
 * 默认落在 server/ 下，与本地开发布局一致；容器化部署时用 UPLOAD_DIR
 * 指向挂载的持久化卷，否则实例重启后上传的资料会丢失。
 * （嵌入已改走 API，不再有本地模型缓存目录）
 */
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
