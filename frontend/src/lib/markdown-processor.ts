/** Markdown for maintenance and incidents. Code blocks stay plain to avoid bundling syntax-highlighter grammars. / 维护和事件的 Markdown；代码块保持纯文本，避免打包语法高亮规则。 */
import rehypeExternalLinks from 'rehype-external-links';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkSmartypants from 'remark-smartypants';
import { unified } from 'unified';

const initialSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames || []), 'img'])],
  attributes: {
    ...defaultSchema.attributes,
    a: [...new Set([...(defaultSchema.attributes?.a || []), 'target', 'rel'])],
    img: [
      ...new Set([
        ...(defaultSchema.attributes?.img || []),
        'src',
        'alt',
        'title',
        'width',
        'height',
        'loading',
      ]),
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...new Set([...(defaultSchema.protocols?.href || []), 'http', 'https', 'mailto'])],
    src: [...new Set([...(defaultSchema.protocols?.src || []), 'http', 'https'])],
  },
};

/** Sanitize plugin output separately so generated markup can retain the allowed styling hooks. / 单独净化插件输出，让生成的标记保留允许的样式钩子。 */
const postPluginSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames || []), 'style'])],
  attributes: {
    ...defaultSchema.attributes,
    '*': [
      ...new Set([
        ...(defaultSchema.attributes?.['*'] || []),
        'className',
        'style',
        'target',
        'rel',
      ]),
    ],
    a: [...new Set([...(defaultSchema.attributes?.a || []), 'target', 'rel'])],
    pre: [...new Set([...(defaultSchema.attributes?.pre || []), 'data*'])],
    code: [...new Set([...(defaultSchema.attributes?.code || []), 'data*'])],
    div: [...new Set([...(defaultSchema.attributes?.div || []), 'data*'])],
    span: [...new Set([...(defaultSchema.attributes?.span || []), 'data*'])],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...new Set([...(defaultSchema.protocols?.href || []), 'http', 'https', 'mailto'])],
    src: [...new Set([...(defaultSchema.protocols?.src || []), 'http', 'https'])],
  },
};

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkSmartypants)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, initialSanitizeSchema)
  .use(rehypeExternalLinks, {
    rel: ['noopener', 'noreferrer', 'nofollow'],
    target: '_blank',
  })
  .use(rehypeSanitize, postPluginSanitizeSchema)
  .use(rehypeStringify);

export async function processMarkdown(content: string): Promise<string> {
  if (!content) return '';
  const file = await markdownProcessor.process(content);
  return String(file).trim();
}
