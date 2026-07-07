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
    this._dragStart     = null;   // { x, viewStart } Mouse-Drag
    this._touchStart    = null;   // { x, y, time, viewStart }
    this._pinchStart    = null;   // { dist, viewBars, anchor, midRelX }
    this._splitterDrag  = false;  // Pane-Splitter wird gezogen
    this._splitterHover = false;  // Maus schwebt über Splitter-Zone

    // ── Cache für Splitter-Event-Handler ──────────────────
    this._hasVol = false;   // ob Volume-Pane aktiv (aus letztem draw())
    this._splitY = 0;       // Y-Position des Splitters in CSS-px

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

    const n = this.rows.length || 1;

    // Viewport: Beim ersten Laden Standardwerte setzen (250 Bars + 10 Bars leerer Platz rechts)
    // Bei späteren Ladevorgängen (anderer Ticker) behalten wir Zoom und Panning bei!
    if (this._endOffset === undefined) {
      this.viewBars  = Math.min(this.viewConfig.bar_count ?? 250, n);
      this._endOffset = 10;
    } else {
      // Wenn der User gezoomt hat, kappe es maximal auf die Datenlänge des neuen Tickers
      this.viewBars = Math.min(this.viewBars, n);
    }

    // viewStart berechnet sich aus dem Datenende + Offset
    this.viewStart = n - this.viewBars + this._endOffset;
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

    // Speichere den aktuellen Randabstand (Offset) für den nächsten Ticker-Wechsel
    this._endOffset = this.viewStart + vbInt - n;
  }

  // ════════════════════════════════════════════════════════
  // Haupt-Draw
  // ════════════════════════════════════════════════════════

  draw() {
    if (!this.rows.length) return;
    const ctx = this.ctx;
    const W   = this._cssW;
    const H   = this._cssH;

    // ── Sekundärachsen & PAD_R frühzeitig bestimmen ───────
    const volColName  = this.viewConfig.volume?.column ?? 'volume';
    const volEnabled  = !!this.viewConfig.volume?.enabled;
    const hasVolData  = volEnabled && this._col(volColName) >= 0;
    const hasVolPane  = volEnabled;  // Pane immer reservieren wenn enabled
    const secAxis     = this._findMainSecondaryAxis();
    this._secAxis     = secAxis;   // Cache für _drawCrosshair
    this.PAD_R        = (secAxis || hasVolPane) ? 60 : 10;

    // Hintergrund
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);

    const chartH = hasVolPane ? H * (1 - this.VOLUME_R) : H;
    const volH   = hasVolPane ? H * this.VOLUME_R        : 0;

    // Cache für Splitter-Event-Handler
    this._hasVol = hasVolPane;
    this._splitY = chartH;

    const area = {
      x: this.PAD_L,
      y: this.PAD_T,
      w: W - this.PAD_L - this.PAD_R,
      h: chartH - this.PAD_T - this.PAD_B,
    };

    const volArea = hasVolPane ? {
      x: this.PAD_L,
      y: chartH + 4,
      w: area.w,
      h: volH - 4 - this.PAD_B,
    } : null;

    this.volArea = volArea;

    const vs   = this.viewStart;
    const vb   = Math.round(this.viewBars);          // Integer für den Loop-Zähler
    const barW = Math.max(0.5, area.w / this.viewBars); // Float für pixelgenaue Bar-Breite

    const cI = this._col('close');
    const hI = this._col('high');
    const lI = this._col('low');
    const oI = this._col('open');
    const vI = this._col(volColName);

    // ── Auto-Y-Scale: nur sichtbare Bars ──────────────────
    let minP = Infinity, maxP = -Infinity;
    let minVol = 0, maxVol = 0.00001;
    for (let vi = 0; vi < vb; vi++) {
      const di = vs + vi;  // vs ist immer Integer (nach _clampViewport)
      if (di < 0 || di >= this.rows.length) continue;
      const row = this.rows[di];
      if (!row) continue;  // Sicherheitsnetz
      const h   = this._val(row, hI) ?? this._val(row, cI) ?? 0;
      const l   = this._val(row, lI) ?? this._val(row, cI) ?? 0;
      if (h > maxP) maxP = h;
      if (l < minP) minP = l;

      if (vI >= 0) {
        const vol = this._val(row, vI) ?? 0;
        if (vol > maxVol) maxVol = vol;
        if (vol < minVol) minVol = vol;
      }
    }
    if (!isFinite(minP)) { minP = 0; maxP = 1; }
    const padP = (maxP - minP) * 0.05 || 1;
    minP -= padP; maxP += padP;

    // Cache für Crosshair-Berechnungen
    this._priceArea = area;
    this._minP      = minP;
    this._maxP      = maxP;
    this.minVol     = minVol;
    this.maxVol     = maxVol;

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
      } else if (this.type === 'histogram') {
        const y0 = toY(0);
        const yC = toY(c);
        ctx.fillStyle = c >= 0 ? '#22c55e' : '#ef4444';
        const bw = Math.max(1, barW * 0.8);
        ctx.fillRect(bx - bw/2, Math.min(y0, yC), bw, Math.abs(y0 - yC) || 1);
      }

      if (volArea && hasVolData && vI >= 0) {
        this._drawVolBar(ctx, volArea, vi, this._val(row, vI) ?? 0, minVol, maxVol, bull);
      }
    }

    this._drawIndicators(ctx, area, toY, barW);

    if (this.type === 'line') {
      ctx.beginPath();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      let first = true;
      for (let vi = 0; vi < vb; vi++) {
        const di = vs + vi;
        if (di < 0 || di >= this.rows.length) continue;
        const row = this.rows[di];
        if (!row) continue;
        const bx = area.x + vi * barW;
        const c  = this._val(row, cI);
        if (c === undefined || c === null) continue;
        if (first) {
          ctx.moveTo(bx, toY(c));
          first = false;
        } else {
          ctx.lineTo(bx, toY(c));
        }
      }
      ctx.stroke();
    }

    // Achsen zuerst zeichnen, Crosshair-Labels kommen darüber
    this._drawPriceAxis(ctx, area, minP, maxP);
    this._drawTimeAxis(ctx, area, barW);
    if (secAxis) this._drawSecondaryAxis(ctx, area, secAxis);
    if (hasVolData && volArea) this._drawVolPaneAxis(ctx, volArea, minVol, maxVol);
    if (hasVolPane && volArea && !hasVolData) {
      // Configured column missing — show hint in empty pane
      ctx.fillStyle = 'rgba(100,116,139,0.5)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${volColName} — n/a`, volArea.x + volArea.w / 2, volArea.y + volArea.h / 2 + 4);
    }
    if (hasVolPane) this._drawSplitterHandle(ctx, chartH, W);

    // Crosshair + dynamische Data-Labels (immer zuletzt → oben)
    const showCrosshair = this.crosshairBar >= 0 ||
                          (this.crosshairPrice !== null && this.crosshairY < 0);
    if (showCrosshair) {
      this._vI = vI;  // Cache für Volumen-Spaltenzugriff im Crosshair
      this._drawCrosshair(ctx, area, volArea, barW);
    }
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

  _drawVolBar(ctx, va, vi, vol, minVol, maxVol, bull) {
    const barW = va.w / this.viewBars;
    const range = maxVol - minVol || 0.00001;
    const zeroY = va.y + va.h - ((0 - minVol) / range) * va.h;
    const valY  = va.y + va.h - ((vol - minVol) / range) * va.h;

    const bx = va.x + vi * barW;
    ctx.fillStyle = bull
      ? (this.viewConfig.volume?.color_up   ?? 'rgba(34,197,94,0.5)')
      : (this.viewConfig.volume?.color_down ?? 'rgba(239,68,68,0.5)');
    
    ctx.fillRect(bx + 1, Math.min(zeroY, valY), Math.max(1, barW - 2), Math.max(1, Math.abs(zeroY - valY)));
  }

  // ════════════════════════════════════════════════════════
  // Indikatoren
  // ════════════════════════════════════════════════════════

  _drawIndicators(ctx, area, toY, barW) {
    for (const ind of this.viewConfig.indicators ?? []) {
      const colI = this._col(ind.column);
      if (colI < 0) continue;
      
      const isVolPane = ind.pane === 'volume';
      const drawArea = isVolPane ? this.volArea : area;
      if (isVolPane && !drawArea) continue;

      ctx.strokeStyle = ind.color ?? '#888';
      ctx.lineWidth   = ind.width ?? 1;
      ctx.beginPath();
      let started = false;
      
      // Determine Y scaler
      let yScaler;
      if (isVolPane) {
        const range = this.maxVol - this.minVol || 0.00001;
        yScaler = (v) => drawArea.y + drawArea.h - ((v - this.minVol) / range) * drawArea.h;
      } else if (ind.scale === 'normalized') {
        const minVal = ind.scale_min ?? 0;
        const maxVal = ind.scale_max ?? 100;
        yScaler = (v) => drawArea.y + drawArea.h - ((v - minVal) / (maxVal - minVal)) * drawArea.h;
      } else {
        yScaler = toY;
      }

      for (let vi = 0; vi < this.viewBars; vi++) {
        const di = this.viewStart + vi;
        if (di < 0 || di >= this.rows.length) { started = false; continue; }
        const v = this._val(this.rows[di], colI);
        if (v == null || isNaN(v)) { started = false; continue; }
        const x = drawArea.x + vi * barW + barW / 2;
        const y = yScaler(v);
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
  // Sekundäre Y-Achsen & Splitter-Anfasser
  // ════════════════════════════════════════════════════════

  /** Gibt den ersten Haupt-Pane-Indikator mit normalized-Skala zurück (oder null). */
  _findMainSecondaryAxis() {
    for (const ind of this.viewConfig.indicators ?? []) {
      if (ind.pane === 'volume') continue;
      if (ind.scale === 'normalized') {
        if (this._col(ind.column) < 0) continue;
        return {
          min:   ind.scale_min ?? 0,
          max:   ind.scale_max ?? 100,
          label: ind.label ?? ind.column,
          color: ind.color ?? '#888',
        };
      }
    }
    return null;
  }

  /** Rechte Y-Achse für normalized Overlay-Indikatoren im Haupt-Pane. */
  _drawSecondaryAxis(ctx, area, { min, max, label, color }) {
    const axisX = area.x + area.w + 5;
    const ticks  = this._niceTicks(min, max, 5);
    const range  = max - min || 0.00001;

    // Tick-Striche
    ctx.strokeStyle = color + '44';
    ctx.lineWidth   = 1;
    for (const v of ticks) {
      const y = area.y + area.h - ((v - min) / range) * area.h;
      if (y < area.y - 2 || y > area.y + area.h + 2) continue;
      ctx.beginPath();
      ctx.moveTo(area.x + area.w, y);
      ctx.lineTo(area.x + area.w + 4, y);
      ctx.stroke();
    }

    // Tick-Labels
    ctx.fillStyle = color;
    ctx.font      = '10px monospace';
    ctx.textAlign = 'left';
    for (const v of ticks) {
      const y = area.y + area.h - ((v - min) / range) * area.h;
      if (y < area.y - 2 || y > area.y + area.h + 2) continue;
      ctx.fillText(this._fmtAxisVal(v), axisX, y + 4);
    }

    // Label-Badge oben rechts (farbig hinterlegt)
    const shortLabel = label.length > 12 ? label.slice(0, 11) + '\u2026' : label;
    ctx.font      = 'bold 9px monospace';
    const lw      = ctx.measureText(shortLabel).width;
    ctx.fillStyle = color + '28';
    ctx.fillRect(area.x + area.w + 3, area.y + 2, lw + 8, 13);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(shortLabel, area.x + area.w + 7, area.y + 12);
  }

  /** Rechte Y-Achse für den unteren Volumen-Pane. */
  _drawVolPaneAxis(ctx, volArea, minVol, maxVol) {
    const axisX = volArea.x - 4;
    const color  = '#64748b';
    const ticks  = this._niceTicks(minVol, maxVol, 3);
    const range  = maxVol - minVol || 0.00001;

    ctx.strokeStyle = color + '55';
    ctx.lineWidth   = 1;
    ctx.fillStyle   = color;
    ctx.font        = '10px monospace';
    ctx.textAlign   = 'right';

    for (const v of ticks) {
      const y = volArea.y + volArea.h - ((v - minVol) / range) * volArea.h;
      if (y < volArea.y - 2 || y > volArea.y + volArea.h + 2) continue;
      ctx.beginPath();
      ctx.moveTo(volArea.x, y);
      ctx.lineTo(volArea.x - 4, y);
      ctx.stroke();
      ctx.fillText(this._fmtAxisVal(v), axisX, y + 4);
    }

    // Pane-Label oben rechts (Spaltenname)
    const colName    = this.viewConfig.volume?.column ?? 'vol';
    const shortLabel = colName.replace(/_/g, ' ').slice(0, 12);
    ctx.font      = 'bold 9px monospace';
    ctx.fillStyle = color + 'aa';
    ctx.textAlign = 'left';
    ctx.fillText(shortLabel, volArea.x + volArea.w + 5, volArea.y + 11);
  }

  /** Zeichnet den Drag-Anfasser zwischen oberem und unterem Pane. */
  _drawSplitterHandle(ctx, splitY, W) {
    const isActive  = this._splitterHover || this._splitterDrag;
    const lineAlpha = isActive ? '88' : '33';
    const dotAlpha  = isActive ? 'ee' : '66';

    // Trennlinie
    ctx.strokeStyle = '#94a3b8' + lineAlpha;
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(this.PAD_L, splitY);
    ctx.lineTo(W - this.PAD_R, splitY);
    ctx.stroke();

    // 5 Anfasser-Punkte zentriert
    const cx = W / 2;
    ctx.fillStyle = '#94a3b8' + dotAlpha;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.arc(cx + i * 7, splitY, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ════════════════════════════════════════════════════════
  // Hilfs-Methoden: Achsenskalierung
  // ════════════════════════════════════════════════════════

  /** Berechnet gleichmäßige "schöne" Tick-Werte (analog D3 nice ticks). */
  _niceTicks(min, max, count = 5) {
    if (!isFinite(min) || !isFinite(max) || min >= max) return [isFinite(min) ? min : 0];
    const range = max - min;
    const raw   = range / count;
    const mag   = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm  = raw / mag;
    const step  = norm < 1.5 ? mag : norm < 3.5 ? 2 * mag : norm < 7.5 ? 5 * mag : 10 * mag;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.001; v += step) {
      ticks.push(parseFloat(v.toPrecision(10)));
      if (ticks.length > count + 2) break;
    }
    return ticks;
  }

  /** Kompakte Wert-Formatierung: 3.5B, 1.2M, 42K, 99, 3.14 */
  _fmtAxisVal(v) {
    const a = Math.abs(v);
    if (a >= 1e9)  return (v / 1e9).toFixed(1) + 'B';
    if (a >= 1e6)  return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e4)  return (v / 1e3).toFixed(0) + 'K';
    if (Number.isInteger(v) || a >= 100) return v.toFixed(0);
    if (a >= 10)   return v.toFixed(1);
    return v.toFixed(2);
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

  _drawCrosshair(ctx, area, volArea, barW) {
    const absIdx = this.crosshairBar;
    const vi     = absIdx - this.viewStart;
    const inView = vi >= 0 && vi < this.viewBars && absIdx >= 0;

    // Y auflösen: lokale Maus ODER Preis→Y vom Remote-Broadcast
    let y = this.crosshairY;
    if (y < 0 && this.crosshairPrice !== null) {
      y = area.y + area.h -
          ((this.crosshairPrice - this._minP) / (this._maxP - this._minP)) * area.h;
    }

    const yInArea  = y >= area.y  && y <= area.y  + area.h;
    const yInVol   = volArea && y >= volArea.y && y <= volArea.y + volArea.h;

    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';

    // ── Vertikale Linie durch beide Panes ───────────────
    if (inView) {
      const x       = area.x + vi * barW + barW / 2;
      const lineEnd = volArea ? volArea.y + volArea.h : area.y + area.h;
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, lineEnd);
      ctx.stroke();
    }

    // ── Horizontale Linie im oberen Pane ────────────────
    if (yInArea) {
      ctx.beginPath();
      ctx.moveTo(area.x, y);
      ctx.lineTo(area.x + area.w, y);
      ctx.stroke();
    }

    // ── Horizontale Linie im unteren Pane ───────────────
    if (yInVol) {
      ctx.beginPath();
      ctx.moveTo(volArea.x, y);
      ctx.lineTo(volArea.x + volArea.w, y);
      ctx.stroke();
    }

    ctx.setLineDash([]);

    // ── Preis-Label auf linker Y-Achse ──────────────────
    if (yInArea) {
      const price = this._minP + (1 - (y - area.y) / area.h) * (this._maxP - this._minP);
      this._drawAxisValueLabel(ctx, price.toFixed(2), area.x - 2, y, 'left', '#f1f5f9');
    }

    // ── Volumen/ADR-Label auf linker Y-Achse (unterer Pane) ──
    if (yInVol) {
      const range = this.maxVol - this.minVol || 0.00001;
      const volAtY = this.minVol + (1 - (y - volArea.y) / volArea.h) * range;
      this._drawAxisValueLabel(ctx, this._fmtAxisVal(volAtY), volArea.x - 2, y, 'left', '#f1f5f9');
    }

    // ── RS / Sec-Axis Data-Label rechts (oberer Pane) ───
    if (inView && this._secAxis && absIdx < this.rows.length) {
      const { min, max, color } = this._secAxis;
      // Ersten normalized-Indikator auslesen
      for (const ind of this.viewConfig.indicators ?? []) {
        if (ind.pane === 'volume' || ind.scale !== 'normalized') continue;
        const colI = this._col(ind.column);
        if (colI < 0) continue;
        const v = this._val(this.rows[absIdx], colI);
        if (v == null || isNaN(v)) break;
        const range = max - min || 0.00001;
        const vy    = area.y + area.h - ((v - min) / range) * area.h;
        const lbl   = this._fmtAxisVal(v);
        this._drawAxisValueLabel(ctx, lbl, area.x + area.w + 2, vy, 'right', color);
        break;
      }
    }

    // ── Vol-Pane Data-Label rechts (unterer Pane) ───────
    if (inView && volArea && absIdx < this.rows.length) {
      const vColI = this._vI;
      if (vColI >= 0) {
        const v   = this._val(this.rows[absIdx], vColI);
        if (v != null && !isNaN(v)) {
          const range = this.maxVol - this.minVol || 0.00001;
          const vy    = volArea.y + volArea.h - ((v - this.minVol) / range) * volArea.h;
          this._drawAxisValueLabel(ctx, this._fmtAxisVal(v), volArea.x + volArea.w + 2, vy, 'right', '#94a3b8');
        }
      }
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

  /**
   * Zeichnet eine schwebende Wert-Box auf einer Y-Achse.
   * @param {string} lbl      - Anzeigetext
   * @param {number} axisEdge - X-Koordinate der Achsenkante
   * @param {number} y        - Y-Koordinate des Werts
   * @param {'left'|'right'} side - rechte oder linke Achse
   * @param {string} color    - Textfarbe
   */
  _drawAxisValueLabel(ctx, lbl, axisEdge, y, side, color) {
    ctx.font = 'bold 10px monospace';
    const tw   = ctx.measureText(lbl).width;
    const lblW = tw + 10;
    const lblH = 16;
    const lblX = side === 'left' ? axisEdge - lblW : axisEdge;
    const lblY = y - lblH / 2;

    ctx.fillStyle = 'rgba(15,23,42,0.92)';
    ctx.beginPath();
    ctx.roundRect(lblX, lblY, lblW, lblH, 3);
    ctx.fill();

    ctx.fillStyle  = color;
    ctx.textAlign  = side === 'left' ? 'right' : 'left';
    const textX    = side === 'left' ? axisEdge - 5 : axisEdge + 5;
    ctx.fillText(lbl, textX, y + 4);
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

    // ── Mousemove: Splitter / Pan / Crosshair (Priorität absteigend) ──
    c.addEventListener('mousemove', (e) => {
      const rect   = c.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // 1. Splitter-Drag hat höchste Priorität
      if (this._splitterDrag) {
        const newRatio = 1 - mouseY / this._cssH;
        this.VOLUME_R  = Math.max(0.10, Math.min(0.50, newRatio));
        this.draw();
        return;
      }

      // 2. Pan-Modus
      if (this._dragStart) {
        const relX  = mouseX - this.PAD_L;
        const barW  = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
        const delta = (relX - this._dragStart.x) / barW;
        this.viewStart = this._dragStart.viewStart - delta;
        this._clampViewport();
        this.draw();
        return;
      }

      // 3. Splitter-Hover erkennen (±6 px um Trennlinie)
      const nearSplitter  = this._hasVol && Math.abs(mouseY - this._splitY) <= 6;
      const wasHovering   = this._splitterHover;
      this._splitterHover = nearSplitter;
      if (nearSplitter) {
        c.style.cursor = 'ns-resize';
        if (!wasHovering) this.draw();  // Highlight-Zustand hat gewechselt
        return;
      }
      if (wasHovering) {
        c.style.cursor = 'crosshair';
        this.draw();
      }

      // 4. Crosshair
      const relX = mouseX - this.PAD_L;
      const barW = (this._cssW - this.PAD_L - this.PAD_R) / this.viewBars;
      const vi   = Math.floor(relX / barW);

      if (vi >= 0 && vi < this.viewBars) {
        const absIdx = this.viewStart + vi;
        if (absIdx >= 0 && absIdx < this.rows.length) {
          this.crosshairBar   = absIdx;
          this.crosshairY     = mouseY;
          this.crosshairPrice = null;
          this.draw();

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

    // ── Mousedown: Splitter-Drag oder Pan starten ─────────
    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect   = c.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Splitter hat Vorrang vor Pan
      if (this._hasVol && Math.abs(mouseY - this._splitY) <= 6) {
        this._splitterDrag = true;
        c.style.cursor = 'ns-resize';
        return;
      }

      const relX = mouseX - this.PAD_L;
      this._dragStart = { x: relX, viewStart: this.viewStart };
      this.crosshairBar   = -1;
      this.crosshairY     = -1;
      this.crosshairPrice = null;
      c.style.cursor = 'grabbing';
      this.draw();
    });

    const endDrag = () => {
      this._dragStart     = null;
      this._splitterDrag  = false;
      this._splitterHover = false;
      c.style.cursor      = 'crosshair';
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
