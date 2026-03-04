"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

function safeFloat(v, d = 0) {
  if (v == null || v === "") return d;
  const n = parseFloat(v);
  return isNaN(n) ? d : n;
}

function safe(item, ...keys) {
  for (const k of keys) {
    const v = item[k];
    if (v != null && v !== "" && v !== "[]") return v;
  }
  return null;
}

function extractTokens(item) {
  const tokens = item.tokens || [];
  if (Array.isArray(tokens) && tokens.length) {
    let yes_id = "", no_id = "";
    for (const t of tokens) {
      if (typeof t === "object") {
        const out = String(t.outcome || "").toUpperCase();
        const tid = t.token_id || t.tokenId || "";
        if (out === "YES" || (!yes_id && out !== "NO")) yes_id = tid;
        if (out === "NO") no_id = tid;
      }
    }
    return [yes_id, no_id];
  }
  const clob = item.clobTokenIds || [];
  if (Array.isArray(clob) && clob.length) return [clob[0] || "", clob[1] || ""];
  return [item.token_id || item.tokenId || item.condition_id || item.id || "", ""];
}

function extractPrices(item) {
  let bb = safeFloat(safe(item, "bestBid", "best_bid"));
  let ba = safeFloat(safe(item, "bestAsk", "best_ask"));
  let last = 0;
  const op = item.outcomePrices;
  if (typeof op === "string" && op.startsWith("[")) {
    try { const arr = JSON.parse(op); last = safeFloat(arr[0]); } catch {}
  } else if (Array.isArray(op) && op.length) {
    last = safeFloat(op[0]);
  } else {
    last = safeFloat(safe(item, "lastTradePrice", "last_price", "price"));
  }
  return [bb, ba, last];
}

function normalizeMarket(item) {
  const [yid, nid] = extractTokens(item);
  const [bb, ba, last] = extractPrices(item);
  const spread = bb > 0 && ba > 0 && ba > bb ? +(ba - bb).toFixed(4) : 0;
  const mid = bb > 0 && ba > 0 ? +((ba + bb) / 2).toFixed(4) : last;
  const vol = safeFloat(safe(item, "volume24hr", "volume24h", "volume", "dailyVolume", "volumeNum"));
  const liq = safeFloat(safe(item, "liquidity", "totalLiquidity", "liquidityNum"));
  return {
    question: String(safe(item, "question", "title", "description") || "?").slice(0, 100),
    token_yes: yid, token_no: nid,
    condition_id: String(safe(item, "condition_id", "conditionId", "id") || ""),
    bb, ba, last, spread,
    spread_pct: mid > 0 && spread > 0 ? +(spread / mid * 100).toFixed(2) : 0,
    mid, vol, liq,
    end_date: String(safe(item, "endDate", "end_date_iso", "expirationDate") || ""),
    category: String(safe(item, "groupSlug", "group_slug", "category", "eventSlug") || ""),
    slug: String(safe(item, "slug", "market_slug") || ""),
    active: item.active !== false && item.closed !== true && item.accepting_orders !== false,
  };
}

function scoreForMM(m) {
  let s = 0;
  if (m.spread >= 0.02 && m.spread <= 0.15) s += 30;
  else if (m.spread >= 0.01) s += 15;
  else if (m.spread > 0.15) s += 10;
  if (m.vol > 100000) s += 30;
  else if (m.vol > 50000) s += 25;
  else if (m.vol > 10000) s += 15;
  else if (m.vol > 1000) s += 5;
  if (m.mid >= 0.25 && m.mid <= 0.75) s += 20;
  else if (m.mid >= 0.15 && m.mid <= 0.85) s += 10;
  if (m.liq > 50000) s += 15;
  else if (m.liq > 10000) s += 10;
  else if (m.liq > 1000) s += 5;
  return s;
}

function detectArbs(markets) {
  return markets.filter(m => {
    if (m.ba <= 0 || m.bb <= 0) return false;
    const cost = m.ba + (1 - m.bb);
    return cost < 0.995;
  }).map(m => ({ ...m, arb_edge: +(1 - m.ba - (1 - m.bb)).toFixed(4) }))
    .sort((a, b) => b.arb_edge - a.arb_edge);
}

