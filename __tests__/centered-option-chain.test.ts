import { describe, it, expect } from 'vitest';
import { getCenteredStrikeWindow } from '../app/option-chain/OptionChainTable';

describe('Option Chain Centered 11-Strike Window Engine (Strict Exchange Master Dataset)', () => {
  // Test 1 — Irregular strike dataset: Zero synthetic strikes created
  it('Test 1 — Irregular strikes: returns 100% actual strikes from dataset with zero synthetic strikes', () => {
    const irregularDataset = [
      { strike: 116000 }, { strike: 116400 }, { strike: 117000 },
      { strike: 117500 }, { strike: 118000 }, { strike: 118500 }, // ATM (index 5 in dataset)
      { strike: 119000 }, { strike: 119500 }, { strike: 120000 },
      { strike: 120500 }, { strike: 121000 }, { strike: 121500 }
    ];
    const spotPrice = 118520; // Closest to 118500

    const { centeredStrikes, atmIndex } = getCenteredStrikeWindow(irregularDataset, spotPrice);

    expect(centeredStrikes.length).toBe(11);
    expect(atmIndex).toBe(5);
    expect(centeredStrikes[5].strike).toBe(118500);

    // Assert EVERY displayed strike exists in the original dataset
    const originalStrikeVals = new Set(irregularDataset.map(s => s.strike));
    centeredStrikes.forEach(s => {
      expect(originalStrikeVals.has(s.strike)).toBe(true);
    });
  });

  // Test 2 — ATM is always row 6 (index 5) when 5 strikes above and 5 strikes below exist
  it('Test 2 — ATM is always row 6 (index 5) and window length is 11', () => {
    const rawStrikes = Array.from({ length: 30 }, (_, i) => ({ strike: 24000 + i * 50 }));
    const spotPrice = 24720; // Closest to 24700

    const { centeredStrikes, atmIndex } = getCenteredStrikeWindow(rawStrikes, spotPrice);

    expect(centeredStrikes.length).toBe(11);
    expect(atmIndex).toBe(5);
    expect(centeredStrikes[5].strike).toBe(24700);

    const sourceSet = new Set(rawStrikes.map(s => s.strike));
    centeredStrikes.forEach(s => expect(sourceSet.has(s.strike)).toBe(true));
  });

  // Test 3 — Exactly 5 strikes below ATM and 5 strikes above ATM
  it('Test 3 — Contains exactly 5 strikes below ATM and 5 strikes above ATM from actual strikes', () => {
    const rawStrikes = Array.from({ length: 30 }, (_, i) => ({ strike: 50000 + i * 100 }));
    const spotPrice = 51230; // Closest to 51200

    const { centeredStrikes } = getCenteredStrikeWindow(rawStrikes, spotPrice);
    const atmStrike = centeredStrikes[5].strike; // 51200

    const strikesBelow = centeredStrikes.slice(0, 5);
    const strikesAbove = centeredStrikes.slice(6);

    expect(strikesBelow.length).toBe(5);
    expect(strikesAbove.length).toBe(5);

    strikesBelow.forEach(s => expect(s.strike).toBeLessThan(atmStrike));
    strikesAbove.forEach(s => expect(s.strike).toBeGreaterThan(atmStrike));
  });

  // Test 4 — All supported underlyings assert source existence & 11 strikes
  it('Test 4 — NIFTY, BANKNIFTY, GOLD, SILVER, SILVERM, CRUDEOIL, NATURALGAS dataset assertions', () => {
    const testCases = [
      { name: 'NIFTY', spot: 24520, strikes: Array.from({ length: 30 }, (_, i) => ({ strike: 24000 + i * 50 })) },
      { name: 'BANKNIFTY', spot: 51230, strikes: Array.from({ length: 30 }, (_, i) => ({ strike: 50000 + i * 100 })) },
      { name: 'GOLD', spot: 118400, strikes: [116000, 116400, 117000, 117500, 118000, 118400, 119000, 119500, 120000, 120500, 121000, 121500].map(s => ({ strike: s })) },
      { name: 'SILVER', spot: 188000, strikes: [183000, 184000, 185000, 186000, 187000, 188000, 189000, 190000, 191000, 192000, 193000, 194000].map(s => ({ strike: s })) },
      { name: 'SILVERM', spot: 148000, strikes: [143000, 144000, 145000, 146000, 147000, 148000, 149000, 150000, 151000, 152000, 153000, 154000].map(s => ({ strike: s })) },
      { name: 'CRUDEOIL', spot: 3600, strikes: Array.from({ length: 30 }, (_, i) => ({ strike: 3000 + i * 50 })) },
      { name: 'NATURALGAS', spot: 65, strikes: Array.from({ length: 30 }, (_, i) => ({ strike: 40 + i * 5 })) },
    ];

    for (const tc of testCases) {
      const { centeredStrikes, atmIndex } = getCenteredStrikeWindow(tc.strikes, tc.spot);

      expect(centeredStrikes.length).toBe(11);
      expect(atmIndex).toBe(5);

      const sourceSet = new Set(tc.strikes.map(s => s.strike));
      centeredStrikes.forEach(s => {
        expect(sourceSet.has(s.strike)).toBe(true);
      });
    }
  });

  // Test 5 — Dynamic re-centering when spot price moves
  it('Test 5 — Re-centers automatically when spot price moves enough to change ATM', () => {
    const rawStrikes = Array.from({ length: 50 }, (_, i) => ({ strike: 150000 + i * 500 }));

    // Spot = 153,902 -> ATM 154,000
    const res1 = getCenteredStrikeWindow(rawStrikes, 153902);
    expect(res1.centeredStrikes.length).toBe(11);
    expect(res1.atmIndex).toBe(5);
    expect(res1.centeredStrikes[5].strike).toBe(154000);
    expect(res1.centeredStrikes[0].strike).toBe(151500);
    expect(res1.centeredStrikes[10].strike).toBe(156500);

    // Spot moves to 154,510 -> ATM 154,500
    const res2 = getCenteredStrikeWindow(rawStrikes, 154510);
    expect(res2.centeredStrikes.length).toBe(11);
    expect(res2.atmIndex).toBe(5);
    expect(res2.centeredStrikes[5].strike).toBe(154500);
    expect(res2.centeredStrikes[0].strike).toBe(152000);
    expect(res2.centeredStrikes[10].strike).toBe(157000);
  });

  // Test 6 — Expiry change dataset isolation
  it('Test 6 — Changing expiry datasets preserves 11-strike centered window invariant with actual strikes', () => {
    const expiry1Strikes = Array.from({ length: 40 }, (_, i) => ({ strike: 23500 + i * 50, expiry: '2026-08-28' }));
    const expiry2Strikes = Array.from({ length: 40 }, (_, i) => ({ strike: 23500 + i * 50, expiry: '2026-09-25' }));
    const spot = 24520; // ATM 24500

    const res1 = getCenteredStrikeWindow(expiry1Strikes, spot);
    const res2 = getCenteredStrikeWindow(expiry2Strikes, spot);

    expect(res1.centeredStrikes.length).toBe(11);
    expect(res1.centeredStrikes[5].strike).toBe(24500);

    expect(res2.centeredStrikes.length).toBe(11);
    expect(res2.centeredStrikes[5].strike).toBe(24500);

    const sourceSet1 = new Set(expiry1Strikes.map(s => s.strike));
    const sourceSet2 = new Set(expiry2Strikes.map(s => s.strike));
    res1.centeredStrikes.forEach(s => expect(sourceSet1.has(s.strike)).toBe(true));
    res2.centeredStrikes.forEach(s => expect(sourceSet2.has(s.strike)).toBe(true));
  });

  // Test 7 — SILVERM and SILVER contract isolation
  it('Test 7 — SILVERM and SILVER contracts remain isolated without cross-pollution', () => {
    const silvermStrikes = Array.from({ length: 20 }, (_, i) => ({ strike: 140000 + i * 1000, ce: { symbol: `SILVERM26AUG${140000 + i * 1000}CE` } }));
    const silverStrikes = Array.from({ length: 20 }, (_, i) => ({ strike: 180000 + i * 1000, ce: { symbol: `SILVER26AUG${180000 + i * 1000}CE` } }));

    const resSilverm = getCenteredStrikeWindow(silvermStrikes, 145000);
    const resSilver = getCenteredStrikeWindow(silverStrikes, 185000);

    expect(resSilverm.centeredStrikes[5].ce?.symbol).toContain('SILVERM');
    expect(resSilver.centeredStrikes[5].ce?.symbol).not.toContain('SILVERM');
  });

  // Test 8 — Boundary conditions and small datasets without synthetic strikes
  it('Test 8 — Boundary conditions: handles edge cases gracefully without generating synthetic strikes', () => {
    // Edge Case A: Only 2 strikes below ATM in a 15-strike dataset
    const edgeDataA = Array.from({ length: 15 }, (_, i) => ({ strike: 100 + i * 10 }));
    const spotA = 122; // ATM is 120 (index 2)

    const resA = getCenteredStrikeWindow(edgeDataA, spotA);
    expect(resA.centeredStrikes.length).toBe(11);
    expect(resA.atmIndex).toBe(2);
    expect(resA.centeredStrikes[2].strike).toBe(120);
    // Confirm zero synthetic strikes
    const setA = new Set(edgeDataA.map(s => s.strike));
    resA.centeredStrikes.forEach(s => expect(setA.has(s.strike)).toBe(true));

    // Edge Case B: Small dataset with fewer than 11 strikes (e.g. 6 strikes total)
    const edgeDataB = Array.from({ length: 6 }, (_, i) => ({ strike: 500 + i * 50 }));
    const spotB = 648; // ATM is 650 (index 3)

    const resB = getCenteredStrikeWindow(edgeDataB, spotB);
    expect(resB.centeredStrikes.length).toBe(6);
    expect(resB.atmIndex).toBe(3);
    expect(resB.centeredStrikes[3].strike).toBe(650);
    const setB = new Set(edgeDataB.map(s => s.strike));
    resB.centeredStrikes.forEach(s => expect(setB.has(s.strike)).toBe(true));
  });
});
