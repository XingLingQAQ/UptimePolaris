import { StagewiseToolbar } from '@stagewise/toolbar-react';
import ReactPlugin from '@stagewise-plugins/react';
import { createRoot } from 'react-dom/client';
import reactContextPlugin from './stagewise-react-context.js?raw';

const container = document.createElement('div');
container.id = 'uptime-polaris-stagewise';
document.body.append(container);

const root = createRoot(container);
root.render(
  <StagewiseToolbar
    enabled
    config={{
      plugins: [ReactPlugin, { loader: true, mainPlugin: reactContextPlugin }],
      experimental: { enableStagewiseMCP: false, enableToolCalls: false },
    }}
  />,
);

if (import.meta.hot) import.meta.hot.dispose(() => {
  const toolbar = document.querySelector('stagewise-toolbar');
  toolbar?.dispatchEvent(new Event('uptime-polaris:dispose'));
  toolbar?.remove();
  root.unmount();
  container.remove();
});
