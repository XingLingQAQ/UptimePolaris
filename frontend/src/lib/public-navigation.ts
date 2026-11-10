export function getPreview(search: string): 'monitor' | 'agent' | null {
  const preview = new URLSearchParams(search).get('preview');
  return preview === 'monitor' || preview === 'agent' ? preview : null;
}

/** 页面切换只继承有效的主题预览参数。 / Carry only a valid theme preview parameter across page navigation. */
export function statusPagePath(pageId: string, defaultPageId: string, search: string): string {
  const path = pageId === defaultPageId ? '/' : `/status/${encodeURIComponent(pageId)}`;
  const preview = getPreview(search);
  return preview ? `${path}?preview=${preview}` : path;
}
