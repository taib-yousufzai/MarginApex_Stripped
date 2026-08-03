'use client';

import React from 'react';

interface TickFlashProps {
  value: number;
  children: React.ReactNode;
  className?: string;
}

export default function TickFlash({ children, className = '' }: TickFlashProps) {
  return (
    <span className={className || undefined}>
      {children}
    </span>
  );
}
