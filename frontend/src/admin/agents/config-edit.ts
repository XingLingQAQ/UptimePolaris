import type { AgentConfigurationState, AgentRuntimeConfig } from '../../../../shared/agent-runtime-config';

export interface ConfigEdit {
  draft: AgentRuntimeConfig | null;
  baseline: AgentRuntimeConfig | null;
  revision: string | null;
}

export function configDirty(edit: ConfigEdit): boolean {
  return JSON.stringify(edit.draft) !== JSON.stringify(edit.baseline);
}

export function syncConfigEdit(edit: ConfigEdit | null, remote: AgentConfigurationState): ConfigEdit {
  if (edit && configDirty(edit)) return edit;
  const config = remote.desired ?? remote.current;
  return { draft: config, baseline: config, revision: remote.desired_revision };
}

export function configEditConflicts(edit: ConfigEdit | null, remote: AgentConfigurationState | null): boolean {
  return edit !== null && remote !== null && configDirty(edit) && edit.revision !== remote.desired_revision;
}
