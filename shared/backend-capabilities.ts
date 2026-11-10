export const MONITOR_TYPES = ['http', 'tcp', 'udp', 'icmp', 'dns', 'tls', 'websocket', 'push', 'agent'] as const;
export type MonitorType = typeof MONITOR_TYPES[number];
export type BackendProbeSource = 'worker' | 'server';

export interface BackendCapabilities {
  runtime: 'worker' | 'go';
  apiVersion: 1;
  probeSource: BackendProbeSource;
  monitoring: {
    types: MonitorType[];
    nativeTypes: MonitorType[];
    minimumIntervalSec: number;
    minimumTimeoutMs: number;
    maximumTimeoutMs: number;
    sslMode: 'certificate-records' | 'tls-handshake';
  };
  themes: { storage: 'r2' | 'filesystem'; installationAvailable: boolean };
}

export function isProbeMonitorType(type: string): boolean {
  return type !== 'push' && type !== 'agent' && (MONITOR_TYPES as readonly string[]).includes(type);
}
