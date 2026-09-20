'use client';
import React, { useState, useEffect } from 'react';
import { apiCall, Toast, ToastState } from './AdminUtils';
import AnimatedLoader from '@/components/AnimatedLoader';

export interface TelegramBotItem {
  id: string;
  name?: string;
  token: string;
  chatId: string;
  active: boolean;
  notifyOnTrade?: boolean;
  notifyOnLiquidation?: boolean;
}

export default function TelegramPage() {
  const [bots, setBots] = useState<TelegramBotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [botName, setBotName] = useState('');
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [active, setActive] = useState(true);
  const [notifyTrade, setNotifyTrade] = useState(true);
  const [notifyLiq, setNotifyLiq] = useState(true);
  const [toast, setToast] = useState<ToastState>(null);

  // Load configured bots on mount
  useEffect(() => {
    fetchBots();
  }, []);

  const fetchBots = async () => {
    setLoading(true);
    try {
      const res = await apiCall('/api/admin/telegram', { method: 'GET' });
      if (res.ok && res.data) {
        const loadedBots = (res.data as any).bots || [];
        setBots(loadedBots);
      }
    } catch (e: any) {
      setToast({ message: 'Failed to load Telegram bots', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAll = async (updatedList: TelegramBotItem[]) => {
    setSaving(true);
    try {
      const res = await apiCall('/api/admin/telegram', {
        method: 'POST',
        body: JSON.stringify({ bots: updatedList }),
      });
      if (res.ok) {
        setBots(updatedList);
        setToast({ message: 'Telegram configuration saved successfully!', type: 'success' });
      } else {
        setToast({ message: (res.data as any)?.error || 'Failed to save configuration', type: 'error' });
      }
    } catch (e: any) {
      setToast({ message: 'Error saving Telegram bots', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = () => {
    if (!token.trim()) {
      setToast({ message: 'Please enter a Bot Token', type: 'error' });
      return;
    }
    if (!chatId.trim()) {
      setToast({ message: 'Please enter a Chat ID', type: 'error' });
      return;
    }

    const newBot: TelegramBotItem = {
      id: `bot_${Date.now()}`,
      name: botName.trim() || `Bot ${bots.length + 1}`,
      token: token.trim(),
      chatId: chatId.trim(),
      active,
      notifyOnTrade: notifyTrade,
      notifyOnLiquidation: notifyLiq,
    };

    const updated = [...bots, newBot];
    handleSaveAll(updated);
    handleClose();
  };

  const handleDelete = (id: string) => {
    const updated = bots.filter(b => b.id !== id);
    handleSaveAll(updated);
  };

  const handleToggle = (id: string) => {
    const updated = bots.map(b => b.id === id ? { ...b, active: !b.active } : b);
    handleSaveAll(updated);
  };

  const handleTestAlert = async (bot: TelegramBotItem) => {
    setTestingId(bot.id);
    try {
      const res = await apiCall('/api/admin/telegram', {
        method: 'POST',
        body: JSON.stringify({
          action: 'test',
          token: bot.token,
          chatId: bot.chatId,
        }),
      });
      if (res.ok) {
        setToast({ message: '✅ Test alert sent successfully to Telegram!', type: 'success' });
      } else {
        setToast({ message: `❌ Failed: ${(res.data as any)?.error || 'Telegram error'}`, type: 'error' });
      }
    } catch (e: any) {
      setToast({ message: 'Error sending test message', type: 'error' });
    } finally {
      setTestingId(null);
    }
  };

  const handleClose = () => {
    setBotName('');
    setToken('');
    setChatId('');
    setActive(true);
    setNotifyTrade(true);
    setNotifyLiq(true);
    setShowModal(false);
  };

  return (
    <div className="adm-page">
      <h2 className="adm-page-title">Telegram Alerts & Bots</h2>

      <div className="adm-card">
        <div className="adm-card-header">
          <div>
            <div className="adm-card-title">Telegram Bot Integration</div>
            <div className="adm-card-sub">Send automated trade execution and margin liquidation alerts to Telegram channels/groups.</div>
          </div>
          <button className="adm-btn-primary" onClick={() => setShowModal(true)}>
            <i className="fas fa-plus" style={{ marginRight: '6px' }} /> Add Bot
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '32px', textAlign: 'center' }}>
            <AnimatedLoader size="medium" />
          </div>
        ) : bots.length === 0 ? (
          <div className="adm-dashed-box" style={{ padding: '32px', textAlign: 'center', color: '#8b949e' }}>
            <i className="fab fa-telegram" style={{ fontSize: '2.5rem', color: '#2AABEE', marginBottom: '12px', display: 'block' }} />
            No Telegram bot configured. Click <strong>Add Bot</strong> above to connect your first bot.
          </div>
        ) : (
          <div className="adm-bot-list">
            {bots.map((b) => (
              <div className="adm-bot-row" key={b.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', borderBottom: '1px solid #30363d', background: '#161b22', borderRadius: '8px', marginBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <i className="fab fa-telegram" style={{ color: '#2AABEE', fontSize: '1.8rem' }} />
                  <div className="adm-bot-info">
                    <div className="adm-bot-name" style={{ fontWeight: 600, color: '#e6edf3', fontSize: '14px' }}>
                      {b.name || 'Telegram Bot'}
                    </div>
                    <div className="adm-bot-token" style={{ color: '#8b949e', fontSize: '12px', fontFamily: 'monospace', marginTop: '2px' }}>
                      Token: {b.token.slice(0, 10)}...{b.token.slice(-4)} · Chat ID: {b.chatId}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                      <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: b.active ? 'rgba(35, 134, 54, 0.2)' : 'rgba(110, 118, 129, 0.2)', color: b.active ? '#3fb950' : '#8b949e' }}>
                        {b.active ? '● Active' : '○ Inactive'}
                      </span>
                      {b.notifyOnTrade && (
                        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'rgba(56, 139, 253, 0.15)', color: '#58a6ff' }}>
                          Trades
                        </span>
                      )}
                      {b.notifyOnLiquidation && (
                        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'rgba(218, 54, 51, 0.15)', color: '#f85149' }}>
                          Liquidation
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    className="adm-btn-secondary"
                    style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', cursor: 'pointer' }}
                    onClick={() => handleToggle(b.id)}
                    disabled={saving}
                  >
                    {b.active ? 'Pause' : 'Activate'}
                  </button>
                  <button
                    className="adm-btn-primary"
                    style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '6px', background: '#1f6feb', color: '#fff', cursor: 'pointer' }}
                    onClick={() => handleTestAlert(b)}
                    disabled={testingId === b.id}
                  >
                    {testingId === b.id ? <AnimatedLoader size="small" /> : <><i className="fas fa-paper-plane" style={{ marginRight: '4px' }} /> Test Alert</>}
                  </button>
                  <button
                    className="adm-btn-danger"
                    style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '6px', background: 'rgba(218, 54, 51, 0.15)', color: '#f85149', border: '1px solid rgba(218, 54, 51, 0.3)', cursor: 'pointer' }}
                    onClick={() => handleDelete(b.id)}
                    disabled={saving}
                  >
                    <i className="fas fa-trash" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Bot Bottom Sheet Modal */}
      {showModal && (
        <div className="adm-sheet-overlay" onClick={handleClose}>
          <div className="adm-bottom-sheet" onClick={e => e.stopPropagation()}>
            <div className="adm-sheet-title">Connect Telegram Bot</div>
            <div className="adm-sheet-sub">Add your Telegram Bot token from @BotFather and channel/group Chat ID.</div>
            <div className="adm-sheet-divider" />

            <div className="adm-sheet-field">
              <label className="adm-sheet-label">Bot Label / Name</label>
              <input
                className="adm-sheet-input"
                placeholder="e.g. VIP Trade Alerts"
                value={botName}
                onChange={e => setBotName(e.target.value)}
              />
            </div>

            <div className="adm-sheet-field">
              <label className="adm-sheet-label">Bot Token (from @BotFather)</label>
              <input
                className="adm-sheet-input"
                placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ..."
                value={token}
                onChange={e => setToken(e.target.value)}
              />
            </div>

            <div className="adm-sheet-field">
              <label className="adm-sheet-label">Chat ID or Channel ID</label>
              <input
                className="adm-sheet-input"
                placeholder="e.g. -1001234567890 or @yourchannel"
                value={chatId}
                onChange={e => setChatId(e.target.value)}
              />
            </div>

            <div className="adm-sheet-field" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="adm-sheet-label" style={{ marginBottom: 0 }}>Notify on Trade Executions</label>
              <input
                type="checkbox"
                checked={notifyTrade}
                onChange={e => setNotifyTrade(e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
            </div>

            <div className="adm-sheet-field" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="adm-sheet-label" style={{ marginBottom: 0 }}>Notify on Margin Liquidation</label>
              <input
                type="checkbox"
                checked={notifyLiq}
                onChange={e => setNotifyLiq(e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
            </div>

            <div className="adm-sheet-divider" />
            <div className="adm-sheet-actions">
              <button className="adm-sheet-cancel" onClick={handleClose}>Cancel</button>
              <button className="adm-btn-primary" onClick={handleAdd} disabled={saving}>
                {saving ? 'Saving...' : 'Connect Bot'}
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
