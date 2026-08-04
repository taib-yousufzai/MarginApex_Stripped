'use client';

import { useState, useEffect } from 'react';
import Sidebar from '@/components/Sidebar';
import Footer from '@/components/Footer';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';
import './diagnostics.css';

interface AlertItem {
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  timestamp: string;
}

interface MetricsSummary {
  marketData: {
    ticksReceived: number;
    ticksProcessed: number;
    avgProcessingLatencyMs: number;
  };
  matchingEngine: {
    ordersEvaluated: number;
    positionsEvaluated: number;
    avgMatchingLatencyMs: number;
    avgTriggerExecutionLatencyMs: number;
  };
  webSockets: {
    activeConnections: number;
    activeSubscriptions: number;
    messagesSent: number;
    messagesReceived: number;
  };
  apis: {
    requestsTotal: number;
    errorsTotal: number;
    errorRatePercent: number;
    endpointsAvgLatencyMs: Record<string, number>;
  };
  database: {
    readsTotal: number;
    writesTotal: number;
    avgQueryLatencyMs: number;
  };
  kiteSession?: {
    valid: boolean;
    expiresAt: string | null;
    minutesUntilExpiry: number | null;
    lastSuccessfulLogin: string | null;
    lastLoginAttempt: string | null;
    lastLoginFailure: string | null;
    consecutiveFailures: number;
  };
  valkey?: {
    valkeyConnected: boolean;
    valkeyLatencyMs: number;
    pubSubConnected: boolean;
    lastReconnect: string | null;
    reconnectCount: number;
  };
  infrastructure: {
    memory: {
      heapUsedMb: number;
      heapTotalMb: number;
      rssMb: number;
    };
    cpu: {
      user: number;
      system: number;
    };
    uptime: number;
  };
  alerts: AlertItem[];
  tickerOnline?: boolean;
}

