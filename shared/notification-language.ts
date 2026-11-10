export const notificationLanguages = ['en-US', 'zh-CN', 'zh-TW', 'zh-HK', 'ja-JP', 'ko-KR', 'fr-FR', 'pt-BR', 'ru-RU'] as const;

export type NotificationLanguage = (typeof notificationLanguages)[number];
export const defaultNotificationLanguage: NotificationLanguage = 'en-US';

export function isNotificationLanguage(value: unknown): value is NotificationLanguage {
  return typeof value === 'string' && (notificationLanguages as readonly string[]).includes(value);
}

export function resolveNotificationLanguage(value: unknown): NotificationLanguage {
  return isNotificationLanguage(value) ? value : defaultNotificationLanguage;
}
