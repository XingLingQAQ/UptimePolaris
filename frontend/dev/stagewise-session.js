const polarisStagewiseStorage = {
  read(key, fallback) {
    try {
      return JSON.parse(sessionStorage.getItem(`uptime-polaris:stagewise:${key}`)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      sessionStorage.setItem(`uptime-polaris:stagewise:${key}`, JSON.stringify(value));
    } catch (error) {
      console.warn('[stagewise] Session could not be saved:', error);
    }
  },
};

function usePolarisDraft() {
  const [draft, updateDraft] = useState(() => {
    const saved = polarisStagewiseStorage.read('draft', '');
    return typeof saved === 'string' ? saved : '';
  });
  const setDraft = useCallback((value) => {
    polarisStagewiseStorage.write('draft', value);
    updateDraft(value);
  }, []);
  return [draft, setDraft];
}

function usePolarisMessaging() {
  const agent = useAgents().connected;
  const [messages, setMessages] = useState(() => {
    const saved = polarisStagewiseStorage.read('messages', []);
    return Array.isArray(saved) ? saved.filter((message) =>
      typeof message?.id === 'string' && ['user', 'assistant'].includes(message.role) &&
      Array.isArray(message.contentItems) && message.contentItems.every((item) =>
        item?.type === 'text' && typeof item.text === 'string'),
    ).slice(-100) : [];
  });
  const messagesRef = useRef(messages);
  const processed = useRef(new Set());
  const saveMessage = useCallback((message, append = false) => {
    const previous = messagesRef.current;
    const index = previous.findIndex((item) => item.id === message.id);
    const next = [...previous];
    const current = next[index];
    const incoming = append && current
      ? { ...message, contentItems: message.contentItems.map((item, partIndex) => ({
        ...item, text: (current.contentItems[partIndex]?.text ?? '') + item.text,
      })) }
      : message;
    if (index < 0) next.push(incoming);
    else next[index] = incoming;
    const bounded = next.slice(-100);
    messagesRef.current = bounded;
    polarisStagewiseStorage.write('messages', bounded);
    setMessages(bounded);
  }, []);

  useEffect(() => {
    if (!agent) return;
    const subscription = agent.agent.messaging.getMessage.subscribe(undefined, {
      onData(update) {
        const key = JSON.stringify([update.messageId, update.createdAt, update.resync]);
        if (processed.current.has(key)) return;
        processed.current.add(key);
        if (processed.current.size > 200) processed.current.delete(processed.current.values().next().value);
        const contentItems = [...update.updateParts].sort((a, b) => a.contentIndex - b.contentIndex)
          .filter(({ part }) => part.type === 'text').map(({ part }) => ({ type: 'text', text: part.text }));
        if (contentItems.some((item) => item.text)) {
          saveMessage({ id: update.messageId, role: 'assistant', contentItems }, !update.resync);
        }
      },
      onError(error) {
        console.warn('[stagewise] Connection interrupted; conversation retained:', error);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, saveMessage]);

  const sendMessage = useCallback(async (message) => {
    try {
      if (!agent) throw new Error('Agent disconnected');
      // Register before the reply can arrive; failed sends keep the draft too. / 在回复到达前登记；发送失败时也保留草稿。
      saveMessage({ id: message.id, role: 'user', contentItems: message.contentItems.filter((item) => item.type === 'text') });
      await agent.agent.messaging.sendUserMessage.mutate(message);
    } catch (error) {
      saveMessage({ id: `error:${message.id}`, role: 'assistant', contentItems: [
        { type: 'text', text: '发送失败，草稿已保留。请等待本地反馈接收端重新连接，然后重试。' },
      ] });
      throw error;
    }
  }, [agent, saveMessage]);

  const agentMessage = useMemo(() => messages.length ? {
    id: 'uptime-polaris-conversation',
    contentItems: messages.map((message) => ({
      type: 'text',
      text: `${message.role === 'user' ? '你' : 'Stagewise'}：\n${message.contentItems.map((item) => item.text).join('\n')}`,
    })),
  } : null, [messages]);
  return { agentMessage, sendMessage };
}
