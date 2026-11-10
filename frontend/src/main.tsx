import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

// Self-hosted fonts. Geist for Latin and figures, its mono for hosts and
// versions; CJK falls through to the platform's own UI face (see the stack in
// styles/console.css). Variable files, so one request per script covers every
// weight the page uses.
// 自托管 Geist 字体用于拉丁文字和数字，等宽字体用于主机名与版本；
// 中日韩文字回退到系统字体。可变字体每种仅需一次请求即可覆盖所有字重。
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

import { App } from './App';
import { getRootErrorCopy } from './i18n/IntlProvider';
import './styles/console.css';
import './styles/fonts.css';
import './styles/globals.css';
import './styles/toast-motion.css';
import { initializeMotionPreference } from './lib/motion-preference';

initializeMotionPreference();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// The body supplies the themed background and font to every route. / body 为所有路由提供主题背景和字体。
document.body.className = 'min-h-screen bg-background font-sans antialiased';

/**
 * One design language for every surface: the console's theme (`styles/
 * console.css`) is keyed on this class, and the public pages now share it. It
 * sits on `<html>` so HeroUI's portals, which mount under `<body>`, inherit it.
 *
 * 公开页面与控制台共用主题；将主题类放在 `<html>` 上，让挂载于 `<body>` 的 HeroUI portal 继承。
 */
document.documentElement.classList.add('polaris-console');

class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      const copy = getRootErrorCopy();
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="text-sm text-default-500">{copy.description}</p>
          <button className="rounded-lg bg-primary px-4 py-2 text-white" onClick={() => window.location.reload()}>
            {copy.reload}
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(root, {
  onUncaughtError: (_error, info) => console.error('[react:uncaught]', info.componentStack),
  onCaughtError: (_error, info) => console.error('[react:caught]', info.componentStack),
  onRecoverableError: (_error, info) => console.error('[react:recoverable]', info.componentStack),
}).render(
  <StrictMode>
    <RootErrorBoundary>
      <div className="min-h-screen bg-background">
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </div>
    </RootErrorBoundary>
  </StrictMode>,
);

if (import.meta.env.DEV) void import('./dev/stagewise');
