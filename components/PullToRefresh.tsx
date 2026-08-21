'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';

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
  const isPulling = useRef(false);
  const isRefreshingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const PULL_THRESHOLD = 60;
  const DAMPING = 0.45;

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (isRefreshingRef.current) return;
    const scrollTop = containerRef.current?.scrollTop ?? 0;
    if (scrollTop <= 0) {
      touchStartY.current = e.touches[0].clientY;
      isPulling.current = true;
    } else {
      isPulling.current = false;
    }
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isPulling.current || isRefreshingRef.current) return;
    const dy = e.touches[0].clientY - touchStartY.current;

    const scrollTop = containerRef.current?.scrollTop ?? 0;
    if (dy > 0 && scrollTop <= 0) {
      e.preventDefault(); // works because listener is non-passive
      const dist = Math.min(dy * DAMPING, 90);
      setPullDistance(dist);
    } else {
      isPulling.current = false;
      setPullDistance(0);
    }
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (!isPulling.current || isRefreshingRef.current) return;
    isPulling.current = false;

    setPullDistance(prev => {
      if (prev >= PULL_THRESHOLD) {
        (async () => {
          isRefreshingRef.current = true;
          setIsRefreshing(true);
          setPullDistance(50);
          try {
            await Promise.all([
              Promise.resolve(onRefresh()),
              new Promise(r => setTimeout(r, 700))
            ]);
          } catch (err) {
            console.error('Pull to refresh error:', err);
          } finally {
            isRefreshingRef.current = false;
            setIsRefreshing(false);
            setPullDistance(0);
          }
        })();
        return prev;
      }
      return 0;
    });
  }, [onRefresh]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const rotationDeg = Math.min((pullDistance / PULL_THRESHOLD) * 180, 180);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        ...style,
        position: 'relative',
      }}
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
