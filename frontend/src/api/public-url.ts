export function publicApiUrl(
  path: string,
  pageId?: string,
  location: Pick<Location, 'origin' | 'search'> = window.location,
): string {
  const url = new URL(path, location.origin);
  if (pageId !== undefined) url.searchParams.set('pageId', pageId);
  const preview = new URLSearchParams(location.search).get('preview');
  if (preview === 'monitor' || preview === 'agent') url.searchParams.set('preview', preview);
  return url.href;
}
