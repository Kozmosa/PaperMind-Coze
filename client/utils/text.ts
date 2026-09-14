/**
 * 列表截断预览的统一文本处理（渲染规范的一部分）：
 * 完整正文/摘要展示用 MarkdownRenderer（components/markdown/MarkdownRenderer），
 * 单行/两行截断预览里不能塞 HTML——用本函数剥掉公式定界符，
 * 让预览既不显示 $ 标记，也不丢公式内容。
 */
export function stripMathDelimiters(text: string): string {
  if (!text) return '';
  return text
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$\n]+?)\$/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
