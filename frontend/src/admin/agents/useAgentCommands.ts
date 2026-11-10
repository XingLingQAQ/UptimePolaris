import { useEffect, useRef, useState } from 'react';
import { agentsApi } from './api';
import type { AgentCommandRecord } from './types';

/** 待执行命令触发更快轮询；版本模式在观察到待执行状态结束后通知调用方。 / Poll faster for pending commands; version mode notifies after an observed pending state ends. */
export function useAgentCommands({ agentId, enabled, mode, onCommandsLoaded, onUpdated }: {
  agentId: string;
  enabled: boolean;
  mode: 'dialog' | 'version';
  onCommandsLoaded: (id: string, commands: AgentCommandRecord[]) => void;
  onUpdated?: () => void;
}) {
  const [history, setHistory] = useState<{ commands: AgentCommandRecord[]; enabled: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const callbacks = useRef({ onCommandsLoaded, onUpdated });
  const pendingState = useRef({ agentId, mode, hadPending: false });
  callbacks.current = { onCommandsLoaded, onUpdated };

  useEffect(() => {
    if (pendingState.current.agentId !== agentId || pendingState.current.mode !== mode) {
      pendingState.current = { agentId, mode, hadPending: false };
    }
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let delay: number | undefined = mode === 'dialog' ? 10000 : undefined;
      setRefreshing(true);
      try {
        const response = await agentsApi.listCommands(agentId, 20, controller.signal);
        if (controller.signal.aborted) return;
        setHistory(response);
        setError(null);
        callbacks.current.onCommandsLoaded(agentId, response.commands);
        const pending = response.commands.some(row => row.state === 'pending' || row.state === 'leased');
        const completed = mode === 'version' && pendingState.current.hadPending && !pending;
        pendingState.current.hadPending = pending;
        if (completed) callbacks.current.onUpdated?.();
        if (pending) delay = 3000;
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure);
      } finally {
        if (!controller.signal.aborted) {
          setRefreshing(false);
          if (delay !== undefined) timer = setTimeout(() => void poll(), delay);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [agentId, enabled, mode, refreshKey]);

  return { history, setHistory, error, setError, refreshing, refresh: () => setRefreshKey(key => key + 1) };
}
