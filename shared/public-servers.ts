export interface PublicServer {
  id: string; name: string; online: boolean | null; reportedAt: number | null;
  group: { id: string; name: string } | null;
  tags: { id: string; name: string; color: string }[];
  os?: string | null; arch?: string | null; region?: string | null;
  cpu?: number | null; memoryUsed?: number | null; memoryTotal?: number | null;
  diskUsed?: number | null; diskTotal?: number | null; load?: number | null;
  upload?: number | null; download?: number | null;
  sent?: number | null; received?: number | null; uptime?: number | null;
}
export interface PublicServerHistory {
  ts: number; cpu?: number | null; memory?: number | null;
  upload?: number | null; download?: number | null;
}
