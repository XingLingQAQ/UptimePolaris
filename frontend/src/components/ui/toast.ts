import { toast as sonnerToast, type ExternalToast } from 'sonner';
import { dismissSuccessFeedback, publishSuccessFeedback, usesSuccessIsland } from './success-feedback';

type Message = Parameters<typeof sonnerToast.success>[0];

export const toast: typeof sonnerToast = Object.assign(
  (message: Message, options?: ExternalToast) => sonnerToast(message, options),
  sonnerToast,
  {
    success(message: Message, options?: ExternalToast) {
      if (!usesSuccessIsland()) return sonnerToast.success(message, options);
      if (options?.id !== undefined) sonnerToast.dismiss(options.id);
      return publishSuccessFeedback(message, options);
    },
    dismiss(id?: string | number) {
      dismissSuccessFeedback(id);
      return sonnerToast.dismiss(id);
    },
  },
);
