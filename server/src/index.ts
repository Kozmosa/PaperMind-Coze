import express from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';
import { UPLOAD_DIR } from './config/paths.js';
import { authMiddleware } from './middleware/auth.js';

import knowledgeNodesRouter from './routes/knowledge-nodes.js';
import draftPoolRouter from './routes/draft-pool.js';
import stickynotesRouter from './routes/stickynotes.js';
import forumsRouter from './routes/forums.js';
import papernoteStyleRouter from './routes/papernote-style.js';
import problemLogsRouter from './routes/problem-logs.js';
import reflectionsRouter from './routes/reflections.js';
import aiRouter from './routes/ai.js';
import uploadRouter from './routes/upload.js';
import fileContentsRouter from './routes/file-contents.js';
import studyNotesRouter from './routes/study-notes.js';
import materialsRouter from './routes/materials.js';
import problemSolvingLogsRouter from './routes/problem-solving-logs.js';
import knowledgeBuilderRouter from './routes/knowledge-builder.js';
import controlCenterRouter from './routes/control-center.js';
import chatSessionsRouter from './routes/chat-sessions.js';

const app = express();
const port = process.env.PORT || 9091;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/test-data', express.static(path.join(process.cwd(), '..', 'test_data', '学习资料')));
app.use('/debug', express.static(path.join(process.cwd(), '..', 'debug')));
// /projects 会暴露整个仓库（含 .env），仅本地开发按需开启
if (process.env.SERVE_PROJECT_FILES === 'true') {
  app.use('/projects', express.static(path.join(process.cwd(), '..')));
}

// Apply auth middleware to all API routes
app.use('/api/v1', authMiddleware);

// Health check
app.get('/api/v1/health', (_req, res) => {
  console.log('Health check success');
  res.status(200).json({ status: 'ok' });
});

// 前端运行期配置。anon key 本就是设计上要下发到浏览器的公开值（鉴权由 Auth + RLS 保证），
// 由后端下发可让前端静态产物与构建环境解耦：换部署域名或 Supabase 项目都无需重新构建。
app.get('/api/v1/config', (_req, res) => {
  res.status(200).json({
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL || process.env.COZE_SUPABASE_URL || '',
    supabaseAnonKey:
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || process.env.COZE_SUPABASE_ANON_KEY || '',
  });
});

// Routes
app.use('/api/v1/knowledge-nodes', knowledgeNodesRouter);
app.use('/api/v1/draft-pool', draftPoolRouter);
app.use('/api/v1/stickynotes', stickynotesRouter);
app.use('/api/v1/forums', forumsRouter);
app.use('/api/v1/papernote-style', papernoteStyleRouter);
app.use('/api/v1/problem-logs', problemLogsRouter);
app.use('/api/v1/reflections', reflectionsRouter);
app.use('/api/v1/ai', aiRouter);
app.use('/api/v1/upload', uploadRouter);
app.use('/api/v1/file-contents', fileContentsRouter);
app.use('/api/v1/study-notes', studyNotesRouter);
app.use('/api/v1/materials', materialsRouter);
app.use('/api/v1/problem-solving-logs', problemSolvingLogsRouter);
app.use('/api/v1/knowledge-builder', knowledgeBuilderRouter);
app.use('/api/v1/control-center', controlCenterRouter);
app.use('/api/v1/chat-sessions', chatSessionsRouter);

// 前端静态产物（Expo Web export 的输出目录）。
// 与 API 同进程托管，部署后只有一个域名；本地只跑后端时该目录不存在，自动跳过。
const clientDistDir =
  process.env.CLIENT_DIST_DIR || path.join(process.cwd(), '..', 'client', 'dist');
if (fs.existsSync(path.join(clientDistDir, 'index.html'))) {
  app.use(express.static(clientDistDir));
  // SPA 回退：非 API / 上传资源的未知路径交给前端路由处理
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
    res.sendFile(path.join(clientDistDir, 'index.html'));
  });
  console.log(`[static] serving client from ${clientDistDir}`);
}

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}/`);
});

// Warm-start knowledge vector index in background (lazy dynamic import to avoid blocking startup)
setTimeout(() => {
  // Warm-start unified vector index + tag vector store
  import('./utils/unified-vector-index.js')
    .then(async (indexMod) => {
      // 先构建标签库（统一索引的标签加成依赖它），再构建统一索引
      try {
        await import('./utils/vector-store.js').then((tagMod) =>
          tagMod.tagVectorStore.buildFromDatabase(),
        );
      } catch (err: any) {
        console.warn('[Index] TagVectorStore build failed:', err?.message);
      }

      await indexMod.unifiedVectorIndex.buildIndex().catch((err) => {
        console.warn('[Index] UnifiedVectorIndex build failed:', err.message);
      });
    })
    .catch(() => {
      // embedding deps not available — safe to skip warm-start
    });
}, 2000);
