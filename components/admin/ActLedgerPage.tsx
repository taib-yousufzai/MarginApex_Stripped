'use client';
import React, { useState, useEffect } from 'react';
import { signOut } from '@/lib/auth';
import { api } from '@/lib/api';
import { apiCall, Toast, ToastState, ActLogItem, LOG_ROWS } from './AdminUtils';
import TransactionsPage from './TransactionsPage';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a timestamp string into a human-readable local date/time. */
function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true,
  });
}

/** Render a number or null as a formatted string (with 2 decimal places) or "—". */
function fmtNum(val: number | null | undefined): string {
  if (val === null || val === undefined) return '—';
  return val.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

/** Render a string or null as its value or "—". */
function fmtStr(val: string | null | undefined): string {
  if (val === null || val === undefined || val === '') return '—';
  return val;
}

/** Map brokerage_mode to human-readable label. */
function fmtBrokerageMode(mode: 'per_crore' | 'per_lot' | null): string {
  if (mode === 'per_crore') return 'per crore';
  if (mode === 'per_lot') return 'per lot';
  return '—';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Badge chip showing the entry type, with colour coding for ORDER_EXECUTION. */
function TypeBadge({ type }: { type: string }) {
  const isOE = type === 'ORDER_EXECUTION';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        background: isOE ? '#1a4060' : '#1c2128',
        color: isOE ? '#58a6ff' : '#8b949e',
        border: `1px solid ${isOE ? '#388bfd40' : '#30363d'}`,
        whiteSpace: 'nowrap',
      }}
    >
      {type}
    </span>
  );
}

/** Compact single-line card for non-ORDER_EXECUTION entries. */
function CompactRow({ log, onViewTransactions }: { log: ActLogItem, onViewTransactions: (id: string) => void }) {
  return (
    <div
      className="adm-al-card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        flexWrap: 'wrap',
      }}
    >
      <TypeBadge type={log.type} />
      <span style={{ color: '#8b949e', fontSize: '12px', whiteSpace: 'nowrap' }}>
        {formatTimestamp(log.time)}
      </span>
      <span style={{ color: '#e6edf3', fontSize: '12px' }}>
        <span style={{ color: '#8b949e' }}>By </span>{fmtStr(log.by)}
      </span>
      <span style={{ color: '#e6edf3', fontSize: '12px' }}>
        <span style={{ color: '#8b949e' }}>→ </span>{fmtStr(log.target)}
      </span>
      {log.target_id && (
        <button 
          className="adm-btn-ghost" 
          style={{ padding: '2px 6px', fontSize: '10px', marginLeft: 'auto' }}
          onClick={() => onViewTransactions(log.target_client_id || log.target_id!)}
          title="View Transactions"
        >
          <i className="fas fa-list" /> Txs
        </button>
      )}
    </div>
  );
}

/** Field label + value pair inside a grid. */
function GridField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <span style={{ color: '#8b949e', fontSize: '11px', fontWeight: 500 }}>{label}</span>
      <span style={{ color: '#e6edf3', fontSize: '12px' }}>{value}</span>
    </>
  );
}

