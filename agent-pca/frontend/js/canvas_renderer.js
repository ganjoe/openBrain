/**
 * canvas_renderer.js — v2: Pan, Zoom, Touch, Date Label
 * ─────────────────────────────────────────────────────────────
 * - Pan (Mouse-Drag + Touch-1-Finger, nur X)
 * - Zoom (Mousewheel + Pinch, Anchor am Cursor)
 * - Auto-Y-Scale aus sichtbaren Bars
 * - Partielles Off-Screen (15% müssen sichtbar bleiben)
 * - Crosshair: Preis-Label (Y) + Datum-Label (X)
 * - Zoom NICHT synchronisiert; Crosshair synchronisiert via barIndex+price
 * - Touch-Swipe für Ticker-Navigation bleibt erhalten
 */

const MONTH_NAMES_DE = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember'
];

class ChartRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} viewConfig — View-Config aus dem Layout-JSON
   */
  constructor(canvas, viewConfig) {
    this.canvas     = canvas;
    this.ctx        = canvas.getContext('2d');
    this.viewConfig = viewConfig;
    this.type       = viewConfig.type;

    // ── Daten ──────────────────────────────────────────────
    this.columns  = [];
    this.rows     = [];
    this.colIndex = {};

    // ── Layout-Konstanten ──────────────────────────────────
    this.PAD_L    = 65;   // Y-Achse links
    this.PAD_R    = 10;
    this.PAD_T    = 20;
    this.PAD_B    = 32;   // X-Achse unten (etwas mehr für Datum-Label)
    this.VOLUME_R = viewConfig.volume?.pane_ratio ?? 0.22;

    // ── Viewport (Pan + Zoom) ──────────────────────────────
    this.viewStart = 0;
    this.viewBars  = viewConfig.bar_count ?? 250;

    // ── Crosshair ──────────────────────────────────────────
    this.crosshairBar   = -1;    // absoluter Bar-Index
    this.crosshairY     = -1;    // CSS-Pixel Y (lokale Maus)
    this.crosshairPrice = null;  // Preis-Wert (remote broadcast)

    // ── Interaktion ────────────────────────────────────────
    this._dragStart  = null;  // { x, viewStart } Mouse-Drag
    this._touchStart = null;  // { x, y, time, viewStart }
    this._pinchStart = null;  // { dist, viewBars, anchor, midRelX }

    // Gecachte Werte für Crosshair-Berechnungen
    this._priceArea = null;
    this._minP      = 0;
    this._maxP      = 1;

    this._setupHiDPI();
    this._bindEvents();
    canvas.style.cursor = 'crosshair';
  }

  // ════════════════════════════════════════════════════════
  // DPI
  // ════════════════════════════════════════════════════════

  _setupHiDPI() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this._cssW = rect.width;
    this._cssH = rect.height;
  }

  resize() { this._setupHiDPI(); this.draw(); }

  // ════════════════════════════════════════════════════════
  // Daten laden
  // ════════════════════════════════════════════════════════

  loadData(apiResponse) {
    this.columns  = apiResponse.columns;
    this.rows     = apiResponse.data;
    this.colIndex = {};
    this.columns.forEach((col, i) => { this.colIndex[col] = i; });

    // Viewport: starte bei den neuesten Bars
    this.viewBars  = Math.min(this.viewConfig.bar_count ?? 250, this.rows.length || 1);
    this.viewStart = Math.max(0, this.rows.length - this.viewBars);
    this._clampViewport();
    this.draw();
  }

  _col(name)     { return this.colIndex[name] ?? -1; }
  _val(row, col) { return col >= 0 ? row[col] : null; }

  // ════════════════════════════════════════════════════════
  // Viewport-Clamp
  // ════════════════════════════════════════════════════════

  _clampViewport() {
    const n = this.rows.length || 1;

    // NaN-Guards
    if (!isFinite(this.viewBars) || this.viewBars <= 0) this.viewBars = n;
    if (!isFinite(this.viewStart))                       this.viewStart = Math.max(0, n - this.viewBars);

    // viewBars: [1.0, n] — als FLOAT speichern!
    // NICHT runden: 1 * 1.12 = 1.12, und 1.12 * 1.12 = 1.25... → smooth Zoom-Out möglich.
    // Wäre viewBars immer Integer, bliebe round(1.12) = 1 → stuck.
    this.viewBars = Math.min(Math.max(1, this.viewBars), n);

    // viewStart: MUSS Integer sein (rows[float] = undefined in JS!)
    const vbInt    = Math.round(this.viewBars);
    const MIN_VIS  = Math.max(1, Math.floor(vbInt * 0.15));
    const minStart = -(vbInt - MIN_VIS);
    const maxStart = n - MIN_VIS;
    this.viewStart = Math.round(Math.min(Math.max(this.viewStart, minStart), maxStart));
  }

  // ════════════════════════════════════════════════════════
  // Haupt-Draw
  // ════════════════════════════════════════════════════════

  draw() {
    if (!this.rows.length) return;
    const ctx = this.ctx;
    const W   = this._cssW;
    const H   = this._cssH;

    // Hintergrund
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const hasVol = this.viewConfig.volume?.enabled && this._col('volume') >= 0;
    const chartH = hasVol ? H * (1 - this.VOLUME_R) : H;
    const volH   = hasVol ? H * this.VOLUME_R        : 0;

    const area = {
      x: this.PAD_L,
      y: this.PAD_T,
      w: W - this.PAD_L - this.PAD_R,
      h: chartH - this.PAD_T - this.PAD_B,
    };

    const volArea = hasVol ? {
      x: this.PAD_L,
      y: chartH + 4,
      w: area.w,
      h: volH - 4 - this.PAD_B,
    } : null;

    const vs   = this.viewStart;
    const vb   = Math.round(this.viewBars);          // Integer für den Loop-Zähler
    const barW = Math.max(0.5, area.w / this.viewBars); // Float für pixelgenaue Bar-Breite

    const cI = this._col('close');
    const hI = this._col('high');
    const lI = this._col('low');
    const oI = this._col('open');
    const vI = this._col('volume');

    // ── Auto-Y-Scale: nur sichtbare Bars ──────────────────
    let minP = Infinity, maxP = -Infinity, maxVol = 0;
    for (let vi = 0; vi < vb; vi++) {
      const di = vs + vi;  // vs ist immer Integer (nach _clampViewport)
      if (di < 0 || di >= this.rows.length) continue;
      const row = this.rows[di];
      if (!row) continue;  // Sicherheitsnetz
      const h   = this._val(row, hI) ?? this._val(row, cI) ?? 0;
      const l   = this._val(row, lI) ?? this._val(row, cI) ?? 0;
      const vol = this._val(row, vI) ?? 0;
      if (h > maxP) maxP = h;
      if (l < minP) minP = l;
      if (vol > maxVol) maxVol = vol;
    }
    if (!isFinite(minP)) { minP = 0; maxP = 1; }
    const padP = (maxP - minP) * 0.05 || 1;
    minP -= padP; maxP += padP;

    // Cache für Crosshair-Berechnungen
    this._priceArea = area;
    this._minP      = minP;
    this._maxP      = maxP;

    const toY = (p) => area.y + area.h - ((p - minP) / (maxP - minP)) * area.h;

    this._drawGrid(ctx, area, minP, maxP);

    // ── Bars ──────────────────────────────────────────────
    for (let vi = 0; vi < vb; vi++) {
      const di = vs + vi;
      if (di < 0 || di >= this.rows.length) continue;

      const row  = this.rows[di];
      if (!row) continue;  // Sicherheitsnetz gegen undefined
      const bx   = area.x + vi * barW;
      const o    = this._val(row, oI) ?? this._val(row, cI);
      const h    = this._val(row, hI) ?? this._val(row, cI);
      const l    = this._val(row, lI) ?? this._val(row, cI);
      const c    = this._val(row, cI);
      const bull = c >= o;

      if (this.type === 'candle_volume' || this.type === 'candle') {
        this._drawCandle(ctx, bx, barW, o, h, l, c, bull, toY);
      } else if (this.type === 'bar_chart') {
        this._drawOHLCBar(ctx, bx, barW, o, h, l, c, bull, toY);
      }

      if (volArea && vI >= 0 && maxVol > 0) {
        this._drawVolBar(ctx, volArea, vi, this._val(row, vI) ?? 0, maxVol, bull);
      }
    }

    this._drawIndicators(ctx, area, toY, barW);

    // Crosshair zeichnen wenn aktiv
    const showCrosshair = this.crosshairBar >= 0 ||
                          (this.crosshairPrice !== null && this.crosshairY < 0);
    if (showCrosshair) {
      this._drawCrosshair(ctx, area, barW);
    }

    this._drawPriceAxis(ctx, area, minP, maxP);
    this._drawTimeAxis(ctx, area, barW);
  }

  // ════════════════════════════════════════════════════════
  // Bar-Zeichenroutinen
  // ════════════════════════════════════════════════════════

  _drawCandle(ctx, bx, barW, o, h, l, c, bull, toY) {
    const mid   = bx + barW / 2;
    const gap   = Math.max(0, barW * 0.15);
    const bodyX = bx + gap;
    const bodyW = Math.max(1, barW - gap * 2);
    const bodyY = toY(Math.max(o, c));
    const bodyH = Math.max(1, Math.abs(toY(o) - toY(c)));

    ctx.strokeStyle = bull ? '#22c55e' : '#ef4444';
    ctx.fillStyle   = bull ? '#22c55e' : '#ef4444';
    ctx.lineWidth   = 1;

    ctx.beginPath();
    ctx.moveTo(mid, toY(h));
    ctx.lineTo(mid, toY(l));
    ctx.stroke();
    ctx.fillRect(bodyX, bodyY, bodyW, bodyH);
  }

  _drawOHLCBar(ctx, bx, barW, o, h, l, c, bull, toY) {
    const mid = bx + barW / 2;
    ctx.strokeStyle = bull ? '#22c55e' : '#ef4444';
    ctx.lineWidth   = 1.5;

    ctx.beginPath(); ctx.moveTo(mid, toY(h)); ctx.lineTo(mid, toY(l)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mid - barW * 0.35, toY(o)); ctx.lineTo(mid, toY(o)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mid, toY(c)); ctx.lineTo(mid + barW * 0.35, toY(c)); ctx.stroke();
  }

  _drawVolBar(ctx, va, vi, vol, maxVol, bull) {
    const barW = va.w / this.viewBars;
    const bh   = (vol / maxVol) * va.h;
    const bx   = va.x + vi * barW;
    const by   = va.y + va.h - bh;
    ctx.fillStyle = bull
      ? (this.viewConfig.volume?.color_up   ?? 'rgba(34,197,94,0.5)')
      : (this.viewConfig.volume?.color_down ?? 'rgba(239,68,68,0.5)');
    ctx.fillRect(bx + 1, by, Math.max(1, barW - 2), bh);
  }

  // ════════════════════════════════════════════════════════
  // Indikatoren
  // ════════════════════════════════════════════════════════

  _drawIndicators(ctx, area, toY, barW) {
    for (const ind of this.viewConfig.indicators ?? []) {
      const colI = this._col(ind.column);
      if (colI < 0) continue;
      ctx.strokeStyle = ind.color ?? '#888';
      ctx.lineWidth   = ind.width ?? 1;
      ctx.beginPath();
      let started = false;
      for (let vi = 0; vi < this.viewBars; vi++) {
        const di = this.viewStart + vi;
        if (di < 0 || di >= this.rows.length) { started = false; continue; }
        const v = this._val(this.rows[di], colI);
        if (v == null || v === 0) { started = false; continue; }
        const x = area.x + vi * barW + barW / 2;
        const y = toY(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else           { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
  }

  // ════════════════════════════════════════════════════════
  // Grid + Achsen
  // ════════════════════════════════════════════════════════

  _drawGrid(ctx, area, minP, maxP) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    for (let i = 0; i <= 5; i++) {
      const price = minP + ((maxP - minP) / 5) * i;
      const y     = area.y + area.h - ((price - minP) / (maxP - minP)) * area.h;
      ctx.beginPath(); ctx.moveTo(area.x, y); ctx.lineTo(area.x + area.w, y); ctx.stroke();
    }
  }

  _drawPriceAxis(ctx, area, minP, maxP) {
    ctx.fillStyle = '#64748b';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const price = minP + ((maxP - minP) / 5) * i;
      const y     = area.y + area.h - ((price - minP) / (maxP - minP)) * area.h;
      ctx.fillText(price.toFixed(2), area.x - 4, y + 4);
    }
  }

  _drawTimeAxis(ctx, area, barW) {
    const tsI = this._col('timestamp');
    if (tsI < 0) return;
    ctx.fillStyle = '#64748b';
    ctx.font      = '10px monospace';
    ctx.textAlign = 'center';
    const step    = Math.max(1, Math.floor(this.viewBars / 6));
    for (let vi = 0; vi < this.viewBars; vi += step) {
      const di = this.viewStart + vi;
      if (di < 0 || di >= this.rows.length) continue;
      const ts  = this.rows[di][tsI];
      const dt  = new Date(ts * 1000);
      const lbl = `${dt.getMonth()+1}/${dt.getDate()}`;
      const x   = area.x + vi * barW + barW / 2;
      ctx.fillText(lbl, x, area.y + area.h + this.PAD_B - 6);
    }
  }

  // ════════════════════════════════════════════════════════
  // Datumsformat
  // ════════════════════════════════════════════════════════

  _formatBarDate(timestamp) {
    const d  = new Date(timestamp * 1000);
    const dy = d.getDate();
    const mn = MONTH_NAMES_DE[d.getMonth()];
    const yr = String(d.getFullYear()).slice(-2);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${dy}. ${mn} '${yr} · ${hh}:${mm}:${ss}`;
  }

  // ════════════════════════════════════════════════════════
  // Crosshair
  // ════════════════════════════════════════════════════════

  _drawCrosshair(ctx, area, barW) {
    const absIdx = this.crosshairBar;
    const vi     = absIdx - this.viewStart;       // visuelle Position
    const inView = vi >= 0 && vi < this.viewBars && absIdx >= 0;

    // Y auflösen: lokale Maus ODER Preis→Y vom Remote-Broadcast
    let y = this.crosshairY;
    if (y < 0 && this.crosshairPrice !== null) {
      y = area.y + area.h -
          ((this.crosshairPrice - this._minP) / (this._maxP - this._minP)) * area.h;
    }

    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';

    // Vertikale Linie (nur wenn Bar sichtbar)
    if (inView) {
      const x = area.x + vi * barW + barW / 2;
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, area.y + area.h);
      ctx.stroke();
    }

    // Horizontale Linie (immer, solange Y im Bereich)
    const yInArea = y >= area.y && y <= area.y + area.h;
    if (yInArea) {
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
    }

    ctx.setLineDash([]);

    // ── Preis-Label auf Y-Achse ─────────────────────────
    if (yInArea) {
      const price = this._minP + (1 - (y - area.y) / area.h) * (this._maxP - this._minP);
      const lbl   = price.toFixed(2);
      const lblW  = 54;
      const lblH  = 16;
      const lblX  = area.x - lblW - 2;
      const lblY  = y - lblH / 2;

      ctx.fillStyle = 'rgba(30,41,59,0.92)';
      ctx.beginPath();
      ctx.roundRect(lblX, lblY, lblW, lblH, 3);
      ctx.fill();

      ctx.fillStyle = '#f1f5f9';
      ctx.font      = 'bold 10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(lbl, area.x - 5, y + 4);
    }

    // ── Datum-Label auf X-Achse ─────────────────────────
    if (inView) {
      const tsI = this._col('timestamp');
      if (tsI >= 0 && absIdx < this.rows.length) {
        const lbl  = this._formatBarDate(this.rows[absIdx][tsI]);
        ctx.font   = 'bold 10px monospace';
        const lblW = ctx.measureText(lbl).width + 14;
        const lblH = 16;
        const lblY = area.y + area.h + 2;
        const cx   = area.x + vi * barW + barW / 2;
        // Clampen damit Label im Canvas bleibt
        const lblX = Math.min(Math.max(cx - lblW / 2, area.x), area.x + area.w - lblW);

        ctx.fillStyle = 'rgba(30,41,59,0.92)';
        ctx.beginPath();
        ctx.roundRect(lblX, lblY, lblW, lblH, 3);
        ctx.fill();

        ctx.fillStyle = '#f1f5f9';
        ctx.textAlign = 'center';
        ctx.fillText(lbl, lblX + lblW / 2, lblY + 11);
      }
    }
  }

  // ── Crosshair public API ──────────────────────────────

  setCrosshairBar(barIndex) {
    this.crosshairBar   = barIndex;
    this.crosshairPrice = null;
    this.draw();
  }

  /** Vom Remote-Tab via BroadcastChannel. Preis → Y lokal berechnen. */
  setCrosshairFromRemote(barIndex, price) {
    const vi = barIndex - this.viewStart;
    // Vertikale Linie nur wenn Bar sichtbar; horizontale immer (via Preis)
    this.crosshairBar   = (vi >= 0 && vi < this.viewBars) ? barIndex : -1;
    this.crosshairPrice = price;
    this.crosshairY     = -1;
    this.draw();
  }

  // ════════════════════════════════════════════════════════
  // Event-Binding
  // ════════════════════════════════════════════════════════

  _bindEvents() {
    const c = this.canvas;

    // ── Crosshair (Maus ohne Drag) ───────────────────────
    c.addEventListener('mousemove', (e) => {
      const rect   = c.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (this._dragStart) {
        // Pan-Modus: Viewport verschieben
        const relX    = mouseX - this.PAD_L;
        const barW    = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
        const delta   = (relX - this._dragStart.x) / barW;
        this.viewStart = this._dragStart.viewStart - delta;
        this._clampViewport();
        this.draw();
        return;
      }

      // Crosshair
      const relX  = mouseX - this.PAD_L;
      const barW  = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
      const vi    = Math.floor(relX / barW);

      if (vi >= 0 && vi < this.viewBars) {
        const absIdx = this.viewStart + vi;
        if (absIdx >= 0 && absIdx < this.rows.length) {
          this.crosshairBar   = absIdx;
          this.crosshairY     = mouseY;
          this.crosshairPrice = null;
          this.draw();

          // Preis berechnen und broadcasten
          let price = null;
          if (this._priceArea) {
            const a = this._priceArea;
            price   = this._minP + (1 - (mouseY - a.y) / a.h) * (this._maxP - this._minP);
          }
          document.dispatchEvent(new CustomEvent('pca:crosshair', {
            detail: { barIndex: absIdx, price }
          }));
        }
      }
    });

    // ── Mouse-Drag (Pan) ─────────────────────────────────
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect   = c.getBoundingClientRect();
      const relX   = e.clientX - rect.left - this.PAD_L;
      this._dragStart = { x: relX, viewStart: this.viewStart };
      // Crosshair ausblenden und sofort neu zeichnen
      this.crosshairBar   = -1;
      this.crosshairY     = -1;
      this.crosshairPrice = null;
      c.style.cursor = 'grabbing';
      this.draw();
    });

    const endDrag = () => {
      this._dragStart = null;
      c.style.cursor  = 'crosshair';
    };
    c.addEventListener('mouseup',    endDrag);
    c.addEventListener('mouseleave', () => {
      endDrag();
      this.crosshairBar   = -1;
      this.crosshairY     = -1;
      this.crosshairPrice = null;
      this.draw();
    });

    // ── Wheel (Zoom) ─────────────────────────────────────
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.rows.length) return;

      const rect   = c.getBoundingClientRect();
      const relX   = e.clientX - rect.left - this.PAD_L;
      const barW   = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
      const anchor = this.viewStart + relX / barW;   // Bar unter Cursor (fraktional)

      const factor   = e.deltaY > 0 ? 1.12 : 0.89;
      this.viewBars *= factor;
      this._clampViewport();

      // viewStart so korrigieren dass Bar unter Cursor fixiert bleibt
      const newBarW  = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
      this.viewStart = anchor - relX / newBarW;
      this._clampViewport();
      this.draw();
    }, { passive: false });

    // ── Touch ────────────────────────────────────────────
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this._touchStart = {
          x: t.clientX, y: t.clientY,
          time: Date.now(),
          viewStart: this.viewStart,
        };
        this._pinchStart = null;
      } else if (e.touches.length === 2) {
        const t0   = e.touches[0], t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const rect = c.getBoundingClientRect();
        const midX = (t0.clientX + t1.clientX) / 2;
        const relX = midX - rect.left - this.PAD_L;
        const barW = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
        this._pinchStart = {
          dist,
          viewBars: this.viewBars,
          anchor:   this.viewStart + relX / barW,
          relX,
        };
        this._touchStart = null;
      }
    }, { passive: true });

    c.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && this._touchStart && !this._pinchStart) {
        // 1-Finger: Pan
        const t    = e.touches[0];
        const dx   = t.clientX - this._touchStart.x;
        const barW = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
        this.viewStart = this._touchStart.viewStart - dx / barW;
        this._clampViewport();
        this.draw();

      } else if (e.touches.length === 2 && this._pinchStart) {
        // 2-Finger: Pinch-Zoom
        const t0   = e.touches[0], t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const factor = this._pinchStart.dist / dist;   // >1 = rein, <1 = raus
        this.viewBars = this._pinchStart.viewBars * factor;
        this._clampViewport();
        // Anchor-Bar unter Pinch-Mittelpunkt fixiert halten
        const newBarW  = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
        this.viewStart = this._pinchStart.anchor - this._pinchStart.relX / newBarW;
        this._clampViewport();
        this.draw();
      }
    }, { passive: false });

    c.addEventListener('touchend', (e) => {
      if (this._touchStart && !this._pinchStart) {
        const ct = e.changedTouches[0];
        const dx  = ct.clientX - this._touchStart.x;
        const dy  = ct.clientY - this._touchStart.y;
        const dt  = Date.now() - this._touchStart.time;
        const vel = Math.abs(dx) / Math.max(dt, 1);

        // Schneller horizontaler Wisch → Ticker-Navigation
        if (vel > 0.4 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 350) {
          // Viewport auf neueste Bars resetten (nach Ticker-Wechsel sinnvoll)
          this.viewStart = Math.max(0, this.rows.length - this.viewBars);
          this._clampViewport();
          document.dispatchEvent(new CustomEvent('pca:ticker_swipe', {
            detail: { dir: dx > 0 ? 'prev' : 'next' }
          }));
        }
      }
      this._touchStart = null;
      this._pinchStart = null;
    }, { passive: true });
  }
}
