/**
 * logical_path 在数据库中可能存为 JSON 数组字符串（历史数据甚至有双嵌套，
 * 如 "[\"/数学/复分析/留数定理/\"]"），统一解析为普通路径字符串。
 */

/** 解析为规范路径，如 "/数学/复分析/留数定理/"；无法解析时返回 '' */
export function normalizeLogicalPath(raw?: string | null): string {
  if (!raw) return '';
  let s: string = raw;
  // 兼容双嵌套：JSON 数组字符串里再套一层 JSON 字符串
  for (let i = 0; i < 2; i++) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        s = String(parsed[0] ?? '');
        continue;
      }
      break;
    } catch {
      break;
    }
  }
  if (typeof s !== 'string') return '';
  return s.replace(/^\[?"?\/?/, '/').replace(/\/?"?\]?$/, '/');
}

/** 取路径最后一段用于紧凑展示，如 "留数定理" */
export function lastPathSegment(raw?: string | null): string {
  const parts = normalizeLogicalPath(raw).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}
