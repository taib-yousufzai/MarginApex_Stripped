'use client';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/lib/auth';
import { RequirePermission } from './RequirePermission';
import { Permission } from '@/lib/permissions';
import './Sidebar.css';

const navItems: { key: string, label: string, icon: string, path: string, perm?: Permission }[] = [
  { key: 'home', label: 'Dashboard', icon: 'fas fa-th-large', path: '/' },
  { key: 'watchlist', label: 'Watchlist', icon: 'fas fa-list', path: '/watchlist' },
  { key: 'order', label: 'Orders', icon: 'fas fa-file-invoice-dollar', path: '/order', perm: 'VIEW_OWN_ORDERS' },
  { key: 'position', label: 'Positions', icon: 'fas fa-chart-line', path: '/position', perm: 'VIEW_OWN_POSITIONS' },
  { key: 'history', label: 'History', icon: 'fas fa-history', path: '/history', perm: 'VIEW_OWN_TRADES' },
  { key: 'funds', label: 'Funds', icon: 'fas fa-wallet', path: '/funds', perm: 'VIEW_OWN_WALLET' },
  { key: 'rules', label: 'Rules', icon: 'fas fa-file-contract', path: '/rules' },
  { key: 'profile', label: 'Profile', icon: 'fas fa-user-circle', path: '/profile', perm: 'VIEW_OWN_PROFILE' },
  { key: 'users', label: 'Users', icon: 'fas fa-users', path: '/admin#users', perm: 'VIEW_USERS' },
  { key: 'admin', label: 'Admin', icon: 'fas fa-cogs', path: '/admin#settings', perm: 'MANAGE_GLOBAL_SETTINGS' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('marginApexTheme');
    setIsDark(saved === 'dark');
  }, []);

  const toggleTheme = () => {
    const newDark = !isDark;
    setIsDark(newDark);
    document.body.classList.remove('dark', 'black', 'blue');
    document.documentElement.classList.remove('dark', 'black', 'blue');
    if (newDark) {
      document.body.classList.add('dark');
      document.documentElement.classList.add('dark');
    } else {
      const t = localStorage.getItem('marginApexTheme');
      if (t === 'black') {
        document.body.classList.add('black');
        document.documentElement.classList.add('black');
      }
    }
    localStorage.setItem('marginApexTheme', newDark ? 'dark' : 'light');
    window.dispatchEvent(new Event('themeChanged'));
  };

  return (
    <aside className={`desktop-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img src="/icon-512x512.png" alt="Logo" className="logo-icon-img" />
          {!isCollapsed && <span className="logo-text">MARGIN<span>APEX</span></span>}
        </div>
        <button className="collapse-btn" onClick={() => setIsCollapsed(!isCollapsed)}>
          <i className={`fas fa-chevron-${isCollapsed ? 'right' : 'left'}`}></i>
        </button>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const isActive = pathname === item.path || (item.path !== '/' && pathname.startsWith(item.path));
          const linkNode = (
            <Link key={item.key} href={item.path} className={`sidebar-item ${isActive ? 'active' : ''}`}>
              <div className="sidebar-icon">
                <i className={item.icon}></i>
              </div>
              {!isCollapsed && <span className="sidebar-label">{item.label}</span>}
              {isActive && <div className="active-indicator" />}
            </Link>
          );

          if (item.perm) {
            return (
              <RequirePermission key={item.key} permission={item.perm}>
                {linkNode}
              </RequirePermission>
            );
          }

          return linkNode;
        })}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-action-btn" onClick={toggleTheme} title="Toggle Theme">
          <div className="sidebar-icon">
            <i className={isDark ? 'fas fa-sun' : 'fas fa-moon'}></i>
          </div>
          {!isCollapsed && <span className="sidebar-label">{isDark ? 'Light Mode' : 'Dark Mode'}</span>}
        </button>
        
        <button className="sidebar-action-btn logout" onClick={() => signOut()} title="Logout">
          <div className="sidebar-icon">
            <i className="fas fa-sign-out-alt"></i>
          </div>
          {!isCollapsed && <span className="sidebar-label">Logout</span>}
        </button>
      </div>
    </aside>
  );
}
