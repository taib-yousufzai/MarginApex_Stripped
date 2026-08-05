import React from 'react';

interface AnimatedLoaderProps {
  text?: string;
  fullScreen?: boolean;
  size?: 'small' | 'medium' | 'large';
}

export default function AnimatedLoader({ text, fullScreen = false, size = 'large' }: AnimatedLoaderProps) {
  const isSmall = size === 'small';
  const barWidth = isSmall ? '3px' : '6px';
  const barHeight = isSmall ? '18px' : '36px';
  const gap = isSmall ? '3px' : '6px';

  const loaderContent = (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: isSmall ? '8px' : '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: gap, height: barHeight }}>
          <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#4285f4', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '-0.3s' }} />
          <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#ea4335', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '-0.15s' }} />
          <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#fbbc05', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '0s' }} />
        </div>
        {text && <div style={{ fontSize: isSmall ? '12px' : '15px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>{text}</div>}
      </div>
      <style dangerouslySetInnerHTML={{ __html: `@keyframes bm-pulse { 0%, 100% { transform: scaleY(0.4); opacity: 0.5; } 50% { transform: scaleY(1); opacity: 1; } }` }} />
    </>
  );

  if (fullScreen) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.4)', zIndex: 9999999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}>
        {loaderContent}
      </div>
    );
  }

  if (isSmall) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: gap, height: barHeight }}>
          <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#4285f4', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '-0.3s' }} />
          <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#ea4335', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '-0.15s' }} />
          <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#fbbc05', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '0s' }} />
        </div>
        <style dangerouslySetInnerHTML={{ __html: `@keyframes bm-pulse { 0%, 100% { transform: scaleY(0.4); opacity: 0.5; } 50% { transform: scaleY(1); opacity: 1; } }` }} />
      </>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', minHeight: '150px' }}>
      {loaderContent}
    </div>
  );
}
