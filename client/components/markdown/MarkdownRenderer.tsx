import { useMemo, useRef, useEffect, useState } from 'react';
import { View, Platform, StyleSheet } from 'react-native';

interface MarkdownRendererProps {
  content: string;
  maxWidth?: number;
}

// Obsidian 风格扩展样式（web 路径注入用，与 native 模板 <style> 保持同步）
const OBSIDIAN_CSS = `
mark{background:#FFF3B8;border-radius:3px;padding:0 2px;color:inherit}
del{color:#9CA3AF}
.wiki-link{color:#8B5CF6;text-decoration:none;border-bottom:1px dashed #C4B5FD;cursor:pointer}
.callout{border-radius:8px;padding:10px 12px;margin-bottom:6px;background:#F3F4F6;border-left:4px solid #9CA3AF}
.callout-title{font-weight:600;margin-bottom:4px;font-size:13px;color:#374151}
.callout-note{background:#EFF6FF;border-left-color:#3B82F6}
.callout-note .callout-title{color:#1D4ED8}
.callout-tip,.callout-success{background:#ECFDF5;border-left-color:#10B981}
.callout-tip .callout-title,.callout-success .callout-title{color:#047857}
.callout-info{background:#F0F9FF;border-left-color:#0EA5E9}
.callout-info .callout-title{color:#0369A1}
.callout-warning{background:#FFFBEB;border-left-color:#F59E0B}
.callout-warning .callout-title{color:#B45309}
.callout-danger,.callout-error{background:#FEF2F2;border-left-color:#EF4444}
.callout-danger .callout-title,.callout-error .callout-title{color:#B91C1C}
`;

