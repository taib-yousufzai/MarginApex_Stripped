'use client';
import React, { useState, useEffect } from 'react';
import { apiCall, Toast, ToastState, UserListItem } from '../AdminUtils';

const ALL_SEGMENTS = ['INDEX-FUT', 'STOCK-OPT', 'STOCKS', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

export default function UpdateCopySettings({ selectedUser }: { selectedUser?: { id: string } }) {
  const [sourceUid, setSourceUid] = useState('');
  const [targetUid, setTargetUid] = useState(selectedUser?.id || '');
  const [segmentsToCopy, setSegmentsToCopy] = useState<string[]>(ALL_SEGMENTS);
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  // Sync selectedUser if changed
  useEffect(() => {
    if (selectedUser?.id) {
      setTargetUid(selectedUser.id);
    }
  }, [selectedUser?.id]);

  // Load user list for convenient selection
  useEffect(() => {
    apiCall('/api/admin/users', { method: 'GET' }).then(({ ok, data }) => {
      if (ok && Array.isArray(data)) {
        setUsers(data as UserListItem[]);
      }
    }).catch(() => {});
  }, []);

  const toggleSeg = (s: string) => {
    setSegmentsToCopy(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  };

  const handleSelectAll = () => {
    if (segmentsToCopy.length === ALL_SEGMENTS.length) {
      setSegmentsToCopy([]);
    } else {
      setSegmentsToCopy(ALL_SEGMENTS);
    }
  };

  const handleCopy = async () => {
    if (!sourceUid.trim()) {
      setToast({ message: 'Please select or enter a Source User', type: 'error' });
      return;
    }
    if (!targetUid.trim()) {
      setToast({ message: 'Please select or enter a Target User', type: 'error' });
      return;
    }
    if (sourceUid.trim() === targetUid.trim()) {
      setToast({ message: 'Source and Target user cannot be the same', type: 'error' });
      return;
    }
    if (segmentsToCopy.length === 0) {
      setToast({ message: 'Please select at least one segment to copy', type: 'error' });
      return;
    }

    setLoading(true);
    try {
      const res = await apiCall(`/api/admin/users/copy-settings`, {
        method: 'POST',
        body: JSON.stringify({
          source: sourceUid.trim(),
          target: targetUid.trim(),
          segments: segmentsToCopy,
        }),
      });

      if (res.ok) {
        const msg = (res.data as any)?.message || `Successfully copied segment settings to ${targetUid}`;
        setToast({ message: msg, type: 'success' });
        setSourceUid('');
      } else {
        const errMsg = (res.data as any)?.error || 'Failed to copy settings';
        setToast({ message: errMsg, type: 'error' });
      }
    } catch (e: any) {
      setToast({ message: e.message || 'Network error copying settings', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="adm-upd-root" style={{ padding: '0 0 40px 0' }}>
      <div className="adm-upd-section-title">Copy Segment & Leverage Settings</div>
      <p style={{ color: '#8b949e', fontSize: '14px', marginBottom: 20 }}>
        Clone leverage, holding rules, brokerage buffers, and segment configurations from an existing user account to a target user.
      </p>

      <div className="adm-upd-card">
        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Source User (Copy From)</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select
                className="adm-upd-input"
                style={{ flex: 1, cursor: 'pointer' }}
                value={sourceUid}
                onChange={e => setSourceUid(e.target.value)}
              >
                <option value="">-- Select Source User --</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.full_name || u.email} ({u.role}) - {u.id.slice(0, 8)}...
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="adm-upd-field">
            <label className="adm-upd-label">Target User (Apply To)</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select
                className="adm-upd-input"
                style={{ flex: 1, cursor: 'pointer' }}
                value={targetUid}
                onChange={e => setTargetUid(e.target.value)}
              >
                <option value="">-- Select Target User --</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.full_name || u.email} ({u.role}) - {u.id.slice(0, 8)}...
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="adm-upd-section-title" style={{ marginTop: 24, fontSize: '15px' }}>
          Select Segments to Clone ({segmentsToCopy.length}/{ALL_SEGMENTS.length})
        </div>
        
        <div style={{ marginBottom: 12 }}>
          <button 
            onClick={handleSelectAll}
            style={{ 
              background: 'transparent', 
              border: '1px solid #30363d', 
              color: '#8b949e', 
              padding: '6px 12px', 
              borderRadius: '4px',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            {segmentsToCopy.length === ALL_SEGMENTS.length ? 'Deselect All' : 'Select All'}
          </button>
        </div>

        <div className="adm-cu-segments-grid">
          {ALL_SEGMENTS.map(s => (
            <label className="adm-cu-seg-item" key={s}>
              <input 
                type="checkbox" 
                className="adm-cu-checkbox" 
                checked={segmentsToCopy.includes(s)} 
                onChange={() => toggleSeg(s)} 
              />
              <span className="adm-cu-seg-label">{s}</span>
            </label>
          ))}
        </div>
      </div>

      <button 
        className="adm-btn-primary" 
        style={{ width: '100%', padding: '14px', fontSize: '0.9rem', borderRadius: 10, marginTop: 20 }} 
        disabled={loading} 
        onClick={handleCopy}
      >
        {loading ? 'Cloning Settings...' : 'Copy Segment Settings'}
      </button>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
