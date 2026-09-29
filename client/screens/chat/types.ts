export interface Citation {
  type?: string;
  title?: string;
  label?: string;
  fileName?: string;
  file_name?: string;
  snippet?: string;
  papercore?: string;
  tags?: string[];
  page?: number | null;
  pageNumber?: number | null;
  sourceId?: string | number;
  nodeId?: string | number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  timestamp: number;
  imageUri?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  lastMessage?: string;
  lastTime: number;
}

export interface KnowledgeNode {
  id: number;
  short_name: string;
  papercore: string;
}

export interface UploadFile {
  uri: string;
  name: string;
}
