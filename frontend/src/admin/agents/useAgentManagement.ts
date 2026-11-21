import useSWR from 'swr';
import { settingsApi, SETTINGS_KEY } from '../settings/api';

export function useAgentManagement() {
  const resource = useSWR(SETTINGS_KEY, settingsApi.listSettings, { revalidateOnFocus: true, dedupingInterval: 5000 });
  return { ...resource, enabled: resource.data?.values['features.agentManagement'] === true };
}