/** Rich card for ORDER_EXECUTION entries. */
function OrderExecutionCard({
  log,
  onEdit,
  onViewTransactions,
}: {
  log: ActLogItem;
  onEdit: () => void;
  onViewTransactions: (id: string) => void;
}) {
  const brokerageDisplay =
    log.brokerage_value !== null
      ? `${fmtNum(log.brokerage_value)} (${fmtBrokerageMode(log.brokerage_mode)})`
      : '—';

  return (
    <div className="adm-al-card" style={{ padding: '14px 16px' }}>
      {/* ── Card header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TypeBadge type={log.type} />
          <span style={{ color: '#8b949e', fontSize: '12px' }}>{formatTimestamp(log.time)}</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {log.target_id && (
            <button
              className="adm-al-details-btn"
              onClick={() => onViewTransactions(log.target_client_id || log.target_id!)}
              style={{ fontSize: '11px', padding: '3px 10px', background: 'transparent', border: '1px solid #30363d', color: '#8b949e' }}
            >
              Txs
            </button>
          )}
          <button
            className="adm-al-details-btn"
            onClick={onEdit}
            style={{ fontSize: '11px', padding: '3px 10px' }}
          >
            Edit
          </button>
        </div>
      </div>

      {/* ── 9-field trade grid ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr max-content 1fr',
          gap: '6px 16px',
          fontSize: '12px',
        }}
      >
        <GridField label="By" value={<strong>{fmtStr(log.by)}</strong>} />
        <GridField label="Target" value={<strong>{fmtStr(log.target)}</strong>} />
        <GridField label="Time" value={formatTimestamp(log.time)} />
        <GridField label="Original Price" value={fmtNum(log.original_price)} />
        <GridField label="Qty" value={fmtNum(log.qty)} />
        <GridField label="Margin Used" value={fmtNum(log.margin_used)} />
        <GridField label="Buffer" value={fmtNum(log.buffer)} />
        <GridField label="Brokerage" value={brokerageDisplay} />
        <GridField label="Trade Mode" value={fmtStr(log.trade_mode)} />
      </div>

      {/* ── Edit audit section ── */}
      {log.edited_by !== null && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px solid #21262d',
          }}
        >
          <div
            style={{
              fontSize: '10px',
              color: '#8b949e',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            Edit Audit
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              gap: '4px 12px',
              fontSize: '12px',
            }}
          >
            <GridField label="Edited By" value={fmtStr(log.edited_by)} />
            <GridField label="Edited At" value={formatTimestamp(log.edited_at)} />
            <GridField label="Remark" value={fmtStr(log.edit_remark)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Edit form ────────────────────────────────────────────────────────────────

interface EditFormState {
  symbol: string;
  qty: string;
  price: string;
  edit_remark: string;
}

interface EditFormProps {
  log: ActLogItem;
  onSave: (id: string, form: EditFormState) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
}

function EditForm({ log, onSave, onCancel, saving }: EditFormProps) {
  const [form, setForm] = useState<EditFormState>({
    symbol: log.symbol ?? '',
    qty: log.qty !== null ? String(log.qty) : '',
    price: log.price !== null ? String(log.price) : '',
    edit_remark: '',
  });
  const [remarkError, setRemarkError] = useState('');

  const handleSubmit = async () => {
    if (!form.edit_remark.trim()) {
      setRemarkError('Edit remark is required.');
      return;
    }
    setRemarkError('');
    await onSave(log.id, form);
  };

  const inputStyle: React.CSSProperties = {
    padding: '4px 8px',
    height: '30px',
    maxWidth: '300px',
    width: '100%',
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 4,
    color: '#e6edf3',
    fontSize: '12px',
  };

  return (
    <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Symbol */}
      <div className="adm-al-exp-row">
        <span style={{ color: '#8b949e', fontSize: '12px', minWidth: 90 }}>Symbol</span>
        <input
          style={inputStyle}
          value={form.symbol}
          onChange={e => setForm({ ...form, symbol: e.target.value })}
        />
      </div>

      {/* Qty */}
      <div className="adm-al-exp-row">
        <span style={{ color: '#8b949e', fontSize: '12px', minWidth: 90 }}>Qty</span>
        <input
          style={inputStyle}
          type="number"
          value={form.qty}
          onChange={e => setForm({ ...form, qty: e.target.value })}
        />
      </div>

      {/* Price */}
      <div className="adm-al-exp-row">
        <span style={{ color: '#8b949e', fontSize: '12px', minWidth: 90 }}>Price</span>
        <input
          style={inputStyle}
          type="number"
          value={form.price}
          onChange={e => setForm({ ...form, price: e.target.value })}
        />
      </div>

      {/* Edit Remark — mandatory */}
      <div className="adm-al-exp-row" style={{ alignItems: 'flex-start' }}>
        <span style={{ color: '#8b949e', fontSize: '12px', minWidth: 90, paddingTop: 4 }}>
          Edit Remark <span style={{ color: '#f85149' }}>*</span>
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 300, width: '100%' }}>
          <textarea
            style={{
              ...inputStyle,
              height: 64,
              resize: 'vertical',
              fontFamily: 'inherit',
              borderColor: remarkError ? '#f85149' : '#30363d',
            }}
            value={form.edit_remark}
            placeholder="Reason for this edit…"
            onChange={e => {
              setForm({ ...form, edit_remark: e.target.value });
              if (e.target.value.trim()) setRemarkError('');
            }}
          />
          {remarkError && (
            <span style={{ color: '#f85149', fontSize: '11px' }}>{remarkError}</span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          className="adm-btn-primary"
          onClick={handleSubmit}
          disabled={saving}
          style={{ padding: '5px 14px', fontSize: '12px' }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="adm-sheet-cancel"
          onClick={onCancel}
          disabled={saving}
          style={{ padding: '5px 14px', fontSize: '12px' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ActLedgerPage({ selectedUser, onOpenUserPanel, isDemoMode, forcedTab }: {
  selectedUser?: { id: string; role: string; client_id?: string };
  onOpenUserPanel?: () => void;
  isDemoMode: boolean;
  forcedTab?: 'trade_logs' | 'transactions';
}) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [dlRows, setDlRows] = useState('100');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [logs, setLogs] = useState<ActLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [toast, setToast] = useState<ToastState>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<'user' | 'global'>('global');
  const [activeTab, setActiveTab] = useState<'trade_logs' | 'transactions'>(forcedTab || 'trade_logs');
  const [targetTxId, setTargetTxId] = useState<string | undefined>(undefined);

  const uid = selectedUser?.id;

  useEffect(() => {
    if (forcedTab) {
      setActiveTab(forcedTab);
      if (forcedTab === 'trade_logs') setTargetTxId(undefined);
    }
  }, [forcedTab]);

  const handleViewTransactions = (id: string) => {
    setTargetTxId(id);
    setActiveTab('transactions');
  };

  // Derive total pages from server-side total count
  const pageSize = parseInt(dlRows, 10) || LOG_ROWS;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Sync viewMode when selectedUser changes
  useEffect(() => {
    if (uid) setViewMode('user');
  }, [uid]);

  // Fetch logs whenever filters/page change
  useEffect(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (search) params.set('search', search);
    if (viewMode === 'user' && uid) params.set('user_id', uid);
    params.set('rows', String(pageSize));
    params.set('page', String(page));
    params.set('demo', String(isDemoMode));

    const query = params.toString() ? `?${params.toString()}` : '';
    apiCall(`/api/admin/actlogs${query}`, { method: 'GET' })
      .then(({ ok, status, data }) => {
        if (status === 401) { signOut(); return; }
        if (status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
        if (!ok) { setToast({ message: 'Server Error', type: 'error' }); return; }
        // API now returns { data: ActLogItem[], total: number }
        const payload = data as { data: ActLogItem[]; total: number };
        setLogs(payload.data ?? []);
        setTotal(payload.total ?? 0);
      })
      .catch((err: unknown) => {
        setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
      });
  }, [dateFrom, dateTo, search, page, pageSize, viewMode, uid]);

  const handleSaveEdit = async (id: string, form: EditFormState) => {
    setSaving(true);
    try {
      const body: Record<string, string | number | null> = {
        symbol: form.symbol || null,
        qty: form.qty !== '' ? Number(form.qty) : null,
        price: form.price !== '' ? Number(form.price) : null,
        edit_remark: form.edit_remark,
      };
      const { ok, status, data } = await apiCall(`/api/admin/actlogs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      if (ok) {
        const resp = data as { message?: string; reconciliation_id?: string };
        if (resp.reconciliation_id) {
          setToast({
            message: `Log updated and payin/payout record created (ID: ${resp.reconciliation_id})`,
            type: 'success',
          });
        } else {
          setToast({ message: 'Log updated successfully', type: 'success' });
        }
        setEditingId(null);
        // Refresh the edited log entry optimistically
        setLogs(prev =>
          prev.map(l =>
            l.id === id
              ? {
                  ...l,
                  symbol: form.symbol || null,
                  qty: form.qty !== '' ? Number(form.qty) : null,
                  price: form.price !== '' ? Number(form.price) : null,
                }
              : l,
          ),
        );
      } else {
        const errData = data as { error?: string } | null;
        if (status === 404) {
          setToast({ message: 'Log entry not found', type: 'error' });
        } else if (status === 422) {
          setToast({ message: 'Cannot edit: target user not found', type: 'error' });
        } else if (status === 500) {
          setToast({ message: 'Save failed — no changes were applied', type: 'error' });
        } else {
          setToast({ message: errData?.error || 'Update failed', type: 'error' });
        }
      }
    } catch (err: unknown) {
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleExportCsv = () => {
    const params = new URLSearchParams();
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (search) params.set('search', search);
    if (viewMode === 'user' && uid) params.set('user_id', uid);
    params.set('rows', dlRows);
    params.set('export', 'csv');
    params.set('demo', String(isDemoMode));

    api.get<Blob>(`/api/admin/actlogs?${params.toString()}`)
      .then(blob => {
        const url = URL.createObjectURL(blob as unknown as Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'actlogs.csv';
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => setToast({ message: 'Export failed', type: 'error' }));
  };

  return (
    <div className="adm-al-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* ── Header bar ── */}
      <div className="adm-ord-header" style={{ marginBottom: 20 }}>
        <div className="adm-ord-header-left" style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', width: '100%', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <h2 className="adm-page-title" style={{ margin: 0 }}>Ledger &amp; Transactions</h2>
            <div className="adm-ord-view-toggle">
              <button className={`adm-ord-vtab ${activeTab === 'trade_logs' ? 'active' : ''}`} onClick={() => setActiveTab('trade_logs')}>Trade Logs</button>
              <button className={`adm-ord-vtab ${activeTab === 'transactions' ? 'active' : ''}`} onClick={() => setActiveTab('transactions')}>Transactions</button>
            </div>
          </div>
          {activeTab === 'trade_logs' && (
            <div className="adm-ord-view-toggle">
              <button
                className={`adm-ord-vtab ${viewMode === 'user' ? 'active' : ''}`}
                onClick={() => { setViewMode('user'); setPage(1); }}
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                {uid ? `User: ${(selectedUser?.client_id || uid.slice(0, 8)).toUpperCase()}…` : 'User View'}
                {viewMode === 'user' && onOpenUserPanel && (
                  <span
                    onClick={e => { e.stopPropagation(); onOpenUserPanel(); }}
                    style={{
                      background: '#161b22', border: '1px solid #30363d', color: '#4493f8',
                      fontSize: '11px', cursor: 'pointer', padding: '2px 6px', borderRadius: '4px',
                    }}
                  >
                    Change
                  </span>
                )}
              </button>
              <button
                className={`adm-ord-vtab ${viewMode === 'global' ? 'active' : ''}`}
                onClick={() => { setViewMode('global'); setPage(1); }}
              >
                All Platform
              </button>
            </div>
          )}
        </div>
      </div>

      {activeTab === 'transactions' ? (
        <TransactionsPage isDemoMode={isDemoMode} initialSearch={targetTxId || selectedUser?.client_id || selectedUser?.id} />
      ) : (
        <>
          {/* ── Date filters ── */}
      <div className="adm-al-dates">
        <div className="adm-al-date-field">
          <label className="adm-al-label">From</label>
          <input type="date" className="adm-db-date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className="adm-al-date-field">
          <label className="adm-al-label">To</label>
          <input type="date" className="adm-db-date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
      </div>

      {/* ── Export row ── */}
      <div className="adm-al-export-row">
        <div className="adm-al-dl-wrap">
          <label className="adm-al-label">Download Rows</label>
          <div className="adm-al-dl-inner">
            <select className="adm-ord-rows-select" value={dlRows} onChange={e => { setDlRows(e.target.value); setPage(1); }}>
              {['10', '25', '50', '100'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="adm-al-export-btn" onClick={handleExportCsv}>Export CSV</button>
          </div>
        </div>
      </div>

      {/* ── Search ── */}
      <div className="adm-ord-search-wrap">
        <i className="fas fa-search adm-ord-search-icon" />
        <input
          className="adm-ord-search"
          placeholder="Search…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {/* ── Log list ── */}
      <div className="adm-al-list">
        {logs.map(log => {
          const isOE = log.type === 'ORDER_EXECUTION';
          const isEditing = editingId === log.id;

          if (!isOE) {
            return <CompactRow key={log.id} log={log} onViewTransactions={handleViewTransactions} />;
          }

          // Rich ORDER_EXECUTION card
          return (
            <div key={log.id}>
              <OrderExecutionCard
                log={log}
                onViewTransactions={handleViewTransactions}
                onEdit={() => {
                  if (isEditing) {
                    setEditingId(null);
                  } else {
                    setEditingId(log.id);
                  }
                }}
              />
              {isEditing && (
                <div
                  style={{
                    background: '#0d1117',
                    border: '1px solid #30363d',
                    borderTop: 'none',
                    borderRadius: '0 0 8px 8px',
                    padding: '12px 16px',
                    marginTop: -4,
                  }}
                >
                  <div style={{ fontSize: '11px', color: '#8b949e', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
                    Edit Log Entry
                  </div>
                  <EditForm
                    log={log}
                    onSave={handleSaveEdit}
                    onCancel={() => setEditingId(null)}
                    saving={saving}
                  />
                </div>
              )}
            </div>
          );
        })}

        {logs.length === 0 && (
          <div style={{ textAlign: 'center', color: '#8b949e', padding: '40px 0', fontSize: '13px' }}>
            No log entries found.
          </div>
        )}
      </div>

      {/* ── Pagination ── */}
      <div className="adm-pos-pagination">
        <span className="adm-pos-page-info">Page {page} of {totalPages} ({total} total)</span>
        <div className="adm-pos-page-btns">
          <button className="adm-pos-page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <button className="adm-pos-page-btn active-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      </div>

      <div style={{ height: 24 }} />
        </>
      )}
    </div>
  );
}
