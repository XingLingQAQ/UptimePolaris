const MAX_MARKDOWN_CACHE_SIZE = 500;

const MAX_CACHEABLE_CONTENT_LENGTH = 20 * 1024;

const markdownRenderCache = new Map<string, Promise<string>>();

const escapeHtml = (input: string): string => {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

export const getFallbackHtml = (content: string): string => {
  if (!content) return '';

  const plainText = extractPlainText(content, 1200);
  if (!plainText) return '';

  return `<p>${escapeHtml(plainText)}</p>`;
};

const setMarkdownCache = (content: string, promise: Promise<string>) => {
  markdownRenderCache.set(content, promise);

  if (markdownRenderCache.size > MAX_MARKDOWN_CACHE_SIZE) {
    const oldestKey = markdownRenderCache.keys().next().value;
    if (typeof oldestKey === 'string') {
      markdownRenderCache.delete(oldestKey);
    }
  }
};

/**
 * Utility function to render markdown content / 渲染 Markdown 内容的工具函数
 * @param content - markdown content to render / 要渲染的 Markdown 内容
 * @returns rendered HTML string / 渲染后的 HTML 字符串
 */
export async function renderMarkdown(content: string): Promise<string> {
  if (!content) return '';

  const { processMarkdown } = await import('./markdown-processor');

  if (content.length > MAX_CACHEABLE_CONTENT_LENGTH) {
    try {
      return await processMarkdown(content);
    } catch {
      return '';
    }
  }

  if (!markdownRenderCache.has(content)) {
    const renderPromise = processMarkdown(content).catch(() => {
      markdownRenderCache.delete(content);
      return '';
    });

    setMarkdownCache(content, renderPromise);
  }

  return markdownRenderCache.get(content) as Promise<string>;
}

/**
 * Extract plain text from markdown content (for previews) / 从 Markdown 提取纯文本用于预览
 * @param markdown - markdown content / Markdown 内容
 * @param maxLength - maximum length of extracted text / 提取文本的最大长度
 * @returns plain text extracted from markdown / 从 Markdown 提取的纯文本
 */
export function extractPlainText(markdown: string, maxLength = 100): string {
  if (!markdown) return '';

  // Remove markdown syntax / 移除 Markdown 语法
  const noLinks = markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const noImages = noLinks.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
  const noCode = noImages.replace(/```[\s\S]*?```/g, '');
  const noInlineCode = noCode.replace(/`[^`]+`/g, '');
  const noHeaders = noInlineCode.replace(/^#{1,6}\s+/gm, '');
  const noBold = noHeaders.replace(/\*\*([^*]+)\*\*/g, '$1');
  const noItalic = noBold.replace(/\*([^*]+)\*/g, '$1');
  const noStrike = noItalic.replace(/~~([^~]+)~~/g, '$1');

  // Clean up whitespace / 清理空白字符
  const cleaned = noStrike.replace(/\s+/g, ' ').trim();

  // Truncate if necessary / 必要时截断
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength)}...`;
  }

  return cleaned;
}

/**
 * Get common prose CSS classes for markdown content / 获取 Markdown 内容共用的正文 CSS 类
 */
export const getMarkdownClasses = () => {
  return `prose prose-sm dark:prose-invert max-w-none w-full [&>:first-child]:mt-0 [&>:last-child]:mb-0
    prose-headings:text-gray-800 dark:prose-headings:text-gray-100
    prose-p:my-3 prose-p:leading-7 prose-p:text-gray-700 dark:prose-p:text-gray-300
    prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
    prose-ul:my-3 prose-ul:list-disc prose-ul:pl-6 prose-ol:my-3 prose-ol:list-decimal prose-ol:pl-6
    prose-li:my-1.5 prose-li:leading-7 prose-li:text-gray-700 dark:prose-li:text-gray-300
    prose-li:marker:text-gray-400 dark:prose-li:marker:text-gray-500
    prose-code:rounded prose-code:bg-black/5 dark:prose-code:bg-white/10 prose-code:px-1.5 prose-code:py-0.5
    prose-code:font-mono prose-code:text-[0.875rem] prose-code:before:content-none prose-code:after:content-none
    prose-pre:my-4 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:border prose-pre:border-black/10
    dark:prose-pre:border-white/10 prose-pre:bg-white dark:prose-pre:bg-zinc-950 prose-pre:px-4 prose-pre:py-3
    prose-pre:font-mono prose-pre:text-[0.875rem] prose-pre:leading-6 prose-pre:text-zinc-800 dark:prose-pre:text-zinc-100
    prose-pre:shadow-xs
    [&_.expressive-code]:my-4 [&_.expressive-code]:overflow-hidden [&_.expressive-code]:rounded-lg
    [&_.expressive-code]:border [&_.expressive-code]:border-black/10 dark:[&_.expressive-code]:border-white/10
    [&_.expressive-code]:shadow-xs [&_.expressive-code_pre]:m-0 [&_.expressive-code_pre]:border-0
    [&_.expressive-code_pre]:rounded-none`;
};
