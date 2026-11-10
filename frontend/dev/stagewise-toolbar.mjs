import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const runtimePrefix = '\0uptime-polaris:stagewise-runtime/';
const runtimePackages = new Map([
  ['react', 'react'],
  ['react-dom', 'react-dom'],
  ['react-dom/client', 'react-dom/client'],
  ['react/jsx-runtime', 'react/jsx-runtime'],
]);

function runtimeModule(packageName) {
  const names = Object.keys(require(packageName)).filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name));
  return `import runtime from ${JSON.stringify(packageName)};\nexport const { ${names.join(', ')} } = runtime;\nexport default runtime;`;
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Stagewise 0.6.2 toolbar patch mismatch: ${before.slice(0, 100)}`);
  return source.replace(before, () => after);
}

// The published toolbar embeds its iframe modules inside template literals. / 已发布的工具栏将 iframe 模块嵌入模板字面量。
const escapeTemplate = (source) => source.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

export function patchStagewiseToolbar(source) {
  const sessionRuntime = readFileSync(new URL('./stagewise-session.js', import.meta.url), 'utf8');
  const sharedModule = source.match(/^var define_MAIN_MODULES_default = \{ "([^"]+)":/)?.[1];
  if (!sharedModule) throw new Error('Stagewise 0.6.2 embedded modules not found');
  source = replaceOnce(source, 'async function scanForAgents(startPort = DEFAULT_STARTING_PORT) {', `async function scanForAgents(startPort = window.parent.__polarisStagewiseBridgePort ?? DEFAULT_STARTING_PORT) {
  if (window.parent.__polarisStagewiseSameOrigin) {
    const agent = await checkAgentOnPort(startPort);
    return agent ? [agent] : [];
  }`);
  source = replaceOnce(source,
    escapeTemplate('http://${hostname}:${port}/stagewise/info'),
    escapeTemplate('${window.parent.__polarisStagewiseSameOrigin ? window.parent.location.origin : "http://" + hostname + ":" + port}/stagewise/info'));
  source = replaceOnce(source,
    escapeTemplate('ws://${hostname}:${port}/stagewise/ws'),
    escapeTemplate('${window.parent.__polarisStagewiseSameOrigin ? window.parent.location.origin.replace(/^http/, "ws") : "ws://" + hostname + ":" + port}/stagewise/ws'));
  for (const packageName of runtimePackages.values()) {
    const remote = `https://esm.sh/${packageName.replace(/^(react(?:-dom)?)(\/|$)/, '$1@19.1.0$2')}\${devSuffix}`;
    const local = `/@id/__x00__${runtimePrefix.slice(1)}${packageName}`;
    source = replaceOnce(source, remote, local);
  }
  source = replaceOnce(source, '<link rel="preconnect" href="https://rsms.me/"><link rel="stylesheet" href="https://rsms.me/inter/inter.css">', '');
  source = replaceOnce(source, 'const ConfigContext =', `${escapeTemplate(sessionRuntime)}\nexport { usePolarisDraft };\nconst ConfigContext =`);
  source = replaceOnce(source, 'function useChatState() {', `import { usePolarisDraft } from "${sharedModule}";\nfunction useChatState() {`);
  const begin = source.indexOf('AgentMessagingProvider = ({');
  const end = source.indexOf('}, useAgentMessaging =', begin);
  if (begin < 0 || end < 0) throw new Error('Stagewise messaging provider not found');
  source = source.slice(0, begin) + `AgentMessagingProvider = ({ children }) => {
  const value = usePolarisMessaging();
  return jsx(agentMessagingContext.Provider, { value, children });
` + source.slice(end);
  source = replaceOnce(source, '[chatInput, setChatInput] = useState("")', '[chatInput, setChatInput] = usePolarisDraft(), sendingRef = useRef(false)');
  source = replaceOnce(source, 'if (chatInput.trim()) {', 'if (chatInput.trim() && !sendingRef.current) {\n      sendingRef.current = true;');
  source = replaceOnce(source, 'sendAgentMessage(userMessageInput), setChatInput("")', 'await sendAgentMessage(userMessageInput), setChatInput("")');
  source = replaceOnce(source, '      } finally {\n        setIsSending(!1);', '      } catch (error) {\n        console.warn("[stagewise] Draft retained after send failure:", error);\n      } finally {\n        sendingRef.current = false;\n        setIsSending(!1);');
  source = replaceOnce(source, '[isComposing, setIsComposing] = useState(!1)', 'composition = useRef(false)');
  source = replaceOnce(source, 'chatState.chatInput.trim().length > 2 && chatState.isPromptCreationActive', 'chatState.chatInput.trim().length > 0 && !chatState.isSending');
  source = replaceOnce(source, 'chatState.setChatInput(e2.target.value);', 'chatState.setChatInput(e2.target.value);\n                        chatState.startPromptCreation();');
  source = replaceOnce(source, 'chatState.sendMessage(), chatState.stopPromptCreation();', 'if (canSendMessage) void chatState.sendMessage();');
  source = replaceOnce(source, '}, [chatState]), handleKeyDown', '}, [chatState, canSendMessage]), handleKeyDown');
  source = replaceOnce(source, '!e2.shiftKey && !isComposing', '!e2.shiftKey && !composition.current && !e2.nativeEvent.isComposing && e2.nativeEvent.keyCode !== 229');
  source = replaceOnce(source, '[handleSubmit, isComposing]', '[handleSubmit]');
  source = replaceOnce(source, 'setIsComposing(!0);', 'composition.current = true;');
  source = replaceOnce(source, 'setIsComposing(!1);', 'composition.current = false;');
  source = replaceOnce(source, 'disabled: !enableInputField,', 'disabled: !enableInputField || chatState.isSending,\n                      "aria-label": "Stagewise 修改意见",');
  // React Aria excludes top layers from modal focus containment and inerting. / React Aria 不对顶层元素应用模态焦点约束和 inert 状态。
  source = replaceOnce(source, 'const wrapper = document.createElement("stagewise-toolbar");', 'const wrapper = document.createElement("stagewise-toolbar");\n  wrapper.dataset.reactAriaTopLayer = "true";');
  source = replaceOnce(source, '    const devSuffix = "", main_modules', `    wrapper.addEventListener("uptime-polaris:dispose", () => {
      window.removeEventListener("mousemove", handleMouseMove, { capture: true });
      iframe.contentWindow.removeEventListener("mousemove", handleMouseMove, { capture: true });
      for (const url of Object.values(main_modules)) URL.revokeObjectURL(url);
    }, { once: true });
    const devSuffix = "", main_modules`);
  return source;
}

