'use client';

import React, { useState, useRef } from 'react';

interface PullToRefreshProps {
  onRefresh: () => Promise<void> | void;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export default function PullToRefresh({ onRefresh, children, className = '', style }: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const touchStartY = useRef(0);
  const touchCurrentY = useRef(0);
  const isPulling = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const PULL_THRESHOLD = 60;
  const DAMPING = 0.45;

  const handleTouchStart = (e: React.TouchEvent) => {
    if (containerRef.current && containerRef.current.scrollTop <= 0 && !isRefreshing) {
      touchStartY.current = e.touches[0].clientY;
      touchCurrentY.current = e.touches[0].clientY;
      isPulling.current = true;
    } else {
      isPulling.current = false;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isPulling.current || isRefreshing) return;
    touchCurrentY.current = e.touches[0].clientY;
    const dy = touchCurrentY.current - touchStartY.current;

    if (dy > 0 && containerRef.current && containerRef.current.scrollTop <= 0) {
      const dist = Math.min(dy * DAMPING, 90);
      setPullDistance(dist);
      if (dy > 10 && e.cancelable) {
        e.preventDefault();
      }
    } else {
      setPullDistance(0);
    }
  };

  const handleTouchEnd = async () => {
    if (!isPulling.current || isRefreshing) return;
    isPulling.current = false;

    if (pullDistance >= PULL_THRESHOLD) {
      setIsRefreshing(true);
      setPullDistance(50);
      try {
        await Promise.all([
          Promise.resolve(onRefresh()),
          new Promise(r => setTimeout(r, 600))
        ]);
      } catch (err) {
        console.error('Pull to refresh error:', err);
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  };

  const rotationDeg = Math.min((pullDistance / PULL_THRESHOLD) * 180, 180);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        ...style,
        position: 'relative'
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {(pullDistance > 0 || isRefreshing) && (
        <div
          style={{
            height: isRefreshing ? '48px' : `${pullDistance}px`,
            maxHeight: '65px',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: isPulling.current ? 'none' : 'height 0.25s ease, opacity 0.25s ease',
            gap: '8px',
            fontSize: '0.8rem',
            fontWeight: 600,
            width: '100%',
            flexShrink: 0
          }}
        >
          <i
            className={`fas fa-sync-alt ${isRefreshing ? 'fa-spin' : ''}`}
            style={{
              transform: isRefreshing ? 'none' : `rotate(${rotationDeg}deg)`,
              transition: isPulling.current ? 'none' : 'transform 0.2s ease',
              color: pullDistance >= PULL_THRESHOLD || isRefreshing ? '#C62E2E' : '#8C94A8',
              fontSize: '0.9rem'
            }}
          />
          <span style={{ color: pullDistance >= PULL_THRESHOLD || isRefreshing ? 'var(--text-primary, #1A1E2B)' : '#8C94A8', fontSize: '0.75rem' }}>
            {isRefreshing
              ? 'Refreshing positions...'
              : pullDistance >= PULL_THRESHOLD
                ? 'Release to refresh'
                : 'Pull down to refresh'}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
