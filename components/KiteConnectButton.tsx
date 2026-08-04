'use client';

import React, { useEffect, useState } from 'react';
import { kiteRestore, kiteStatus } from '@/lib/kiteClient';
import { ErrorModal } from '@/components/ErrorModal';

interface KiteStatus {
  connected: boolean;
  userName?: string;
  reason?: string;
}

export default function KiteConnectButton() {
  const [status, setStatus] = useState<KiteStatus | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      // Try to restore session from DB (no-op if cookie already exists)
      try {
        await kiteRestore();
      } catch {
        // Ignore — restore is best-effort
      }

      // Now check status
      try {
        const data = await kiteStatus();
        setStatus(data);
      } catch {
        setStatus({ connected: false });
      }
    };

    init();
  }, []);

  const handleConnect = () => {
    const apiKey = process.env.NEXT_PUBLIC_KITE_API_KEY;
    if (!apiKey) {
      console.error('Kite API Key missing in environment.');
      setModalError("Missing NEXT_PUBLIC_KITE_API_KEY in .env.local!");
      return;
    }
    window.open(
      `https://kite.trade/connect/login?api_key=${apiKey}&v=3`,
      '_blank',
    );
  };

  if (status === null) return null; // loading

  if (status.connected) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '0.7rem',
        fontWeight: 700,
        color: '#059669',
        background: 'rgba(5,150,105,0.1)',
        padding: '4px 10px',
        borderRadius: '20px',
        whiteSpace: 'nowrap',
      }}>
        <span style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: '#059669',
          display: 'inline-block',
        }} />
        LIVE
      </div>
    );
  }

  return (
    <>
      <button
        onClick={handleConnect}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '0.7rem',
          fontWeight: 700,
          color: '#fff',
          background: '#C62E2E',
          border: 'none',
          padding: '6px 12px',
          borderRadius: '20px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ fontSize: '1.2rem' }}>🔗</span>
        <span>Connect to Kite</span>
      </button>
      <ErrorModal error={modalError} onClose={() => setModalError(null)} title="Configuration Error" />
    </>
  );
}