// KaTeX with throwOnError:false never throws — it renders failing formulas as red
// .katex-error source markup. Sanitize common LLM output issues first, then detect
// katex-error and degrade to neutral plain-text source instead of red error HTML.
function sanitizeLatex(formula: string): string {
  return (
    formula
      .trim()
      // markdown artifacts (blockquote/heading markers) leaking into math blocks
      .replace(/^[ \t]*[>#]+[ \t]*/gm, '')
      // KaTeX math mode can't handle CJK directly; wrap CJK runs in \text{}。
      // 只包 CJK：希腊字母/数学符号（μ Σ π ≈ ≤ ²）KaTeX 原生支持，
      // 全量非 ASCII 包 \text{} 反而因 Main-Regular 缺字形度量而失败（x̄ 组合符案例）
      .replace(/([⺀-鿿豈-﫿＀-￯]+)/g, '\\text{$1}')
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mathFallback(source: string, display: boolean): string {
  const esc = escapeHtml(source.trim());
  return display
    ? `<pre class="math-fallback" style="background:#F3F4F6;border-radius:8px;padding:10px 12px;margin:6px 0;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:13px;line-height:1.5;color:#374151">${esc}</pre>`
    : `<code class="math-fallback-inline" style="background:#F3F4F6;border-radius:4px;padding:1px 5px;font-family:monospace;font-size:0.95em;color:#374151">${esc}</code>`;
}

// Obsidian 风格语法预处理（==高亮==、[[双链]]、> [!callout]）——
// 必须在 markdown 解析前运行；代码/公式已由占位符保护，不会误伤内部内容。
// ~~删除线~~ 与 - [ ] 任务列表由 marked GFM 原生支持。
function obsidianPreprocess(text: string): string {
  let t = text;
  // ==高亮==（Obsidian highlight）
  t = t.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  // [[双链]] 渲染为内部链接样式
  t = t.replace(/\[\[([^\[\]\n]+)\]\]/g, '<a class="wiki-link">$1</a>');
  // > [!note] 标注块：标题行 + 后续 "> " 行收编为 callout 容器
  t = t.replace(/^> \[!(\w+)\]([^\n]*)\n((?:> [^\n]*\n?)*)/gm, (_m, type: string, title: string, body: string) => {
    const bodyHtml = body
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => `<div>${l.replace(/^>\s?/, '')}</div>`)
      .join('');
    return `<div class="callout callout-${type.toLowerCase()}"><div class="callout-title">${(title || type).trim()}</div>${bodyHtml}</div>\n\n`;
  });
  return t;
}

function renderMath(katex: any, raw: string, display: boolean): string {
  const formula = sanitizeLatex(raw);
  if (!formula) return escapeHtml(raw);
  let html = '';
  try {
    html = katex.renderToString(formula, { displayMode: display, throwOnError: false });
  } catch {
    html = '';
  }
  if (!html || html.indexOf('katex-error') !== -1) {
    return mathFallback(raw, display);
  }
  return html;
}

// Heading collapse/expand JS (injected into native WebView)
const COLLAPSE_SCRIPT = `
(function(){
  var content = document.getElementById('content');
  if (!content) return;
  var headings = content.querySelectorAll('h1, h2, h3, h4');
  for (var hi = 0; hi < headings.length; hi++) {
    (function(){
      var heading = headings[hi];
      var level = parseInt(heading.tagName.substring(1));
      var el = heading.nextElementSibling;
      var collapsibles = [];
      while (el) {
        var tag = el.tagName;
        if (tag && /^H[1-4]$/.test(tag)) {
          var nextLevel = parseInt(tag.substring(1));
          if (nextLevel <= level) break;
        }
        collapsibles.push(el);
        el = el.nextElementSibling;
      }
      if (collapsibles.length > 0) {
        var wrapper = document.createElement('div');
        wrapper.className = 'collapse-section';
        wrapper.style.display = 'block';
        for (var ci = 0; ci < collapsibles.length; ci++) {
          wrapper.appendChild(collapsibles[ci]);
        }
        heading.parentNode.insertBefore(wrapper, heading.nextSibling);
        heading.style.cursor = 'pointer';
        heading.style.userSelect = 'none';
        heading.classList.add('collapse-heading');
        var collapsed = false;
        var icon = document.createElement('span');
        icon.innerHTML = ' &#9660;';
        icon.style.cssText = 'font-size:0.65em;color:#6C63FF;margin-left:6px;vertical-align:middle';
        heading.appendChild(icon);
        heading.addEventListener('click', function(){
          collapsed = !collapsed;
          wrapper.style.display = collapsed ? 'none' : 'block';
          icon.innerHTML = collapsed ? ' &#9654;' : ' &#9660;';
        });
      }
    })();
  }
})();
`;

/* ======================== Native Version (iOS/Android) ======================== */
function NativeMarkdown({ html }: { html: string }) {
  const WebView = require('react-native-webview').WebView;

  return (
    <View style={{ maxWidth: '100%' }}>
      <WebView
        source={{ html }}
        style={styles.webview}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        originWhitelist={[]}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        textInteractionEnabled={true}
        androidLayerType="software"
      />
    </View>
  );
}

/* ======================== Web Version ======================== */
function WebMarkdown({ content }: { content: string }) {
  const containerRef = useRef<View>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    // Load KaTeX CSS
    const linkHref = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
    if (!document.querySelector(`link[href="${linkHref}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = linkHref;
      document.head.appendChild(link);
    }

    // Obsidian 风格扩展样式（web 路径无模板 <style>，注入一次）
    if (!document.getElementById('obsidian-md-css')) {
      const style = document.createElement('style');
      style.id = 'obsidian-md-css';
      style.textContent = OBSIDIAN_CSS;
      document.head.appendChild(style);
    }

    // Load KaTeX and marked scripts
    const loadScript = (src: string): Promise<void> =>
      new Promise((resolve) => {
        if ((window as any).__scriptsLoaded?.[src]) {
          resolve();
          return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => {
          if (!(window as any).__scriptsLoaded) (window as any).__scriptsLoaded = {};
          (window as any).__scriptsLoaded[src] = true;
          resolve();
        };
        script.onerror = () => resolve(); // continue even if fails
        document.head.appendChild(script);
      });

    Promise.all([
      loadScript('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js'),
      loadScript('https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js'),
    ]).then(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!ready || !containerRef.current) return;

    const el = containerRef.current as unknown as HTMLElement;
    const katex = (window as any).katex;
    const marked = (window as any).marked;

    if (!katex || !marked) {
      el.innerHTML = `<p>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
      return;
    }

    try {
      let result = content;
      const codePlaceholders: { ph: string; md: string }[] = [];
      const mathPlaceholders: { ph: string; html: string }[] = [];
      let counter = 0;
      const pushCode = (md: string) => {
        const ph = `%%CODE_PH_${counter++}%%`;
        codePlaceholders.push({ ph, md });
        return ph;
      };
      const pushMath = (html: string) => {
        const ph = `%%MATH_PH_${counter++}%%`;
        mathPlaceholders.push({ ph, html });
        return ph;
      };

      // Protect code so $ / \[ inside it is not mistaken for math delimiters
      result = result.replace(/```[\s\S]*?(?:```|$)/g, (m: string) => pushCode(m));
      result = result.replace(/`[^`\n]+`/g, (m: string) => pushCode(m));

      // Block math: $$...$$ and \[...\]
      result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_: string, f: string) =>
        pushMath(renderMath(katex, f, true)),
      );
      result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_: string, f: string) =>
        pushMath(renderMath(katex, f, true)),
      );

      // Inline math: $...$ (no surrounding spaces, not currency) and \(...\)
      result = result.replace(/\$(?!\d)([^$\n]*\S)\$/g, (match: string, f: string) =>
        /^\s/.test(f) ? match : pushMath(renderMath(katex, f, false)),
      );
      result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_: string, f: string) =>
        pushMath(renderMath(katex, f, false)),
      );

      // Restore code before markdown parsing so it still renders as code
      for (const p of codePlaceholders) {
        result = result.split(p.ph).join(p.md);
      }

      // Obsidian 语法预处理（高亮/双链/callout）
      result = obsidianPreprocess(result);

      // Markdown
      let html = marked.parse(result, { breaks: true, gfm: true });

      // Restore math placeholders
      for (const p of mathPlaceholders) {
        html = html.split(p.ph).join(p.html);
      }

      // Block-level math must not stay wrapped in <p>
      html = html.replace(/<p>(<span class="katex-display">[\s\S]*?<\/span>)<\/p>/g, '$1');
      html = html.replace(/<p>(<pre class="math-fallback"[^>]*>[\s\S]*?<\/pre>)<\/p>/g, '$1');

      el.innerHTML = html;

      // Heading collapse/expand
      applyHeadingCollapse(el);
    } catch {
      el.innerHTML = `<p>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    }
  }, [content, ready]);

  return <View ref={containerRef} style={styles.webContainer} />;
}

// Shared function for heading collapse (used by web version)
function applyHeadingCollapse(root: HTMLElement) {
  const headings = root.querySelectorAll('h1, h2, h3, h4');
  for (let hi = 0; hi < headings.length; hi++) {
    const heading = headings[hi] as HTMLElement;
    const level = parseInt(heading.tagName.substring(1));
    // Collect siblings until next heading of same/higher level
    let el = heading.nextElementSibling as HTMLElement | null;
    const collapsibles: HTMLElement[] = [];
    while (el) {
      const tag = el.tagName;
      if (tag && /^H[1-4]$/.test(tag)) {
        const nextLevel = parseInt(tag.substring(1));
        if (nextLevel <= level) break;
      }
      collapsibles.push(el);
      el = el.nextElementSibling as HTMLElement | null;
    }
    if (collapsibles.length > 0) {
      const wrapper = document.createElement('div');
      wrapper.className = 'collapse-section';
      wrapper.style.display = 'block';
      for (const c of collapsibles) wrapper.appendChild(c);
      heading.parentNode!.insertBefore(wrapper, heading.nextSibling);
      heading.style.cursor = 'pointer';
      heading.style.userSelect = 'none';
      heading.classList.add('collapse-heading');
      let collapsed = false;
      const icon = document.createElement('span');
      icon.innerHTML = ' &#9660;';
      icon.style.cssText = 'font-size:0.65em;color:#6C63FF;margin-left:6px;vertical-align:middle';
      heading.appendChild(icon);
      heading.addEventListener('click', () => {
        collapsed = !collapsed;
        wrapper.style.display = collapsed ? 'none' : 'block';
        icon.innerHTML = collapsed ? ' &#9654;' : ' &#9660;';
      });
    }
  }
}

/* ======================== Main Export ======================== */
export default function MarkdownRenderer({ content, maxWidth }: MarkdownRendererProps) {
  // Build the full HTML for Native version
  const html = useMemo(() => {
    const escaped = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
      font-size:14px;line-height:1.75;color:#374151;overflow-x:hidden;word-wrap:break-word;
      padding:0;
    }
    p{margin-bottom:6px}p:last-child{margin-bottom:0}
    h1,h2,h3,h4{margin-top:10px;margin-bottom:4px;font-weight:600;color:#1F2937}
    h1{font-size:17px}h2{font-size:16px}h3{font-size:15px}h4{font-size:14px}
    ul,ol{padding-left:18px;margin-bottom:6px}li{margin-bottom:2px}
    code{
      background:#F3F4F6;border-radius:4px;padding:2px 5px;
      font-family:'SF Mono','Menlo','Monaco','Courier New',monospace;
      font-size:13px;color:#E11D48;
    }
    pre{background:#1F2937;border-radius:8px;padding:12px 14px;margin-bottom:6px;overflow-x:auto}
    pre code{background:transparent;color:#E5E7EB;padding:0;font-size:13px;line-height:1.5}
    blockquote{border-left:3px solid #D97757;padding-left:10px;margin-bottom:6px;color:#6B7280}
    a{color:#D97757;text-decoration:none}
    table{border-collapse:collapse;margin-bottom:6px;width:100%}
    th,td{border:1px solid #E5E7EB;padding:5px 8px;text-align:left}
    th{background:#F9FAFB;font-weight:600}
    hr{border:none;border-top:1px solid #E5E7EB;margin:10px 0}
    img{max-width:100%;border-radius:8px}
    .katex-display{margin:6px 0;overflow-x:auto;overflow-y:hidden;text-align:center}
    .katex{font-size:1.05em}
    .collapse-heading:hover{color:#6C63FF}
    /* Obsidian 风格扩展 */
    mark{background:#FFF3B8;border-radius:3px;padding:0 2px;color:inherit}
    del{color:#9CA3AF}
    .wiki-link{color:#8B5CF6;text-decoration:none;border-bottom:1px dashed #C4B5FD;cursor:pointer}
    .callout{border-radius:8px;padding:10px 12px;margin-bottom:6px;background:#F3F4F6;border-left:4px solid #9CA3AF}
    .callout-title{font-weight:600;margin-bottom:4px;font-size:13px;color:#374151}
    .callout-note{background:#EFF6FF;border-left-color:#3B82F6}
    .callout-note .callout-title{color:#1D4ED8}
    .callout-tip,.callout-success{background:#ECFDF5;border-left-color:#10B981}
    .callout-tip .callout-title,.callout-success .callout-title{color:#047857}
    .callout-info{background:#F0F9FF;border-left-color:#0EA5E9}
    .callout-info .callout-title{color:#0369A1}
    .callout-warning{background:#FFFBEB;border-left-color:#F59E0B}
    .callout-warning .callout-title{color:#B45309}
    .callout-danger,.callout-error{background:#FEF2F2;border-left-color:#EF4444}
    .callout-danger .callout-title,.callout-error .callout-title{color:#B91C1C}
  </style>
</head>
<body>
<div id="content"></div>
<script>
(function(){
  const md = ${JSON.stringify(escaped)};
  var codePlaceholders = [];
  var mathPlaceholders = [];
  var counter = 0;
  function pushCode(m){ var ph = '%%CODE_PH_' + (counter++) + '%%'; codePlaceholders.push({ph:ph, md:m}); return ph; }
  function pushMath(h){ var ph = '%%MATH_PH_' + (counter++) + '%%'; mathPlaceholders.push({ph:ph, html:h}); return ph; }
  function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sanitizeLatex(f){
    return f.trim()
      .replace(/^[ \\t]*[>#]+[ \\t]*/gm, '')
      .replace(/([\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF]+)/g, '\\\\text{$1}');
  }
  function mathFallback(src, display){
    var esc = escapeHtml(unescapeEntities(src.trim()));
    return display
      ? '<pre class="math-fallback" style="background:#F3F4F6;border-radius:8px;padding:10px 12px;margin:6px 0;overflow-x:auto;white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:13px;line-height:1.5;color:#374151">' + esc + '</pre>'
      : '<code class="math-fallback-inline" style="background:#F3F4F6;border-radius:4px;padding:1px 5px;font-family:monospace;font-size:0.95em;color:#374151">' + esc + '</code>';
  }
  function unescapeEntities(s){ return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'"); }
  function renderMath(raw, display){
    var formula = sanitizeLatex(unescapeEntities(raw));
    if (!formula) return escapeHtml(raw);
    var html = '';
    try {
      html = katex.renderToString(formula, {displayMode:display, throwOnError:false});
    } catch(e) { html = ''; }
    if (!html || html.indexOf('katex-error') !== -1) return mathFallback(raw, display);
    return html;
  }
  function obsidianPreprocess(text){
    var t = text;
    // ==高亮==（Obsidian highlight）
    t = t.replace(/==([^=\\n]+)==/g, '<mark>$1</mark>');
    // [[双链]] 渲染为内部链接样式
    t = t.replace(/\\[\\[([^\\[\\]\\n]+)\\]\\]/g, '<a class="wiki-link">$1</a>');
    // > [!note] 标注块：标题行 + 后续 "> " 行收编为 callout 容器
    t = t.replace(/^> \\[!(\\w+)\\]([^\\n]*)\\n((?:> [^\\n]*\\n?)*)/gm, function(_, type, title, body){
      var lines = body.split('\\n').filter(function(l){return l.trim();}).map(function(l){return '<div>' + l.replace(/^>\\s?/, '') + '</div>';});
      return '<div class="callout callout-' + type.toLowerCase() + '"><div class="callout-title">' + (title.trim() || type) + '</div>' + lines.join('') + '</div>\\n\\n';
    });
    return t;
  }

  // Protect code so $ / \\[ inside it is not mistaken for math delimiters
  var result = md;
  result = result.replace(/\`\`\`[\\s\\S]*?(?:\`\`\`|$)/g, function(m){ return pushCode(m); });
  result = result.replace(/\`[^\`\\n]+\`/g, function(m){ return pushCode(m); });

  // Block math: $$...$$ and \\[...\\]
  result = result.replace(/\\$\\$([\\s\\S]*?)\\$\\$/g, function(_, f){ return pushMath(renderMath(f, true)); });
  result = result.replace(/\\\\\\[([\\s\\S]*?)\\\\\\]/g, function(_, f){ return pushMath(renderMath(f, true)); });

  // Inline math: $...$ (no surrounding spaces, not currency) and \\(...\\)
  result = result.replace(/\\$(?!\\d)([^$\\n]*\\S)\\$/g, function(match, f){ return /^\\s/.test(f) ? match : pushMath(renderMath(f, false)); });
  result = result.replace(/\\\\\\(([\\s\\S]*?)\\\\\\)/g, function(_, f){ return pushMath(renderMath(f, false)); });

  // Restore code before markdown parsing so it still renders as code
  for (var ci = 0; ci < codePlaceholders.length; ci++) {
    result = result.split(codePlaceholders[ci].ph).join(codePlaceholders[ci].md);
  }

  // Obsidian 语法预处理（高亮/双链/callout）
  result = obsidianPreprocess(result);

  result = marked.parse(result, {breaks:true,gfm:true});

  for (var mi = 0; mi < mathPlaceholders.length; mi++) {
    result = result.split(mathPlaceholders[mi].ph).join(mathPlaceholders[mi].html);
  }

  // Block-level math must not stay wrapped in <p>
  result = result.replace(/<p>(<span class="katex-display">[\\s\\S]*?<\\/span>)<\\/p>/g, '$1');
  result = result.replace(/<p>(<pre class="math-fallback"[^>]*>[\\s\\S]*?<\\/pre>)<\\/p>/g, '$1');

  document.getElementById('content').innerHTML = result;

  // Heading collapse/expand
  ${COLLAPSE_SCRIPT}
})();
</script>
</body>
</html>`;
  }, [content]);

  if (Platform.OS === 'web') {
    return (
      <View style={{ maxWidth: maxWidth || '100%' }}>
        <WebMarkdown content={content} />
      </View>
    );
  }

  return (
    <View style={{ maxWidth: maxWidth || '100%' }}>
      <NativeMarkdown html={html} />
    </View>
  );
}

const styles = StyleSheet.create({
  webview: {
    backgroundColor: 'transparent',
    opacity: 0.99,
    minHeight: 20,
  },
  webContainer: {
    width: '100%',
  },
});
