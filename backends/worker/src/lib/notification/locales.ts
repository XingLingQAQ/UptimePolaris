import { resolveNotificationLanguage, type NotificationLanguage } from '../../../../../shared/notification-language';
import { notify as enUS } from '../../../../../frontend/src/locales/admin/en-US.json';
import { notify as zhCN } from '../../../../../frontend/src/locales/admin/zh-CN.json';
import { notify as zhTW } from '../../../../../frontend/src/locales/admin/zh-TW.json';
import { notify as zhHK } from '../../../../../frontend/src/locales/admin/zh-HK.json';
import { notify as jaJP } from '../../../../../frontend/src/locales/admin/ja-JP.json';
import { notify as koKR } from '../../../../../frontend/src/locales/admin/ko-KR.json';
import { notify as frFR } from '../../../../../frontend/src/locales/admin/fr-FR.json';
import { notify as ptBR } from '../../../../../frontend/src/locales/admin/pt-BR.json';
import { notify as ruRU } from '../../../../../frontend/src/locales/admin/ru-RU.json';

const messages = {
  'en-US': enUS.message,
  'zh-CN': zhCN.message,
  'zh-TW': zhTW.message,
  'zh-HK': zhHK.message,
  'ja-JP': jaJP.message,
  'ko-KR': koKR.message,
  'fr-FR': frFR.message,
  'pt-BR': ptBR.message,
  'ru-RU': ruRU.message,
} satisfies Record<NotificationLanguage, typeof enUS.message>;

export function notificationCopy(language?: string): typeof enUS.message {
  return messages[resolveNotificationLanguage(language)];
}
