import { MotionConfig } from 'framer-motion';
import { subscribeMotionPreference } from './lib/motion-preference';
import { ThemeProvider } from 'next-themes';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Outlet, Route, Routes } from 'react-router';
import { ADMIN_PAGE_LOADERS } from './admin/page-loaders';
import { RequireAuth } from './auth/AuthContext';
import { MonitorFilterProvider } from './components/status-page/MonitorFilterContext';
import { ToastHost } from './components/ui/ToastHost';
import { OverflowTooltip } from './components/ui/OverflowTooltip';
import { IntlProvider } from './i18n/IntlProvider';
import { MonitorDetailRoute } from './routes/MonitorDetailRoute';
import { RouteError, RouteLoading } from './routes/RouteStates';
import { NotFoundRoute } from './routes/NotFoundRoute';
import { StatusPageRoute } from './routes/StatusPageRoute';
import { PublicPageRoute } from './routes/PublicPageRoute';
import { PublicMaintenance } from './components/status-page/PublicMaintenance';

const LoginPage = lazy(() => import('./auth/LoginPage').then((module) => ({ default: module.LoginPage })));
const SetupPage = lazy(() => import('./auth/SetupPage').then((module) => ({ default: module.SetupPage })));
const AdminLayout = lazy(() => import('./admin/layout/AdminLayout').then((module) => ({ default: module.AdminLayout })));
const MonitorsPage = lazy(ADMIN_PAGE_LOADERS.monitors);
const AgentsPage = lazy(ADMIN_PAGE_LOADERS.agents);
const GroupsPage = lazy(ADMIN_PAGE_LOADERS.groups);
const NotificationsPage = lazy(ADMIN_PAGE_LOADERS.notifications);
const ThemesPage = lazy(ADMIN_PAGE_LOADERS.themes);
const SettingsPage = lazy(ADMIN_PAGE_LOADERS.settings);
const ConsoleProviders = lazy(() =>
  import('./admin/layout/ConsoleProviders').then((module) => ({ default: module.ConsoleProviders })),
);

function guarded(node: ReactNode) {
  return (
    <RequireAuth>
      <Suspense fallback={<RouteLoading />}>{node}</Suspense>
    </RequireAuth>
  );
}

function ConsoleLayout() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <ConsoleProviders>
        <Outlet />
      </ConsoleProviders>
    </Suspense>
  );
}

export function App({ httpStatus }: { httpStatus?: number }) {
  useEffect(() => subscribeMotionPreference(() => {}), []);
  return (
    <MotionConfig reducedMotion="never">
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="theme">
        <IntlProvider>
          <MonitorFilterProvider>
            {httpStatus === 404 ? <NotFoundRoute /> : httpStatus && httpStatus >= 500 ? <RouteError code="render" /> : <Routes>
              <Route element={<PublicMaintenance />}>
                <Route path="/" element={<PublicPageRoute />} />
                <Route path="/server/:id" element={<PublicPageRoute />} />
                <Route path="/status/:pageId" element={<StatusPageRoute />} />
                <Route path="/monitor/:id" element={<MonitorDetailRoute />} />
                <Route path="*" element={<NotFoundRoute />} />
              </Route>

              <Route element={<ConsoleLayout />}>
                <Route
                  path="/setup"
                  element={<Suspense fallback={<RouteLoading />}><SetupPage /></Suspense>}
                />
                <Route
                  path="/login"
                  element={<Suspense fallback={<RouteLoading />}><LoginPage /></Suspense>}
                />
                <Route path="/admin" element={guarded(<AdminLayout />)}>
                  <Route index element={<MonitorsPage />} />
                  <Route path="agents" element={<AgentsPage />} />
                  <Route path="groups" element={<GroupsPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                  <Route path="themes" element={<ThemesPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<RouteError code="notFound" embedded />} />
                </Route>
              </Route>
            </Routes>}
            <ToastHost />
            <OverflowTooltip />
          </MonitorFilterProvider>
        </IntlProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
