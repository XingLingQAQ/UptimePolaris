import { requestJson as request } from '../../api/client';
import type { ChannelDeliveryStats, DeliveryRecord, NotificationChannel, NotificationInput } from './types';

export const notificationsApi = {
  listNotifications: () => request<{ channels: NotificationChannel[] }>('/api/notifications'),
  /** Channels without attempts in the last 24 hours are absent. / 过去 24 小时没有发送尝试的渠道不出现。 */
  notificationStats: () =>
    request<{ channels: Record<string, ChannelDeliveryStats>; now: number }>(
      '/api/notifications/stats',
    ),
  /** Recent delivery attempts across every channel, newest first. / 所有渠道的近期发送尝试，按时间从新到旧。 */
  notificationDeliveries: (limit = 20) =>
    request<{ deliveries: DeliveryRecord[] }>(`/api/notifications/deliveries?limit=${limit}`),
  createNotification: (input: NotificationInput) =>
    request<{ id: string }>('/api/notifications', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateNotification: (id: string, input: Partial<NotificationInput>) =>
    request<{ ok: true }>(`/api/notifications/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteNotification: (id: string) =>
    request<{ ok: true }>(`/api/notifications/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** Test delivery returns the provider outcome in the response body, including rejected sends. / 测试发送在响应体中返回服务商结果，包括被拒绝的发送。 */
  testNotification: (id: string) =>
    request<{ ok: boolean; error?: string }>(
      `/api/notifications/${encodeURIComponent(id)}/test`,
      { method: 'POST' },
    ),
};
