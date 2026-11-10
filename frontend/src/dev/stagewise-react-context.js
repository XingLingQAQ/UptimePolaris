let appWindow;

export default {
  pluginName: 'uptime-polaris-react-context',
  displayName: 'Uptime Polaris React context',
  description: 'Preserve React component names and source locations before DOM metadata is serialized.',
  iconSvg: null,
  onLoad({ mainAppWindow }) {
    appWindow = mainAppWindow;
  },
  onPromptSend(prompt) {
    const elements = prompt.metadata.selectedElements.map((selected, index) => {
      const element = appWindow.document.evaluate(selected.xpath, appWindow.document, null, 9, null).singleNodeValue;
      if (!element) return { index, xpath: selected.xpath, components: [] };
      const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      const components = [];
      const sources = new Set();
      let fiber = key ? element[key] : undefined;
      for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
        const type = fiber.type;
        const name = typeof type === 'function'
          ? type.displayName || type.name
          : typeof type === 'object' && type
            ? type.displayName || type.render?.displayName || type.render?.name
            : undefined;
        if (name && !components.includes(name) && components.length < 16) components.push(name);
        if (fiber._debugSource?.fileName) sources.add(fiber._debugSource.fileName);
        const stack = fiber._debugStack?.stack ?? '';
        for (const source of stack.match(/https?:\/\/[^\s)]+\/src\/[^\s)]+\.(?:tsx?|jsx?)(?::\d+:\d+)?/g) ?? []) sources.add(source);
      }
      return { index, xpath: selected.xpath, components, sources: [...sources].slice(0, 12) };
    });
    return elements.length ? {
      contextSnippets: [{ promptContextName: 'react-component-context', content: JSON.stringify(elements, null, 2) }],
    } : null;
  },
};
