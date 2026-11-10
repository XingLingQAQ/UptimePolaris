import { RouteLoading } from '@/routes/RouteStates';
import { RouteTransition } from '@/routes/RouteTransition';
import { Suspense, useContext } from 'react';
import { UNSAFE_LocationContext, useLocation, useOutlet } from 'react-router';
import { AdminShell } from './AdminShell';

export function AdminLayout() {
  const { pathname } = useLocation();
  const locationContext = useContext(UNSAFE_LocationContext);
  const outlet = useOutlet();

  return (
    <AdminShell>
      <RouteTransition routeKey={pathname}>
        {/* Keep the outgoing outlet on its own location until its exit finishes. / 退出动画结束前，让旧路由内容保留原位置。 */}
        <UNSAFE_LocationContext.Provider value={locationContext}>
          <Suspense fallback={<RouteLoading embedded />}>{outlet}</Suspense>
        </UNSAFE_LocationContext.Provider>
      </RouteTransition>
    </AdminShell>
  );
}
