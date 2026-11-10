/**
 * Route-level error codes.
 *
 * A small union describes known cases. `errorMessageKey` maps them to public
 * messages and returns null for an unhandled case.
 *
 * 路由错误码以有限联合类型描述已知情况；`errorMessageKey` 将其映射到公开文案，
 * 未处理的情况返回 null。
 */
export type RouteErrorCode = 'render' | 'notFound';

/**
 * Message key for a code.
 *
 * Uses the public `errorPage` namespace, which is available outside the console.
 *
 * 错误码使用公开的 `errorPage` 消息命名空间，控制台外也可访问。
 */
export function errorMessageKey(code: RouteErrorCode): string | null {
  switch (code) {
    case 'render':
      return 'errorPage.globalTitle';
    case 'notFound':
      return 'errorPage.notFoundTitle';
    default:
      return null;
  }
}
