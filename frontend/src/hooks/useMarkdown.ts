import { useEffect, useState } from 'react';
import { getFallbackHtml, renderMarkdown } from '../lib/markdown';

/**
 * Hook for rendering markdown content / 渲染 Markdown 内容的 Hook
 * @param content - markdown content to render / 要渲染的 Markdown 内容
 * @returns rendered HTML string / 渲染后的 HTML 字符串
 */
export function useMarkdown(content: string): string {
  const [html, setHtml] = useState(() => getFallbackHtml(content));

  useEffect(() => {
    let isCancelled = false;
    const fallbackHtml = getFallbackHtml(content);

    if (!content) {
      setHtml('');
    } else {
      setHtml(previousHtml => previousHtml || fallbackHtml);

      void renderMarkdown(content)
        .then(renderedHtml => {
          if (!isCancelled) {
            setHtml(renderedHtml || fallbackHtml);
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setHtml(fallbackHtml);
          }
        });
    }

    return () => {
      isCancelled = true;
    };
  }, [content]);

  return html;
}
