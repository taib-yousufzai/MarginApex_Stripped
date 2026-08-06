'use client';

import React from 'react';

interface TickFlashProps {
  value: number;
  children: React.ReactNode;
  className?: string;
  suppressHydrationWarning?: boolean;
}

export default function TickFlash({ children, className = '', suppressHydrationWarning }: TickFlashProps) {
  return (
    <span className={className || undefined} suppressHydrationWarning={suppressHydrationWarning}>
      {children}
    </span>
  );
}
