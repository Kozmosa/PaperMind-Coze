import { useMemo, useRef, useEffect, useState } from 'react';
import { View, Platform, StyleSheet } from 'react-native';

interface MarkdownRendererProps {
  content: string;
  maxWidth?: number;
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
      const placeholders: { ph: string; html: string }[] = [];
      let counter = 0;

      // Block math $$...$$
      result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_: string, formula: string) => {
        try {
          const html = katex.renderToString(formula.trim(), { displayMode: true, throwOnError: false });
          const ph = `%%MATH_BLOCK_${counter++}%%`;
          placeholders.push({ ph, html });
          return ph;
        } catch {
          return formula.trim();
        }
      });

      // Inline math $...$
      result = result.replace(/\$(?!\d)([^$\n]+)\$/g, (_: string, formula: string) => {
        if (formula.trim().length === 0) return `$${formula}$`;
        try {
          const html = katex.renderToString(formula.trim(), { displayMode: false, throwOnError: false });
          const ph = `%%MATH_INLINE_${counter++}%%`;
          placeholders.push({ ph, html });
          return ph;
        } catch {
          return `$${formula}$`;
        }
      });

      // Markdown
      let html = marked.parse(result, { breaks: true, gfm: true });

      // Restore math placeholders
      for (const p of placeholders) {
        html = html.split(p.ph).join(p.html);
      }

      // Fix KaTeX display inside <p> tags
      html = html.replace(/<p>(<span class="katex-display">[\s\S]*?<\/span>)<\/p>/g, '$1');

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
  </style>
</head>
<body>
<div id="content"></div>
<script>
(function(){
  const md = ${JSON.stringify(escaped)};
  let placeholders = [];
  let counter = 0;

  let result = md.replace(/\\$\\$([\\s\\S]*?)\\$\\$/g, function(_, formula) {
    try {
      var html = katex.renderToString(formula.trim(), {displayMode:true,throwOnError:false});
      var ph = '%%MATH_BLOCK_' + (counter++) + '%%';
      placeholders.push({ph: ph, html: html});
      return ph;
    } catch(e) {
      return formula.trim();
    }
  });

  result = result.replace(/\\$(?!\\d)([^\\$\\n]+?)\\$/g, function(_, formula) {
    if (formula.trim().length === 0) return '$' + formula + '$';
    try {
      var html = katex.renderToString(formula.trim(), {displayMode:false,throwOnError:false});
      var ph = '%%MATH_INLINE_' + (counter++) + '%%';
      placeholders.push({ph: ph, html: html});
      return ph;
    } catch(e) {
      return '$' + formula + '$';
    }
  });

  result = marked.parse(result, {breaks:true,gfm:true});

  for (var i = 0; i < placeholders.length; i++) {
    result = result.split(placeholders[i].ph).join(placeholders[i].html);
  }

  result = result.replace(/<p>(<span class="katex-display">[\\s\\S]*?<\\/span>)<\\/p>/g, '$1');

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
