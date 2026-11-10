import type { NotificationType } from './types';

/** Provider form schema; secret masks an input but does not change how its value is stored. / 服务商表单配置；secret 仅遮蔽输入，不改变值的存储方式。 */
export const NOTIFICATION_META: Record<
  NotificationType,
  {
    labelKey: string;
    hintKey: string;
    /** `key` is the config field name; labelKey/hintKey resolve through i18n. / `key` 是配置字段名；labelKey 和 hintKey 通过国际化解析。 */
    fields: Array<{ key: string; labelKey: string; hintKey: string; secret?: boolean; optional?: boolean }>;
  }
> = {
  telegram: {
    labelKey: 'notify.typeTelegram',
    hintKey: 'notify.telegramHint',
    fields: [
      { key: 'bot_token', labelKey: 'notify.botToken', hintKey: 'notify.botTokenHint', secret: true },
      { key: 'chat_id', labelKey: 'notify.chatId', hintKey: 'notify.chatIdHint' },
    ],
  },
  feishu: {
    labelKey: 'notify.typeFeishu',
    hintKey: 'notify.feishuHint',
    fields: [
      { key: 'webhook_url', labelKey: 'notify.webhookUrl', hintKey: 'notify.feishuHintUrl' },
    ],
  },
  slack: {
    labelKey: 'notify.typeSlack',
    hintKey: 'notify.slackHint',
    fields: [
      { key: 'webhook_url', labelKey: 'notify.webhookUrl', hintKey: 'notify.slackHintUrl' },
    ],
  },
  discord: {
    labelKey: 'notify.typeDiscord',
    hintKey: 'notify.discordHint',
    fields: [
      { key: 'webhook_url', labelKey: 'notify.webhookUrl', hintKey: 'notify.discordHintUrl' },
    ],
  },
  webhook: {
    labelKey: 'notify.typeWebhook',
    hintKey: 'notify.webhookHint',
    fields: [
      { key: 'url', labelKey: 'notify.url', hintKey: 'notify.webhookHintUrl' },
      // Optional: many endpoints need no auth, and requiring a value would make
      // them impossible to configure.
      // 密钥可选：许多端点无需认证，强制填写会使这些端点无法配置。
      { key: 'secret', labelKey: 'notify.secret', hintKey: 'notify.webhookHintSecret', secret: true, optional: true },
    ],
  },
  apprise: {
    labelKey: 'notify.typeApprise',
    hintKey: 'notify.appriseHint',
    fields: [
      { key: 'url', labelKey: 'notify.url', hintKey: 'notify.appriseHintUrl' },
      // The destinations, and a separate field from `url` on purpose: `url` is
      // the gateway, this is what to notify. An Apprise URL (`tgram://…`,
      // `mailto://…`), not a web address - so unlike every other URL field in
      // this table it is deliberately not validated as `https:`.
      // `url` 是网关，此字段是通知目的地，因此有意分开。目的地使用 Apprise URL
      //（如 `tgram://…`、`mailto://…`），而非网页地址，因此不按其他 URL 字段
      // 的方式校验为 `https:`。
      { key: 'urls', labelKey: 'notify.appriseUrls', hintKey: 'notify.appriseHintUrls', optional: true },
      // Optional because a self-hosted Apprise needs no key - only the hosted
      // appriseit.com API does.
      // 密钥可选：自托管 Apprise 无需密钥，仅托管的 appriseit.com API 需要。
      { key: 'key', labelKey: 'notify.appriseKey', hintKey: 'notify.appriseHintKey', secret: true, optional: true },
    ],
  },
  serverchan: {
    labelKey: 'notify.typeServerChan',
    hintKey: 'notify.serverchanHint',
    fields: [
      { key: 'sendkey', labelKey: 'notify.sendKey', hintKey: 'notify.serverchanHintKey', secret: true },
    ],
  },
};

export function notificationFieldRequired(type: NotificationType, key: string, config: Record<string, string>): boolean {
  const field = NOTIFICATION_META[type].fields.find(item => item.key === key);
  return Boolean(field && (!field.optional || (type === 'apprise' && key === 'urls' && !config.key?.trim())));
}
