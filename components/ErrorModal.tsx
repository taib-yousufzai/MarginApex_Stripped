import React from 'react';

interface ErrorModalProps {
  error: string | null;
  onClose: () => void;
  title?: string;
}

export function ErrorModal({ error, onClose, title = 'Error' }: ErrorModalProps) {
  if (!error) return null;
  return (
    <div className="error-overlay" style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      zIndex: 999999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.2s ease-out'
    }}>
      <div style={{
        background: 'var(--bg-card, #ffffff)',
        borderRadius: '12px',
        padding: '24px',
        width: '90%', maxWidth: '340px',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        border: '1px solid var(--border-color, #e5e7eb)',
        transform: 'scale(1)',
        animation: 'slideUpFade 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
      }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: '700', color: 'var(--sell-color, #ef4444)' }}>
          {title}
        </h3>
        <p style={{ margin: '0 0 24px 0', fontSize: '14px', color: 'var(--text-secondary, #4B5563)', lineHeight: '1.5', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {error}
        </p>
        <button 
          onClick={onClose}
          style={{
            width: '100%',
            padding: '12px',
            background: 'var(--sell-color, #ef4444)',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontWeight: '600',
            fontSize: '15px',
            cursor: 'pointer'
          }}
        >
          OK
        </button>
      </div>
    </div>
  );
}
