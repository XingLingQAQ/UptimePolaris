import { requestJson } from '@/api/client';
import { publicApiUrl } from '@/api/public-url';
import type { PresentationView } from '@/components/context/PresentationViewContext';
import type { GlobalConfig, PublicConfig, UiConfig } from '@/types/config';

export interface PublicConfigResponse extends UiConfig, GlobalConfig {
  presentation: PresentationView;
  success: true;
  status: 'ok';
  error?: string;
  timestamp?: number;
}

export const publicConfigKey = (pageId?: string) => publicApiUrl('/api/public/config', pageId);
export const fetchPublicConfig = (key: string) => requestJson<PublicConfigResponse>(key);

export function toPageConfig(payload: PublicConfigResponse): PublicConfig {
  return {
    defaultPageId: payload.defaultPageId,
    pageId: payload.pageId,
    pageIds: payload.pageIds,
    pages: payload.pages,
    siteMeta: payload.siteMeta,
    isPlaceholder: payload.isPlaceholder,
    isEditThisPage: payload.isEditThisPage,
    isShowStarButton: payload.isShowStarButton,
  };
}
