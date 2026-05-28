/**
 * canvas_renderer.js — High-performance chart renderer.
 * Renders OHLCV data onto HTML5 Canvas. No SVG, no DOM elements per candle.
 * Supports: Candlestick, OHLC Bar chart, Volume pane, SMA/EMA overlays, Crosshair.
 *
 * Data format expected (from /api/chartdata):
 * {
 *   columns: ["timestamp", "open", "high", "low", "close", "volume", "ma_sma_50", ...],
 *   data: [[ts, o, h, l, c, v, sma50, ...], ...]
 * }
 */

class ChartRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} viewConfig  - the view config from the layout JSON
   */
  constructor(canvas, viewConfig) {
    this.canvas     = canvas;
    this.ctx        = canvas.getContext('2d');
    this.viewConfig = viewConfig;
    this.type       = viewConfig.type; // 'candle_volume' | 'bar_chart'

    // Data state
    this.columns    = [];
    this.rows       = [];
    this.colIndex   = {};    // { column_name: array_index }

    // Layout constants
    this.PAD_L      = 60;   // Y-axis label width
    this.PAD_R      = 10;
    this.PAD_T      = 20;
    this.PAD_B      = 30;   // X-axis label height
    this.VOLUME_R   = viewConfig.volume?.pane_ratio ?? 0.22;

    // Interaction state
    this.crosshairX     = -1;
    this.crosshairBar   = -1;
    this.crosshairY     = -1;   // CSS pixel Y (local mouse)
    this.crosshairPrice = null; // price value (from remote broadcast)

    this._setupHiDPI();
    this._bindEvents();
  }

  // ─── DPI-aware setup ───────────────────────────────────────

  _setupHiDPI() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this._cssW = rect.width;
    this._cssH = rect.height;
  }

  resize() {
    this._setupHiDPI();
    this.draw();
  }

  // ─── Data loading ──────────────────────────────────────────

  loadData(apiResponse) {
    this.columns  = apiResponse.columns;
    this.rows     = apiResponse.data;
    this.colIndex = {};
    this.columns.forEach((col, i) => { this.colIndex[col] = i; });
    this.draw();
  }

  _col(name)    { return this.colIndex[name] ?? -1; }
  _val(row, col) { return col >= 0 ? row[col] : null; }

  // ─── Main draw entry ───────────────────────────────────────

  draw() {
    if (!this.rows.length) return;
    const ctx = this.ctx;
    const W   = this._cssW;
    const H   = this._cssH;

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const hasVolume = this.viewConfig.volume?.enabled && this._col('volume') >= 0;
    const chartH    = hasVolume ? H * (1 - this.VOLUME_R) : H;
    const volH      = hasVolume ? H * this.VOLUME_R        : 0;

    const priceArea = {
      x: this.PAD_L,
      y: this.PAD_T,
      w: W - this.PAD_L - this.PAD_R,
      h: chartH - this.PAD_T - this.PAD_B,
    };

    const volArea = hasVolume ? {
      x: this.PAD_L,
      y: chartH + 4,
      w: priceArea.w,
      h: volH - 4 - this.PAD_B,
    } : null;

    const n      = this.rows.length;
    const barW   = Math.max(1, priceArea.w / n);
    const barGap = Math.max(0, barW * 0.15);

    // Price range
    const cI = this._col('close');
    const hI = this._col('high');
    const lI = this._col('low');
    const oI = this._col('open');
    const vI = this._col('volume');

    let minP = Infinity, maxP = -Infinity;
    for (const row of this.rows) {
      const h = this._val(row, hI) ?? this._val(row, cI);
      const l = this._val(row, lI) ?? this._val(row, cI);
      if (h > maxP) maxP = h;
      if (l < minP) minP = l;
    }
    const padP = (maxP - minP) * 0.05 || 1;
    minP -= padP; maxP += padP;

    const toY = (price) =>
      priceArea.y + priceArea.h - ((price - minP) / (maxP - minP)) * priceArea.h;

    // Store for crosshair price lookup
    this._priceArea = priceArea;
    this._minP      = minP;
    this._maxP      = maxP;

    // Grid lines
    this._drawGrid(ctx, priceArea, minP, maxP);

    // Bars
    this.rows.forEach((row, i) => {
      const bx = priceArea.x + i * barW;
      const o  = this._val(row, oI) ?? this._val(row, cI);
      const h  = this._val(row, hI) ?? this._val(row, cI);
      const l  = this._val(row, lI) ?? this._val(row, cI);
      const c  = this._val(row, cI);
      const bullish = c >= o;

      if (this.type === 'candle_volume' || this.type === 'candle') {
        this._drawCandle(ctx, bx, barW, barGap, o, h, l, c, bullish, toY);
      } else if (this.type === 'bar_chart') {
        this._drawOHLCBar(ctx, bx, barW, o, h, l, c, bullish, toY);
      }

      // Volume
      if (volArea && vI >= 0) {
        const vol  = this._val(row, vI) ?? 0;
        this._drawVolBar(ctx, volArea, i, n, vol, bullish);
      }
    });

    // Indicator overlays
    this._drawIndicators(ctx, priceArea, toY, barW);

    // Crosshair
    if (this.crosshairBar >= 0) {
      this._drawCrosshair(ctx, priceArea, barW);
    }

    // Axes
    this._drawPriceAxis(ctx, priceArea, minP, maxP);
    this._drawTimeAxis(ctx, priceArea, barW);
  }

  // ─── Candle ────────────────────────────────────────────────

  _drawCandle(ctx, bx, barW, barGap, o, h, l, c, bullish, toY) {
    const mid    = bx + barW / 2;
    const bodyX  = bx + barGap;
    const bodyW  = Math.max(1, barW - barGap * 2);
    const bodyY  = toY(Math.max(o, c));
    const bodyH  = Math.max(1, Math.abs(toY(o) - toY(c)));

    ctx.strokeStyle = bullish ? '#22c55e' : '#ef4444';
    ctx.fillStyle   = bullish ? '#22c55e' : '#ef4444';
    ctx.lineWidth   = 1;

    // Wick
    ctx.beginPath();
    ctx.moveTo(mid, toY(h));
    ctx.lineTo(mid, toY(l));
    ctx.stroke();

    // Body
    ctx.fillRect(bodyX, bodyY, bodyW, bodyH);
  }

  // ─── OHLC Bar ──────────────────────────────────────────────

  _drawOHLCBar(ctx, bx, barW, o, h, l, c, bullish, toY) {
    const mid = bx + barW / 2;
    ctx.strokeStyle = bullish ? '#22c55e' : '#ef4444';
    ctx.lineWidth   = 1.5;

    // Vertical stem
    ctx.beginPath();
    ctx.moveTo(mid, toY(h));
    ctx.lineTo(mid, toY(l));
    ctx.stroke();

    // Open tick (left)
    ctx.beginPath();
    ctx.moveTo(mid - barW * 0.35, toY(o));
    ctx.lineTo(mid, toY(o));
    ctx.stroke();

    // Close tick (right)
    ctx.beginPath();
    ctx.moveTo(mid, toY(c));
    ctx.lineTo(mid + barW * 0.35, toY(c));
    ctx.stroke();
  }

  // ─── Volume bar ────────────────────────────────────────────

  _drawVolBar(ctx, va, i, n, vol, bullish) {
    if (!this._maxVol) {
      const vI = this._col('volume');
      this._maxVol = Math.max(...this.rows.map(r => this._val(r, vI) ?? 0));
    }
    const barW = va.w / n;
    const bh   = (vol / this._maxVol) * va.h;
    const bx   = va.x + i * barW;
    const by   = va.y + va.h - bh;
    ctx.fillStyle = bullish
      ? (this.viewConfig.volume?.color_up   ?? 'rgba(34,197,94,0.5)')
      : (this.viewConfig.volume?.color_down ?? 'rgba(239,68,68,0.5)');
    ctx.fillRect(bx + 1, by, Math.max(1, barW - 2), bh);
  }

  // ─── Indicator overlays ────────────────────────────────────

  _drawIndicators(ctx, area, toY, barW) {
    const indicators = this.viewConfig.indicators ?? [];
    for (const ind of indicators) {
      const colI = this._col(ind.column);
      if (colI < 0) continue;
      ctx.strokeStyle = ind.color ?? '#888';
      ctx.lineWidth   = ind.width ?? 1;
      ctx.beginPath();
      let started = false;
      this.rows.forEach((row, i) => {
        const v = this._val(row, colI);
        if (v == null || v === 0) return;
        const x = area.x + i * barW + barW / 2;
        const y = toY(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else           { ctx.lineTo(x, y); }
      });
      ctx.stroke();
    }
  }

  // ─── Grid ──────────────────────────────────────────────────

  _drawGrid(ctx, area, minP, maxP) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    const steps     = 5;
    for (let i = 0; i <= steps; i++) {
      const price = minP + ((maxP - minP) / steps) * i;
      const y     = area.y + area.h - ((price - minP) / (maxP - minP)) * area.h;
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
    }
  }

  // ─── Price Y-axis ──────────────────────────────────────────

  _drawPriceAxis(ctx, area, minP, maxP) {
    ctx.fillStyle  = '#64748b';
    ctx.font       = '10px monospace';
    ctx.textAlign  = 'right';
    const steps    = 5;
    for (let i = 0; i <= steps; i++) {
      const price = minP + ((maxP - minP) / steps) * i;
      const y     = area.y + area.h - ((price - minP) / (maxP - minP)) * area.h;
      ctx.fillText(price.toFixed(2), area.x - 4, y + 4);
    }
  }

  // ─── Time X-axis ───────────────────────────────────────────

  _drawTimeAxis(ctx, area, barW) {
    const tsI  = this._col('timestamp');
    if (tsI < 0) return;
    ctx.fillStyle = '#64748b';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'center';
    const n       = this.rows.length;
    const step    = Math.max(1, Math.floor(n / 6));
    for (let i = 0; i < n; i += step) {
      const ts  = this.rows[i][tsI];
      const dt  = new Date(ts * 1000);
      const lbl = `${dt.getMonth()+1}/${dt.getDate()}`;
      const x   = area.x + i * barW + barW / 2;
      ctx.fillText(lbl, x, area.y + area.h + this.PAD_B - 6);
    }
  }

  // ─── Crosshair ─────────────────────────────────────────────

  _drawCrosshair(ctx, area, barW) {
    const i = this.crosshairBar;
    if (i < 0 || i >= this.rows.length) return;

    const x = area.x + i * barW + barW / 2;

    // Resolve Y: local mouse pixel OR price→Y from remote broadcast
    let y = this.crosshairY;
    if ((y < 0 || y === undefined) && this.crosshairPrice !== null && this._minP !== undefined) {
      const minP  = this._minP;
      const maxP  = this._maxP;
      y = area.y + area.h - ((this.crosshairPrice - minP) / (maxP - minP)) * area.h;
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.h);
    ctx.stroke();

    // Horizontal line (only within price area)
    if (y >= area.y && y <= area.y + area.h) {
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();

      // Price label on Y-axis
      ctx.setLineDash([]);
      const minP  = this._minP;
      const maxP  = this._maxP;
      const price = minP + (1 - (y - area.y) / area.h) * (maxP - minP);
      const lbl   = price.toFixed(2);
      const lblW  = 52;
      const lblH  = 16;
      const lblX  = area.x - lblW - 2;
      const lblY  = y - lblH / 2;

      // Background pill
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.roundRect(lblX, lblY, lblW, lblH, 3);
      ctx.fill();

      // Price text
      ctx.fillStyle  = '#f1f5f9';
      ctx.font       = 'bold 10px monospace';
      ctx.textAlign  = 'right';
      ctx.fillText(lbl, area.x - 6, y + 4);
    }

    ctx.setLineDash([]);
  }

  setCrosshairBar(barIndex) {
    this.crosshairBar   = barIndex;
    this.crosshairPrice = null; // local-only, no remote price
    this.draw();
  }

  /**
   * Called by sibling tabs via BroadcastChannel.
   * Uses the broadcast price to compute Y locally (scale-independent).
   */
  setCrosshairFromRemote(barIndex, price) {
    this.crosshairBar   = barIndex;
    this.crosshairPrice = price;  // will be converted to Y in _drawCrosshair
    this.crosshairY     = -1;     // no local Y
    this.draw();
  }

  // ─── Mouse events ──────────────────────────────────────────

  _bindEvents() {
    this.canvas.addEventListener('mousemove', (e) => {
      const rect   = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const x      = mouseX - this.PAD_L;
      const n      = this.rows.length;
      const barW   = (this._cssW - this.PAD_L - this.PAD_R) / Math.max(n, 1);
      const idx    = Math.floor(x / barW);

      if (idx >= 0 && idx < n) {
        this.crosshairBar   = idx;
        this.crosshairY     = mouseY;
        this.crosshairPrice = null; // local mouse, no remote price needed
        this.draw();

        // Compute price at cursor Y and broadcast to sibling tabs
        let price = null;
        if (this._priceArea && this._minP !== undefined) {
          const area  = this._priceArea;
          const ratio = 1 - (mouseY - area.y) / area.h;
          price = this._minP + ratio * (this._maxP - this._minP);
        }
        document.dispatchEvent(new CustomEvent('pca:crosshair', {
          detail: { barIndex: idx, price }
        }));
      }
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.crosshairBar   = -1;
      this.crosshairY     = -1;
      this.crosshairPrice = null;
      this.draw();
    });
  }
}
