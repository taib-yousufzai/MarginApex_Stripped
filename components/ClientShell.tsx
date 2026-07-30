'use client';

import React, { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import Footer from '@/components/Footer';

export default function ClientShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';

  const noShellRoutes = [
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/accept-invite'
  ];
  
  const isNoShellRoute = noShellRoutes.includes(pathname) || pathname.startsWith('/admin');

  const activeTab = useMemo(() => {
    if (pathname.includes('/watchlist')) return 'watchlist';
    if (pathname.includes('/order')) return 'order';
    if (pathname.includes('/position')) return 'position';
    if (pathname.includes('/history')) return 'history';
    if (pathname.includes('/profile')) return 'profile';
    return 'home';
  }, [pathname]);

  const [isGlobalLoading, setIsGlobalLoading] = React.useState(false);
  const [loadingText, setLoadingText] = React.useState('Processing Order...');

  React.useEffect(() => {
    const onStart = (e: any) => {
      setLoadingText(e.detail || 'Processing Order...');
      setIsGlobalLoading(true);
    };
    const onEnd = () => setIsGlobalLoading(false);

    const onExitStart = () => {
      setLoadingText('Exiting Position...');
      setIsGlobalLoading(true);
    };
    const onExitEnd = () => setIsGlobalLoading(false);

    window.addEventListener('global-loader-start', onStart);
    window.addEventListener('global-loader-end', onEnd);
    window.addEventListener('exit-overlay-start', onExitStart);
    window.addEventListener('exit-overlay-end', onExitEnd);
    return () => {
      window.removeEventListener('global-loader-start', onStart);
      window.removeEventListener('global-loader-end', onEnd);
      window.removeEventListener('exit-overlay-start', onExitStart);
      window.removeEventListener('exit-overlay-end', onExitEnd);
    };
  }, []);

  if (isNoShellRoute) {
    return <>{children}</>;
  }

  return (
    <div className="desktop-layout">
      {isGlobalLoading && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.4)', zIndex: 9999999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: '36px' }}>
              <div style={{ width: '6px', height: '100%', borderRadius: '4px', background: '#4285f4', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '-0.3s' }} />
              <div style={{ width: '6px', height: '100%', borderRadius: '4px', background: '#ea4335', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '-0.15s' }} />
              <div style={{ width: '6px', height: '100%', borderRadius: '4px', background: '#fbbc05', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '0s' }} />
            </div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>{loadingText}</div>
          </div>
          <style dangerouslySetInnerHTML={{ __html: `@keyframes bm-pulse { 0%, 100% { transform: scaleY(0.4); opacity: 0.5; } 50% { transform: scaleY(1); opacity: 1; } }` }} />
        </div>
      )}
      <Sidebar />
      <main className="main-viewport">
        <div className="app-container">
          {children}
        </div>
        <Footer activeTab={activeTab as any} />
      </main>
    </div>
  );
}
