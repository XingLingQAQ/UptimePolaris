export const ACTIVE_PROBE_TYPES = ['http', 'tcp', 'udp', 'icmp'] as const;
export type ActiveProbeType = typeof ACTIVE_PROBE_TYPES[number];
export const AGENT_ONLY_PROBE_TYPES = ['udp', 'icmp'] as const;

export function isActiveProbeType(type: string): type is ActiveProbeType {
  return (ACTIVE_PROBE_TYPES as readonly string[]).includes(type);
}

export function requiresAgentProbe(type: string): boolean {
  return (AGENT_ONLY_PROBE_TYPES as readonly string[]).includes(type);
}

export interface ProbeAddonSelection {
  ssl?: boolean;
  domain?: boolean;
  dns?: boolean;
}

export function requiredProbeCapabilities(type: string, addons: ProbeAddonSelection = {}): string[] {
  return [`probe_${type}`, ...(addons.ssl ? ['probe_ssl'] : []), ...(addons.domain ? ['probe_domain'] : []), ...(addons.dns ? ['probe_dns'] : [])];
}
