export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super('unauthorized', 401);
    this.name = 'UnauthorizedError';
  }
}

export const SESSION_EXPIRED_EVENT = 'uptime-polaris:session-expired';

export function isRetryableApiError(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'network_error' ||
    [502, 503, 504].includes(error.status) && !['invalid_auth_config', 'schema_behind', 'no_storage', 'theme_delete_storage_unavailable'].includes(error.code));
}

const ERROR_KEYS: Record<string, string> = {
  network_error: 'error.network',
  request_timeout: 'error.timeout',
  invalid_response: 'error.invalidResponse',
  clipboard_copy_failed: 'error.clipboard',
  invalid_settings: 'admin.settings.invalidValue',
  notification_language_invalid: 'admin.notify.error.notification_language_invalid',
  name_required: 'admin.error.name_required', name_invalid: 'admin.error.name_invalid', name_taken: 'admin.error.name_taken',
  target_required: 'admin.form.targetError.required', hostname_invalid: 'admin.form.targetError.need_hostname',
  color_invalid: 'admin.error.color_invalid', weight_invalid: 'admin.error.weight_invalid',
  group_not_found: 'admin.error.group_not_found', tag_not_found: 'admin.error.tag_not_found',
  monitor_paused: 'error.monitorPaused', monitor_changed: 'error.monitorChanged',
  push_not_probeable: 'error.passiveMonitor', agent_not_probeable: 'error.passiveMonitor', agent_source_not_probeable: 'error.agentCheck',
  agent_probe_disabled: 'error.sourceUnavailable', agent_probe_capability_required: 'admin.form.agentUpgrade',
  agent_required: 'admin.form.agentMachineHint',
  agent_source_required: 'admin.form.agentOnlySourceHint',
  udp_options_invalid: 'admin.form.udpOptionsInvalid',
  agent_in_use: 'admin.agents.deleteInUse',
  visibility_invalid: 'error.invalidRequest',
  invalid_presentation: 'error.invalidRequest', presentation_conflict: 'error.conflict',
  agent_page_disabled: 'admin.presentation.agentDisabled',
  group_members_reset_required: 'admin.groups.resetRequired', name_exists: 'admin.error.name_taken',
  group_members_assigned: 'admin.groups.memberAssigned',
  invalid_json: 'error.invalidRequest', invalid_request: 'error.invalidRequest',
  unknown_action: 'admin.agents.commandUnknown', commands_disabled: 'admin.agents.commandDisabled',
  agent_unsupported: 'admin.agents.commandUnsupported', agent_offline: 'admin.agents.commandOffline', agent_not_found: 'admin.agents.commandNotFound',
  theme_not_found: 'error.notFound', theme_version_not_found: 'error.notFound',
  theme_unavailable: 'error.themeUnavailable', rollback_unavailable: 'error.rollbackUnavailable',
  theme_delete_failed: 'admin.themes.deleteFailed',
  theme_busy: 'admin.themes.operationBusy',
  theme_delete_registry_failed: 'admin.themes.deleteRegistryFailed',
  theme_delete_storage_unavailable: 'admin.themes.deleteStorageUnavailable',
  theme_delete_invalid_path: 'admin.themes.deleteInvalidPath',
  package_too_large: 'error.packageTooLarge',
  download_failed: 'error.downloadFailed', storage_write_failed: 'error.themeStorage', registry_write_failed: 'error.server',
  too_large: 'error.tooLarge', no_storage: 'error.themeStorage', schema_behind: 'error.schemaBehind',
  internal_error: 'error.server', database_unavailable: 'error.server',
  avatar_invalid: 'admin.account.avatarInvalid',
  empty_upload: 'error.themePackage', empty_download: 'error.themePackage',

  // 输入校验错误提示修改字段；精确业务码仍保留在 ApiError 中。
  // Validation errors prompt field corrections; ApiError retains the precise business code.
  options_json_invalid: 'error.invalidRequest', agent_options_invalid: 'error.invalidRequest',
  agent_probe_enabled_invalid: 'error.invalidRequest', dns_options_invalid: 'error.invalidRequest',
  dns_record_type_required: 'error.invalidRequest', invalid_target: 'error.invalidRequest',
  invalid_type: 'error.invalidRequest', invalid_value: 'error.invalidRequest',
  invalid_option: 'error.invalidRequest', values_must_be_object: 'error.invalidRequest',
  url_required: 'error.invalidRequest', invalid_group: 'error.invalidRequest',
  invalid_ids: 'error.invalidRequest', invalid_limit: 'error.invalidRequest',
  invalid_cursor: 'error.invalidRequest',
  invalid_active: 'error.invalidRequest', invalid_enabled: 'error.invalidRequest',
  invalid_name: 'error.invalidRequest', unknown_key: 'error.invalidRequest',
  agent_config_invalid: 'error.invalidRequest',
  agent_config_conflict: 'error.conflict',
  agent_config_unsupported: 'admin.agents.configUnreported',
  filename_invalid: 'error.invalidRequest', empty: 'error.invalidRequest',
  // 监控字段校验共用输入错误文案；告警规则使用专门提示。
  // Monitor field validation shares input-error copy; alert rules use a dedicated message.
  type_invalid: 'error.invalidRequest', method_invalid: 'error.invalidRequest',
  expected_status_invalid: 'error.invalidRequest', keyword_invalid: 'error.invalidRequest',
  interval_sec_invalid: 'error.invalidRequest', timeout_ms_invalid: 'error.invalidRequest',
  addon_needs_hostname: 'error.invalidRequest', addon_needs_domain: 'error.invalidRequest',
  check_source_invalid: 'error.invalidRequest',
  request_too_large: 'error.tooLarge',
  agent_alerts_invalid: 'admin.form.agentThresholdInvalid',
  agent_threshold_invalid: 'admin.form.agentThresholdInvalid',

  // 所选平台没有可下载版本时显示对应提示。
  // Report unavailable downloads for the selected platform.
  release_not_found: 'admin.agent.noBuilds',
  release_asset_missing: 'admin.agent.noBuilds',
  unknown_platform: 'admin.agent.noBuilds',

  not_found: 'error.notFound',
  budget_exhausted: 'error.server',
};

/** 已知业务码优先，其次按错误族和 HTTP 状态回退。 / Prefer known business codes, then fall back by error family and HTTP status. */

export function apiErrorMessageKey(error: unknown): string {
  const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (Object.hasOwn(ERROR_KEYS, code)) return ERROR_KEYS[code];
  if (code.startsWith('manifest_') || code === 'invalid_zip' || code === 'too_many_files') return 'error.themePackage';
  if (/^(telegram|feishu|slack|discord|webhook|apprise|serverchan)_/.test(code) || code === 'unsupported_type') return `admin.notify.error.${code}`;
  if (error instanceof ApiError) {
    if (error.status === 401) return 'error.sessionExpired';
    if (error.status === 403) return 'error.forbidden';
    if (error.status === 404) return 'error.notFound';
    if (error.status === 409) return 'error.conflict';
    if (error.status === 413) return 'error.tooLarge';
    if (error.status === 429) return 'error.rateLimited';
    if (error.status >= 500) return 'error.server';
    if (error.status >= 400) return 'error.invalidRequest';
  }
  return 'error.requestFailed';
}
