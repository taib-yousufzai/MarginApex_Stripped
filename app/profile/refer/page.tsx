'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/auth';
import './page.css';

interface ReferralEarning {
  id: string;
  deposit_amount: number;
  commission_amount: number;
  created_at: string;
  referred_user: { full_name: string } | null;
}

export default function ReferAndEarnPage() {
  const router = useRouter();
  const [balance, setBalance] = useState<number>(0);
  const [referralCode, setReferralCode] = useState<string>('');
  const [earnings, setEarnings] = useState<ReferralEarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const s = await getSession();
      if (!s) {
        router.push('/login');
        return;
      }
      const res = await fetch('/api/referral/info', {
        headers: { Authorization: `Bearer ${s.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setBalance(data.balance || 0);
        setReferralCode(data.code || '');
        setEarnings(data.earnings || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleClaim = async () => {
    if (balance <= 0) return;
    setClaiming(true);
    setClaimMsg(null);
    try {
      const s = await getSession();
      if (!s) return;
      const res = await fetch('/api/referral/claim', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to claim');
      
      setClaimMsg({ type: 'success', text: `Successfully claimed ₹${data.claimed_amount.toLocaleString('en-IN')}` });
      setBalance(0);
    } catch (e: any) {
      setClaimMsg({ type: 'error', text: e.message || 'Error claiming balance' });
    } finally {
      setClaiming(false);
    }
  };

  const handleCopy = () => {
    if (!referralCode) return;
    const url = `${window.location.origin}/register?ref=${referralCode}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const referralUrl = referralCode ? `${window.location.origin}/register?ref=${referralCode}` : '';

  return (
    <div className="desktop-layout">
            <main className="main-viewport">
        <div className="mobile-app refer-root">
          <div className="refer-header">
            <Link href="/profile" className="back-btn">
              <i className="fas fa-arrow-left"></i>
            </Link>
            <h1>Refer &amp; Earn</h1>
          </div>

          <div className="main-content padding-bottom">
            {loading ? (
              <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.5 }}>Loading...</div>
            ) : (
              <>
                <div className="refer-balance-card">
                  <div className="bal-label">Referral Wallet Balance</div>
                  <div className="bal-amount">
                    ₹{balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </div>
                  <button 
                    className="claim-btn" 
                    onClick={handleClaim}
                    disabled={claiming || balance <= 0}
                  >
                    {claiming ? 'Processing...' : 'Transfer to Main Wallet'}
                  </button>
                  {claimMsg && (
                    <div className={`claim-msg ${claimMsg.type}`}>
                      {claimMsg.text}
                    </div>
                  )}
                </div>

                <div className="refer-link-section">
                  <h3>Your Referral Link</h3>
                  <p>Share this link with your friends. When they sign up and deposit, you'll earn 5% of their deposit!</p>
                  
                  <div className="link-box">
                    <input type="text" readOnly value={referralUrl} />
                    <button onClick={handleCopy} className="copy-btn">
                      {copied ? <i className="fas fa-check"></i> : <i className="far fa-copy"></i>}
                    </button>
                  </div>
                </div>

                <div className="refer-history-section">
                  <h3>Earnings History</h3>
                  {earnings.length === 0 ? (
                    <div className="no-earnings">
                      <i className="fas fa-history" style={{ fontSize: '2rem', opacity: 0.3, marginBottom: '10px' }}></i>
                      <p>No referral earnings yet. Start sharing your link!</p>
                    </div>
                  ) : (
                    <div className="earnings-list">
                      {earnings.map((e) => (
                        <div key={e.id} className="earning-item">
                          <div className="earning-info">
                            <div className="earning-user">
                              {e.referred_user?.full_name || 'Unknown User'}
                            </div>
                            <div className="earning-date">
                              {new Date(e.created_at).toLocaleDateString('en-IN', { 
                                day: 'numeric', month: 'short', year: 'numeric', 
                                hour: '2-digit', minute: '2-digit' 
                              })}
                            </div>
                          </div>
                          <div className="earning-amounts">
                            <div className="commission-amt">+₹{e.commission_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                            <div className="deposit-amt">Deposit: ₹{e.deposit_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
