// 文件类型判断与 PDF 页码定位工具

export function isPDFFileType(fileType?: string | null): boolean {
  return (fileType || '').trim().toUpperCase() === 'PDF';
}

// fileType 缺失时按 viewUrl 扩展名兜底，保持旧行为（以前一律当 PDF 走 viewer）
export function isPDFFile(fileType?: string | null, viewUrl?: string | null): boolean {
  if (fileType && fileType.trim()) return isPDFFileType(fileType);
  const clean = (viewUrl || '').split('#')[0].split('?')[0].toLowerCase();
  return clean.endsWith('.pdf');
}

// 浏览器内置 PDF viewer 支持 #page=N 片段定位；无页码时原样返回
export function withPdfPage(url: string, pageNumber?: number | null): string {
  if (!pageNumber || pageNumber < 1) return url;
  const base = url.split('#')[0];
  return `${base}#page=${Math.floor(pageNumber)}`;
}