export function stagewiseToolbar() {
  const moduleId = '\0uptime-polaris:stagewise-toolbar';
  return {
    name: 'uptime-polaris-stagewise-toolbar-session',
    apply: 'serve',
    enforce: 'pre',
    config() {
      return {
        resolve: { alias: [{ find: /^@stagewise\/toolbar$/, replacement: moduleId }] },
        optimizeDeps: { exclude: ['@stagewise/toolbar-react', '@stagewise/toolbar'] },
      };
    },
    resolveId(id) {
      if (id === moduleId) return moduleId;
      if (id.startsWith(runtimePrefix) && runtimePackages.has(id.slice(runtimePrefix.length))) return id;
    },
    load(id) {
      if (id.startsWith(runtimePrefix)) {
        const packageName = runtimePackages.get(id.slice(runtimePrefix.length));
        if (packageName) return runtimeModule(packageName);
      }
      if (id !== moduleId) return;
      this.addWatchFile(fileURLToPath(new URL('./stagewise-session.js', import.meta.url)));
      const path = createRequire(require.resolve('@stagewise/toolbar-react')).resolve('@stagewise/toolbar');
      return patchStagewiseToolbar(readFileSync(path.replace(/index\.cjs\.js$/, 'index.es.js'), 'utf8'));
    },
  };
}