export default function DiagnosticsPage() {
  useAuth();
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function fetchMetrics() {
      try {
        const data = await api.get<MetricsSummary>('/api/admin/metrics');
        if (active) {
          setMetrics(data);
          setLoading(false);
          setError(null);
        }
      } catch (err) {
        if (active) {
          if (err instanceof ApiError) {
            if (err.status === 401) {
              setError('Unauthorized access. Redirecting...');
              setTimeout(() => {
                window.location.href = '/login';
              }, 2000);
            } else {
              const errData = err.details as Record<string, unknown> | null;
              const msg = errData
                ? String(errData.details ?? errData.error ?? err.status)
                : String(err.status);
              setError(`Failed to fetch diagnostics: ${msg}`);
            }
          } else {
            setError('Connection error');
          }
          setLoading(false);
        }
      }
    }

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 1500);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const getSystemStatus = () => {
    if (!metrics) return { label: 'OFFLINE', color: 'var(--red)' };
    if (!metrics.tickerOnline) return { label: 'TICKER OFFLINE', color: '#ff9500' };
    const criticals = metrics.alerts.filter(a => a.level === 'CRITICAL');
    const warnings = metrics.alerts.filter(a => a.level === 'WARNING');

    if (criticals.length > 0) return { label: 'CRITICAL STATE', color: '#ff4d4d' };
    if (warnings.length > 0) return { label: 'WARNING ACTIVE', color: '#ffaa00' };
    return { label: 'SYSTEM OPERATIONAL', color: '#00cc66' };
  };

  const status = getSystemStatus();

  return (
    <div className="diag-layout">
      <Sidebar />
      <main className="diag-main">
        <header className="diag-header">
          <div className="header-info">
            <h1>Engine Diagnostics</h1>
            <p className="subtitle">Real-time Trading & Infrastructure Operations Control Panel</p>
          </div>
          <div className="header-status-badge" style={{ borderColor: status.color, color: status.color }}>
            <span className="pulse-dot" style={{ backgroundColor: status.color }} />
            {status.label}
          </div>
        </header>

        {loading ? (
          <div className="diag-loading">
            <div className="spinner" />
            <p>Initializing Diagnostics Engine...</p>
          </div>
        ) : error ? (
          <div className="diag-error">
            <i className="fas fa-exclamation-triangle" />
            <p>{error}</p>
          </div>
        ) : metrics ? (
          <div className="diag-grid">
            {/* Market Data Feed */}
            <div className="diag-card">
              <div className="card-header">
                <i className="fas fa-satellite-dish" />
                <h3>Market Data Feed</h3>
              </div>
              <div className="card-body">
                <div className="metric-row">
                  <span className="metric-label">Ticks Received</span>
                  <span className="metric-value">{metrics.marketData.ticksReceived.toLocaleString()}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Ticks Processed</span>
                  <span className="metric-value">{metrics.marketData.ticksProcessed.toLocaleString()}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Batch Process Latency</span>
                  <span className="metric-value font-highlight">
                    {metrics.marketData.avgProcessingLatencyMs} ms
                  </span>
                </div>
              </div>
            </div>

            {/* Matching Engine */}
            <div className="diag-card">
              <div className="card-header">
                <i className="fas fa-microchip" />
                <h3>Matching Engine</h3>
              </div>
              <div className="card-body">
                <div className="metric-row">
                  <span className="metric-label">Orders Evaluated</span>
                  <span className="metric-value">{metrics.matchingEngine.ordersEvaluated.toLocaleString()}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Positions Checked</span>
                  <span className="metric-value">{metrics.matchingEngine.positionsEvaluated.toLocaleString()}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Match Check Duration</span>
                  <span className="metric-value font-highlight">
                    {metrics.matchingEngine.avgMatchingLatencyMs} ms
                  </span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Trigger Execution Latency</span>
                  <span className="metric-value font-highlight">
                    {metrics.matchingEngine.avgTriggerExecutionLatencyMs} ms
                  </span>
                </div>
              </div>
            </div>

            {/* WebSocket Gateway */}
            <div className="diag-card">
              <div className="card-header">
                <i className="fas fa-network-wired" />
                <h3>WebSocket Gateway</h3>
              </div>
              <div className="card-body">
                <div className="metric-row">
                  <span className="metric-label">Active Connections</span>
                  <span className="metric-value">{metrics.webSockets.activeConnections}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Active Subscriptions</span>
                  <span className="metric-value">{metrics.webSockets.activeSubscriptions}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Broadcasting Out (Sent)</span>
                  <span className="metric-value">{metrics.webSockets.messagesSent.toLocaleString()}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Messages Inbound</span>
                  <span className="metric-value">{metrics.webSockets.messagesReceived.toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* Database layer */}
            <div className="diag-card">
              <div className="card-header">
                <i className="fas fa-database" />
                <h3>Database Engine</h3>
              </div>
              <div className="card-body">
                <div className="metric-row">
                  <span className="metric-label">DB Reads</span>
                  <span className="metric-value">{metrics.database.readsTotal}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">DB Writes</span>
                  <span className="metric-value">{metrics.database.writesTotal}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Average Query Latency</span>
                  <span className="metric-value font-highlight">
                    {metrics.database.avgQueryLatencyMs} ms
                  </span>
                </div>
              </div>
            </div>

            {/* Kite Session Monitor */}
            {metrics.kiteSession && (
              <div className="diag-card">
                <div className="card-header">
                  <i className="fas fa-key" />
                  <h3>Kite Session</h3>
                  <span
                    className="badge"
                    style={{
                      marginLeft: 'auto',
                      padding: '2px 10px',
                      borderRadius: '999px',
                      fontSize: '11px',
                      fontWeight: 700,
                      background: metrics.kiteSession.valid ? '#00cc6622' : '#ff4d4d22',
                      color: metrics.kiteSession.valid ? '#00cc66' : '#ff4d4d',
                      border: `1px solid ${metrics.kiteSession.valid ? '#00cc66' : '#ff4d4d'}`,
                    }}
                  >
                    {metrics.kiteSession.valid ? 'ACTIVE' : 'EXPIRED'}
                  </span>
                </div>
                <div className="card-body">
                  <div className="metric-row">
                    <span className="metric-label">Expires At (UTC)</span>
                    <span className="metric-value" style={{ fontSize: '12px' }}>
                      {metrics.kiteSession.expiresAt
                        ? new Date(metrics.kiteSession.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">Minutes Until Expiry</span>
                    <span
                      className="metric-value font-highlight"
                      style={{
                        color:
                          (metrics.kiteSession.minutesUntilExpiry ?? 999) <= 0 ? '#ff4d4d'
                          : (metrics.kiteSession.minutesUntilExpiry ?? 999) <= 60 ? '#ffaa00'
                          : '#00cc66',
                      }}
                    >
                      {metrics.kiteSession.minutesUntilExpiry ?? '—'} min
                    </span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">Last Successful Login</span>
                    <span className="metric-value" style={{ fontSize: '11px' }}>
                      {metrics.kiteSession.lastSuccessfulLogin
                        ? new Date(metrics.kiteSession.lastSuccessfulLogin).toLocaleTimeString()
                        : 'Never (this session)'}
                    </span>
                  </div>
                  {metrics.kiteSession.consecutiveFailures > 0 && (
                    <div className="metric-row">
                      <span className="metric-label" style={{ color: '#ff4d4d' }}>Login Failures</span>
                      <span className="metric-value" style={{ color: '#ff4d4d' }}>
                        {metrics.kiteSession.consecutiveFailures}× consecutive
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Valkey Monitor */}
            {metrics.valkey && (
              <div className="diag-card">
                <div className="card-header">
                  <i className="fas fa-database" />
                  <h3>Valkey Status</h3>
                  <span
                    className="badge"
                    style={{
                      marginLeft: 'auto',
                      padding: '2px 10px',
                      borderRadius: '999px',
                      fontSize: '11px',
                      fontWeight: 700,
                      background: metrics.valkey.valkeyConnected ? '#00cc6622' : '#ff4d4d22',
                      color: metrics.valkey.valkeyConnected ? '#00cc66' : '#ff4d4d',
                      border: `1px solid ${metrics.valkey.valkeyConnected ? '#00cc66' : '#ff4d4d'}`,
                    }}
                  >
                    {metrics.valkey.valkeyConnected ? 'CONNECTED' : 'DISCONNECTED'}
                  </span>
                </div>
                <div className="card-body">
                  <div className="metric-row">
                    <span className="metric-label">Valkey Latency</span>
                    <span className="metric-value font-highlight">
                      {metrics.valkey.valkeyConnected ? `${metrics.valkey.valkeyLatencyMs} ms` : '—'}
                    </span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">Pub/Sub Status</span>
                    <span
                      className="metric-value font-highlight"
                      style={{
                        color: metrics.valkey.pubSubConnected ? '#00cc66' : '#ff4d4d',
                      }}
                    >
                      {metrics.valkey.pubSubConnected ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">Reconnections</span>
                    <span className="metric-value">{metrics.valkey.reconnectCount}</span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">Last Reconnect</span>
                    <span className="metric-value" style={{ fontSize: '11px' }}>
                      {metrics.valkey.lastReconnect
                        ? new Date(metrics.valkey.lastReconnect).toLocaleTimeString()
                        : 'Never'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Infrastructure */}
            <div className="diag-card diag-card--span-2">
              <div className="card-header">
                <i className="fas fa-server" />
                <h3>Infrastructure & Uptime</h3>
              </div>
              <div className="card-body grid-2col">
                <div>
                  <div className="metric-row">
                    <span className="metric-label">Process Memory RSS</span>
                    <span className="metric-value">{metrics.infrastructure.memory.rssMb} MB</span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label">Heap Used</span>
                    <span className="metric-value">{metrics.infrastructure.memory.heapUsedMb} / {metrics.infrastructure.memory.heapTotalMb} MB</span>
                  </div>
                </div>
                <div>
                  <div className="metric-row">
                    <span className="metric-label">CPU User Mode</span>
                    <span className="metric-value">{(metrics.infrastructure.cpu.user / 1000000).toFixed(1)}s</span>
                  </div>
                  <div className="metric-row">
                    <span className="metric-label font-highlight">Uptime</span>
                    <span className="metric-value">
                      {Math.floor(metrics.infrastructure.uptime / 60)}m {Math.floor(metrics.infrastructure.uptime % 60)}s
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Alerts Pane */}
            <div className="diag-card diag-card--span-all diag-card--alert-pane">
              <div className="card-header">
                <i className="fas fa-bell" />
                <h3>Diagnostics Event Log & Alert Feed</h3>
              </div>
              <div className="card-body alerts-container">
                {metrics.alerts.length === 0 ? (
                  <div className="no-alerts">
                    <i className="fas fa-check-circle" style={{ color: '#00cc66' }} />
                    No system warnings active. Operations optimal.
                  </div>
                ) : (
                  <div className="alerts-list">
                    {metrics.alerts.map((alert, idx) => (
                      <div key={idx} className={`alert-row alert-${alert.level.toLowerCase()}`}>
                        <span className={`alert-level-badge level-${alert.level.toLowerCase()}`}>
                          {alert.level}
                        </span>
                        <span className="alert-message">{alert.message}</span>
                        <span className="alert-time">
                          {new Date(alert.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}
        <Footer activeTab="profile" />
      </main>
    </div>
  );
}
