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
    window.addEventListener('global-loader-start', onStart);
    window.addEventListener('global-loader-end', onEnd);
    return () => {
      window.removeEventListener('global-loader-start', onStart);
      window.removeEventListener('global-loader-end', onEnd);
    };
  }, []);

  if (isNoShellRoute) {
    return <>{children}</>;
  }

  return (
    <div className="desktop-layout">
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
