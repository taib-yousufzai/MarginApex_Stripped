'use client';

import React, { useEffect, useRef, useState } from 'react';

interface TickFlashProps {
  value: number;
  children: React.ReactNode;
  className?: string;
}

export default function TickFlash({ value, children, className = '' }: TickFlashProps) {
  const [flashClass, setFlashClass] = useState('');
  const prevValueRef = useRef<number | null>(null);

  useEffect(() => {
    if (prevValueRef.current !== null && value !== prevValueRef.current) {
      if (value > prevValueRef.current) {
        setFlashClass('tick-up');
      } else {
        setFlashClass('tick-down');
      }
      const timer = setTimeout(() => {
        setFlashClass('');
      }, 500);
      return () => clearTimeout(timer);
    }
    prevValueRef.current = value;
  }, [value]);

  return (
    <span className={`tick-flash ${className} ${flashClass}`.trim()}>
      {children}
    </span>
  );
}
