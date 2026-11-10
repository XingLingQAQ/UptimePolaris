import { requestJson } from '@/api/client';
import { ApiError } from '@/api/errors';
import useSWR, { mutate } from 'swr';
import type {
  PresentationConfig,
  PresentationState,
} from '../../../../shared/presentation';

export const PRESENTATION_KEY = '/api/admin/presentation';
export const readPresentation = () =>
  requestJson<PresentationState>(PRESENTATION_KEY);
export const usePresentation = () =>
  useSWR<PresentationState>(PRESENTATION_KEY, readPresentation);
let writes: Promise<unknown> = Promise.resolve();
export function updatePresentation(
  edit: (config: PresentationConfig) => PresentationConfig,
): Promise<PresentationState> {
  const task = writes
    .catch(() => undefined)
    .then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await readPresentation();
        try {
          const next = await requestJson<PresentationState>(PRESENTATION_KEY, {
            method: 'PUT',
            body: JSON.stringify({
              config: edit(structuredClone(current.config)),
              revision: current.revision,
            }),
          });
          await mutate(PRESENTATION_KEY, next, false);
          return next;
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.code !== 'presentation_conflict' ||
            attempt === 2
          )
            throw error;
        }
      }
      throw new Error('presentation_conflict');
    });
  writes = task;
  return task;
}
