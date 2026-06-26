import express from "express";
import cors from "cors";
import * as path from "path";
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
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
app.use('/test-data', express.static(path.join(process.cwd(), '..', 'test_data', '学习资料')));

// Apply auth middleware to all API routes
app.use('/api/v1', authMiddleware);

// Health check
app.get('/api/v1/health', (_req, res) => {
  console.log('Health check success');
  res.status(200).json({ status: 'ok' });
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

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}/`);
});