function downloadCSV(markets, filename) {
  const cols = ["mm_score","question","token_yes","token_no","condition_id","bb","ba","mid","spread","spread_pct","vol","liq","last","end_date","category","slug"];
  const header = cols.join(",");
  const rows = markets.map(m =>
    cols.map(c => {
      let v = m[c] ?? "";
      if (typeof v === "string" && (v.includes(",") || v.includes('"')))
        v = `"${v.replace(/"/g, '""')}"`;
      return v;
    }).join(",")
  );
  const blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Styles ──
const bg = "#0d1117", card = "#161b22", border = "#21262d", text1 = "#e6edf3", text2 = "#8b949e";
const green = "#3fb950", red = "#f85149", blue = "#58a6ff", purple = "#bc8cff", yellow = "#d29922";

export default function Page() {
  const [markets, setMarkets] = useState([]);
  const [arbs, setArbs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("mm");
  const [sort, setSort] = useState("mm_score");
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState("");
  const [minVol, setMinVol] = useState(0);
  const [minSpread, setMinSpread] = useState(0);
  const [priceRange, setPriceRange] = useState([0, 1]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [stats, setStats] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [showConfig, setShowConfig] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichCount, setEnrichCount] = useState(0);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [evResp, mkResp] = await Promise.allSettled([
        fetch(`${GAMMA_API}/events?closed=false&limit=200&active=true`).then(r => r.json()),
        fetch(`${GAMMA_API}/markets?closed=false&limit=200&active=true`).then(r => r.json()),
      ]);

      let raw = [];
      // Events → extract markets
      if (evResp.status === "fulfilled") {
        const evData = Array.isArray(evResp.value) ? evResp.value : (evResp.value?.data || []);
        for (const ev of evData) {
          const mkts = ev.markets || [];
          for (const m of mkts) {
            if (typeof m === "object") {
              m.groupSlug = m.groupSlug || ev.slug || "";
              raw.push(m);
            }
          }
        }
      }
      // Direct markets
      if (mkResp.status === "fulfilled") {
        const mkData = Array.isArray(mkResp.value) ? mkResp.value : (mkResp.value?.data || []);
        raw.push(...mkData);
      }

      // Dedupe
      const seen = new Set();
      const unique = [];
      for (const item of raw) {
        const cid = String(safe(item, "condition_id", "conditionId", "id") || Math.random());
        if (!seen.has(cid)) { seen.add(cid); unique.push(item); }
      }

      // Normalize + score
      let normalized = unique.map(normalizeMarket).filter(m => m.active && m.token_yes);
      normalized.forEach(m => { m.mm_score = scoreForMM(m); });
      normalized.sort((a, b) => b.mm_score - a.mm_score);

      setMarkets(normalized);
      setArbs(detectArbs(normalized));
      setLastUpdate(new Date());
      setStats({
        total: normalized.length,
        withSpread: normalized.filter(m => m.spread > 0).length,
        avgSpread: normalized.filter(m => m.spread > 0).length > 0
          ? (normalized.filter(m => m.spread > 0).reduce((a, m) => a + m.spread, 0) / normalized.filter(m => m.spread > 0).length)
          : 0,
        totalVol: normalized.reduce((a, m) => a + m.vol, 0),
        totalLiq: normalized.reduce((a, m) => a + m.liq, 0),
      });
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }, []);

  const enrichBooks = useCallback(async () => {
    if (enriching || markets.length === 0) return;
    setEnriching(true);
    setEnrichCount(0);
    const top = markets.slice(0, 25);
    let count = 0;
    const updated = [...markets];
    for (const m of top) {
      if (!m.token_yes || m.token_yes.length < 10) continue;
      try {
        const r = await fetch(`${CLOB_API}/book?token_id=${m.token_yes}`);
        if (r.ok) {
          const book = await r.json();
          const bids = book.bids || [];
          const asks = book.asks || [];
          if (bids.length && asks.length) {
            const bestB = Math.max(...bids.map(b => safeFloat(b.price || b.p)));
            const bestA = Math.min(...asks.map(a => safeFloat(a.price || a.p)));
            if (bestB > 0 && bestA > 0) {
              const idx = updated.findIndex(x => x.token_yes === m.token_yes);
              if (idx >= 0) {
                updated[idx] = {
                  ...updated[idx],
                  bb: bestB, ba: bestA,
                  spread: +(bestA - bestB).toFixed(4),
                  mid: +((bestA + bestB) / 2).toFixed(4),
                  spread_pct: +((bestA - bestB) / ((bestA + bestB) / 2) * 100).toFixed(2),
                  book_bid_depth: bids.reduce((a, b) => a + safeFloat(b.size || b.s), 0),
                  book_ask_depth: asks.reduce((a, b) => a + safeFloat(a.size || a.s), 0),
                };
                updated[idx].mm_score = scoreForMM(updated[idx]);
                count++;
              }
            }
          }
        }
      } catch {}
      setEnrichCount(c => c + 1);
      await new Promise(r => setTimeout(r, 300));
    }
    updated.sort((a, b) => b.mm_score - a.mm_score);
    setMarkets(updated);
    setArbs(detectArbs(updated));
    setEnriching(false);
  }, [markets, enriching]);

  useEffect(() => { fetchAll(); }, []);

  // Filter + sort
  const filtered = markets.filter(m => {
    if (filter && !m.question.toLowerCase().includes(filter.toLowerCase()) &&
        !m.category.toLowerCase().includes(filter.toLowerCase())) return false;
    if (m.vol < minVol) return false;
    if (m.spread < minSpread) return false;
    if (m.mid < priceRange[0] || m.mid > priceRange[1]) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const va = a[sort] ?? 0, vb = b[sort] ?? 0;
    return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  const toggleSort = (col) => {
    if (sort === col) setSortAsc(!sortAsc);
    else { setSort(col); setSortAsc(false); }
  };

  const toggleSelect = (tid) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(tid) ? n.delete(tid) : n.add(tid);
      return n;
    });
  };

  const selectedMarkets = markets.filter(m => selected.has(m.token_yes));

  const configYaml = selectedMarkets.length > 0
    ? "markets:\n" + selectedMarkets.map(m =>
        `  - market_id: "${m.token_yes}"\n    # ${m.question.slice(0, 70)}\n    # score=${m.mm_score} spread=${m.spread.toFixed(3)} vol=$${m.vol.toLocaleString()}`
      ).join("\n\n")
    : "# Selecione mercados na tabela clicando no checkbox";

  const SortIcon = ({ col }) => sort === col ? (sortAsc ? " ↑" : " ↓") : "";

  const Th = ({ col, label, w }) => (
    <th onClick={() => toggleSort(col)} style={{ padding: "8px 6px", textAlign: "left", cursor: "pointer", color: sort === col ? blue : text2, fontWeight: 500, fontSize: 11, width: w, whiteSpace: "nowrap", borderBottom: `1px solid ${border}`, userSelect: "none" }}>
      {label}<SortIcon col={col} />
    </th>
  );

  return (
    <div style={{ background: bg, color: text1, minHeight: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, monospace", fontSize: 13 }}>
      {/* Header */}
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            <span style={{ color: blue }}>◆</span> Polymarket Scanner
          </h1>
          <div style={{ fontSize: 11, color: text2, marginTop: 2 }}>
            {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : ""} · {stats.total || 0} markets
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={enrichBooks} disabled={enriching || loading}
            style={{ padding: "6px 12px", background: enriching ? border : "#1f2937", border: `1px solid ${border}`, borderRadius: 6, color: enriching ? text2 : purple, cursor: "pointer", fontSize: 11 }}>
            {enriching ? `Orderbooks ${enrichCount}/25...` : "📊 Fetch Orderbooks"}
          </button>
          <button onClick={fetchAll} disabled={loading}
            style={{ padding: "6px 12px", background: loading ? border : "#238636", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
            {loading ? "Loading..." : "⟳ Refresh"}
          </button>
        </div>
      </div>

      {error && <div style={{ padding: "12px 20px", background: "#2d1b1e", color: red, fontSize: 12 }}>{error}</div>}

      {/* Stats bar */}
      <div style={{ padding: "10px 20px", display: "flex", gap: 20, borderBottom: `1px solid ${border}`, flexWrap: "wrap" }}>
        {[
          ["Markets", stats.total],
          ["With Spread", stats.withSpread],
          ["Avg Spread", stats.avgSpread ? `${(stats.avgSpread * 100).toFixed(1)}¢` : "?"],
          ["24h Volume", stats.totalVol ? `$${(stats.totalVol / 1e6).toFixed(1)}M` : "?"],
          ["Liquidity", stats.totalLiq ? `$${(stats.totalLiq / 1e6).toFixed(1)}M` : "?"],
          ["Arb Opps", arbs.length],
          ["Selected", selected.size],
        ].map(([l, v]) => (
          <div key={l} style={{ fontSize: 11 }}>
            <span style={{ color: text2 }}>{l}: </span>
            <span style={{ fontWeight: 600, color: l === "Arb Opps" && v > 0 ? yellow : text1 }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Tabs + Filters */}
      <div style={{ padding: "10px 20px", display: "flex", gap: 8, alignItems: "center", borderBottom: `1px solid ${border}`, flexWrap: "wrap" }}>
        {[["mm", "🎯 MM Ranking"], ["arb", `⚡ Arb (${arbs.length})`], ["config", "⚙ Config"]].map(([t, l]) => (
          <button key={t} onClick={() => { setTab(t); if (t === "config") setShowConfig(true); }}
            style={{ padding: "5px 12px", background: tab === t ? "#30363d" : "transparent", border: `1px solid ${tab === t ? "#484f58" : border}`, borderRadius: 6, color: tab === t ? text1 : text2, cursor: "pointer", fontSize: 11 }}>
            {l}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search..." style={{ padding: "5px 10px", background: card, border: `1px solid ${border}`, borderRadius: 6, color: text1, fontSize: 11, width: 160 }} />
        <select value={minVol} onChange={e => setMinVol(+e.target.value)} style={{ padding: "5px 8px", background: card, border: `1px solid ${border}`, borderRadius: 6, color: text1, fontSize: 11 }}>
          <option value={0}>Any Volume</option>
          <option value={1000}>Vol &gt; $1k</option>
          <option value={10000}>Vol &gt; $10k</option>
          <option value={50000}>Vol &gt; $50k</option>
          <option value={100000}>Vol &gt; $100k</option>
        </select>
        <button onClick={() => downloadCSV(sorted, "polymarket_markets.csv")}
          style={{ padding: "5px 10px", background: card, border: `1px solid ${border}`, borderRadius: 6, color: green, cursor: "pointer", fontSize: 11 }}>
          ⬇ CSV
        </button>
        <button onClick={() => downloadCSV(selectedMarkets, "polymarket_selected.csv")} disabled={!selected.size}
          style={{ padding: "5px 10px", background: card, border: `1px solid ${border}`, borderRadius: 6, color: selected.size ? blue : text2, cursor: "pointer", fontSize: 11 }}>
          ⬇ Selected
        </button>
      </div>

      {/* Config Panel */}
      {tab === "config" && (
        <div style={{ padding: 20, background: card, borderBottom: `1px solid ${border}` }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: blue }}>config.yaml — {selected.size} markets selected</div>
          <pre style={{ background: bg, padding: 16, borderRadius: 8, border: `1px solid ${border}`, fontSize: 12, lineHeight: 1.6, overflowX: "auto", color: green, whiteSpace: "pre-wrap" }}>
            {configYaml}
          </pre>
          <button onClick={() => navigator.clipboard?.writeText(configYaml)}
            style={{ marginTop: 8, padding: "6px 14px", background: "#238636", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 11 }}>
            Copy to Clipboard
          </button>
        </div>
      )}

      {/* Arb Tab */}
      {tab === "arb" && (
        <div style={{ padding: 20 }}>
          {arbs.length === 0 ? (
            <div style={{ color: text2, padding: 40, textAlign: "center" }}>No arbitrage opportunities detected. YES + NO prices sum to ~$1.00 across all markets.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ padding: "8px 6px", textAlign: "left", color: text2, fontSize: 11, borderBottom: `1px solid ${border}` }}>Edge</th>
                  <th style={{ padding: "8px 6px", textAlign: "left", color: text2, fontSize: 11, borderBottom: `1px solid ${border}` }}>Bid</th>
                  <th style={{ padding: "8px 6px", textAlign: "left", color: text2, fontSize: 11, borderBottom: `1px solid ${border}` }}>Ask</th>
                  <th style={{ padding: "8px 6px", textAlign: "left", color: text2, fontSize: 11, borderBottom: `1px solid ${border}` }}>Cost</th>
                  <th style={{ padding: "8px 6px", textAlign: "left", color: text2, fontSize: 11, borderBottom: `1px solid ${border}` }}>Market</th>
                </tr>
              </thead>
              <tbody>
                {arbs.slice(0, 20).map((a, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${border}` }}>
                    <td style={{ padding: "8px 6px", color: green, fontWeight: 700 }}>{(a.arb_edge * 100).toFixed(2)}¢</td>
                    <td style={{ padding: "8px 6px" }}>{a.bb.toFixed(2)}</td>
                    <td style={{ padding: "8px 6px" }}>{a.ba.toFixed(2)}</td>
                    <td style={{ padding: "8px 6px", color: yellow }}>${(a.ba + (1 - a.bb)).toFixed(3)}</td>
                    <td style={{ padding: "8px 6px", fontSize: 11 }}>{a.question.slice(0, 60)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Main Table */}
      {tab === "mm" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#0d1117" }}>
                <th style={{ padding: "8px 6px", width: 30, borderBottom: `1px solid ${border}` }}></th>
                <Th col="mm_score" label="Score" w="50px" />
                <Th col="question" label="Market" w="auto" />
                <Th col="spread" label="Spread" w="65px" />
                <Th col="spread_pct" label="S%" w="45px" />
                <Th col="bb" label="Bid" w="50px" />
                <Th col="ba" label="Ask" w="50px" />
                <Th col="mid" label="Mid" w="50px" />
                <Th col="vol" label="Volume 24h" w="90px" />
                <Th col="liq" label="Liquidity" w="80px" />
                <Th col="category" label="Category" w="100px" />
                <th style={{ padding: "8px 6px", textAlign: "left", color: text2, fontSize: 11, borderBottom: `1px solid ${border}`, width: 160 }}>Token ID</th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 100).map((m, i) => {
                const sel = selected.has(m.token_yes);
                const scoreColor = m.mm_score >= 60 ? green : m.mm_score >= 35 ? yellow : text2;
                return (
                  <tr key={m.condition_id || i}
                    style={{ borderBottom: `1px solid ${border}`, background: sel ? "#1c2333" : i % 2 === 0 ? bg : card, cursor: "pointer" }}
                    onClick={() => toggleSelect(m.token_yes)}>
                    <td style={{ padding: "6px", textAlign: "center" }}>
                      <div style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${sel ? blue : "#484f58"}`, background: sel ? blue : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff" }}>
                        {sel ? "✓" : ""}
                      </div>
                    </td>
                    <td style={{ padding: "6px", fontWeight: 700, color: scoreColor, textAlign: "center" }}>{m.mm_score}</td>
                    <td style={{ padding: "6px", maxWidth: 300 }}>
                      <div style={{ fontWeight: 500, color: text1, fontSize: 12, lineHeight: 1.3 }}>{m.question.slice(0, 65)}</div>
                    </td>
                    <td style={{ padding: "6px", color: m.spread >= 0.02 ? green : m.spread > 0 ? text1 : text2, fontWeight: 600 }}>
                      {m.spread > 0 ? `${(m.spread * 100).toFixed(1)}¢` : "—"}
                    </td>
                    <td style={{ padding: "6px", color: text2 }}>{m.spread_pct > 0 ? `${m.spread_pct.toFixed(1)}` : "—"}</td>
                    <td style={{ padding: "6px", color: green }}>{m.bb > 0 ? m.bb.toFixed(2) : "—"}</td>
                    <td style={{ padding: "6px", color: red }}>{m.ba > 0 ? m.ba.toFixed(2) : "—"}</td>
                    <td style={{ padding: "6px", fontWeight: 600 }}>{m.mid > 0 ? m.mid.toFixed(2) : "—"}</td>
                    <td style={{ padding: "6px", color: m.vol > 50000 ? green : text2 }}>
                      {m.vol > 0 ? `$${m.vol >= 1e6 ? (m.vol/1e6).toFixed(1)+"M" : m.vol >= 1000 ? (m.vol/1000).toFixed(0)+"k" : m.vol.toFixed(0)}` : "—"}
                    </td>
                    <td style={{ padding: "6px", color: text2 }}>
                      {m.liq > 0 ? `$${m.liq >= 1e6 ? (m.liq/1e6).toFixed(1)+"M" : m.liq >= 1000 ? (m.liq/1000).toFixed(0)+"k" : m.liq.toFixed(0)}` : "—"}
                    </td>
                    <td style={{ padding: "6px", color: purple, fontSize: 10 }}>{m.category.slice(0, 18)}</td>
                    <td style={{ padding: "6px", fontSize: 9, color: text2, fontFamily: "monospace" }}>
                      {m.token_yes ? m.token_yes.slice(0, 20) + "…" : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sorted.length === 0 && !loading && (
            <div style={{ padding: 40, textAlign: "center", color: text2 }}>No markets match filters</div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ padding: "16px 20px", borderTop: `1px solid ${border}`, color: text2, fontSize: 10, textAlign: "center" }}>
        Polymarket Scanner · Gamma + CLOB API · Click rows to select · ⚙ Config tab for config.yaml export
      </div>
    </div>
  );
}
