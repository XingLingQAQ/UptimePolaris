import type { Env } from '../../types';
import { decryptUrl, encryptUrl, type ControlRow, type DatabaseType } from './setup-control';

type Command =
  | { action: 'read' | 'discard' }
  | { action: 'claim'; type: DatabaseType; url?: string; source: 'deployment' | 'selected' }
  | { action: 'mark' | 'finish' | 'release' | 'reset' | 'abandon'; operation: string; lease: string };

export class SetupConfiguration {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const command = await request.json<Command>();
      return await this.state.blockConcurrencyWhile(async () => {
        let row = await this.state.storage.get<ControlRow>('database');
        if (command.action === 'read') return Response.json(row ?? null);
        const now = Math.floor(Date.now() / 1000);
        if (command.action === 'discard') {
          if (!row || row.phase !== 'pending' || row.account_started || row.lease_id && row.lease_until > now) return Response.json(false);
          await this.state.storage.delete('database');
          return Response.json(true);
        }
        if (command.action === 'claim') {
          if (row) {
            if (row.phase !== 'pending' || row.type !== command.type || row.lease_id && row.lease_until > now) return Response.json(null);
            if (row.type === 'postgres' && (!row.encrypted_url || await decryptUrl(row.encrypted_url, this.env.ADMIN_TOKEN) !== command.url)) return Response.json(null);
          } else {
            row = {
              type: command.type, encrypted_url: command.url ? await encryptUrl(command.url, this.env.ADMIN_TOKEN) : null,
              source: command.source, operation: crypto.randomUUID(), phase: 'pending', lease_id: null, lease_until: 0, account_started: 0,
            };
          }
          row.lease_id = crypto.randomUUID();
          row.lease_until = now + 600;
          await this.state.storage.put('database', row);
          return Response.json({ operation: row.operation, lease: row.lease_id, accountStarted: row.account_started === 1, source: row.source });
        }
        if (!('operation' in command) || !row || row.phase !== 'pending' || row.operation !== command.operation || row.lease_id !== command.lease) {
          return new Response(null, { status: 409 });
        }
        switch (command.action) {
          case 'mark': row.account_started = 1; break;
          case 'reset': row.account_started = 0; break;
          case 'finish': row.phase = 'active'; row.lease_id = null; row.lease_until = 0; break;
          case 'release': row.lease_id = null; row.lease_until = 0; break;
          case 'abandon':
            if (!row.account_started) { await this.state.storage.delete('database'); return Response.json(true); }
            return new Response(null, { status: 409 });
        }
        await this.state.storage.put('database', row);
        return Response.json(true);
      });
    } catch {
      return new Response(null, { status: 500 });
    }
  }
}
