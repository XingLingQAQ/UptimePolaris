import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { Navigate, useLocation } from 'react-router';
import { RouteError, RouteLoading } from './RouteStates';

function SetupAwareNotFound() {
  const { session, sessionError, refresh } = useAuth();
  const location = useLocation();
  if (sessionError) return <RouteError code="render" onRetry={() => { void refresh(); }} />;
  if (!session) return <RouteLoading />;
  if (session.needsSetup) return <Navigate to="/setup" replace state={{ from: location.pathname + location.search }} />;
  return <RouteError code="notFound" />;
}

export function NotFoundRoute() {
  return <AuthProvider><SetupAwareNotFound /></AuthProvider>;
}
