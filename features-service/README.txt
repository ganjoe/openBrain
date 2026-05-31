================================================================================
  STOCK DATA FEATURES — README
================================================================================

Überblick
---------
stock-data-features ist ein eigenständiger Microservice für die Berechnung
technischer Indikatoren auf Aktien-Kursdaten. Er liest OHLCV-Daten aus
Parquet-Dateien (/data/parquet/<TICKER>/<TIMEFRAME>.parquet) und stellt
zwei Berechnungsmodi bereit:

  1. BATCH-MODUS:   Berechnet ALLE konfigurierten Features für ALLE Ticker
                    auf einmal (SMA, EMA, Bollinger, Stochastic, IBD RS,
                    Minervini Score). Wird von stock-data-node nach jedem
                    Download-Zyklus automatisch getriggert.

  2. ON-THE-FLY:    Berechnet einzelne Indikatoren für einzelne Ticker in
                    Echtzeit und gibt das Ergebnis direkt als JSON zurück.
                    Aktuell unterstützt:
                      - Moving Averages (SMA, EMA)    via POST /features/ma
                      - RS Rating (IBD-Methode)       via POST /features/rs
                      - Minervini Trend Template      via POST /features/minervini

  3. SCANNER-MODUS: Filtert das gesamte Aktienuniversum basierend auf
                    beliebigen Indikatoren (z.B. RS Rating > 90).
                    Ergebnisse werden als Watchlist (.txt) exportiert
                    via POST /scanner/run.


Programmablauf
--------------
  Docker Start
       │
       ▼
  FastAPI startet auf Port 8003
       │
       ├── Wartet auf POST /features/calculate    (Batch von stock-data-node)
       ├── Wartet auf POST /features/ma           (On-the-Fly MA)
       ├── Wartet auf POST /features/rs           (On-the-Fly RS Rating)
       ├── Wartet auf POST /features/minervini    (On-the-Fly Minervini)
       ├── GET /health                            (Docker Healthcheck)
       └── GET /status                            (Job-Status abfragen)

Bei einem Batch-Aufruf (/features/calculate):
  1. features.json wird gelesen (fachliche Parameter: type, window, period)
  2. Alle Ticker-Ordner in /data/parquet/ werden gescannt
  3. Pro Ticker wird der OHLCV-Parquet geladen
  4. Alle Features werden parallel berechnet (ProcessPoolExecutor)
  5. Cross-sectional Features (z.B. IBD RS Ranking) werden zentral berechnet
  6. Ergebnisse werden als <timeframe>_features.parquet zurückgeschrieben

Bei einem On-the-Fly-Aufruf (/features/ma):
  1. Der OHLCV-Parquet des angegebenen Tickers wird geladen
  2. Der angeforderte Moving Average (SMA oder EMA) wird berechnet
  3. Das Ergebnis wird als JSON-Array direkt zurückgegeben (kein Schreiben)

Bei einem On-the-Fly RS-Rating-Aufruf (/features/rs):
  Modus A — vs Benchmark (z.B. "AAPL vs SPX"):
    1. OHLCV-Daten für Ticker und Benchmark werden geladen
    2. Für beide wird der gewichtete ROC-Score berechnet (IBD-Methode):
       raw = (2 × ROC_63) + ROC_126 + ROC_189 + ROC_252
    3. Die Differenz (Ticker - Benchmark) wird zurückgegeben
       → Positiv = Ticker outperformt, Negativ = Benchmark stärker

  Modus B — vs alle Ticker (kein Benchmark angegeben):
    1. OHLCV-Daten für ALLE Ticker im Parquet-Verzeichnis werden geladen
    2. Für jeden Ticker wird der gewichtete ROC-Score berechnet
    3. Der angefragte Ticker wird im Cross-Sectional-Ranking eingestuft
    4. Ein Perzentilwert (1-99) wird zurückgegeben
       → 99 = stärkster Ticker, 1 = schwächster


================================================================================
  API REFERENZ
================================================================================


POST /features/calculate
------------------------
Startet die vollständige Feature-Berechnung für alle Ticker im Hintergrund.

  Request:    Kein Body erforderlich.
  
  Parameter:  ?stream=true    (optional) Gibt Echtzeit-Logs als Text-Stream zurück

  Response:   202 Accepted    — Job wurde gestartet
              409 Conflict    — Ein Job läuft bereits

  Beispiel:
    curl -X POST http://localhost:8003/features/calculate

  Beispiel (mit Echtzeit-Logs):
    curl -X POST "http://localhost:8003/features/calculate?stream=true"


POST /features/ma
------------------
Berechnet on-the-fly einen Moving Average für einen einzelnen Ticker.

  Request Body (JSON):
    {
      "ticker":           "AAPL",         (string, Pflicht)  Ticker-Symbol
      "ma_type":          "sma",          (string, Pflicht)  "sma" oder "ema"
      "chart_timeframe":  "1D",           (string, Optional) Quell-Timeframe, Default: "1D"
      "ma_window":        50              (int,    Pflicht)  MA-Periode (1-500)
    }

  Response (200 OK):
    {
      "ticker":           "AAPL",
      "chart_timeframe":  "1D",
      "ma_type":          "SMA",
      "ma_window":        50,
      "ma_label":         "sma_50",
      "data_points":      1260,
      "timestamps":       [1640000000, 1640086400, ...],
      "close":            [150.23, 151.50, ...],
      "values":           [148.50, 148.80, ...]
    }

  Response (404 Not Found):
    {
      "error": "No data found for ticker 'XYZ' with timeframe '1D'"
    }

  Response (422 Unprocessable Entity):
    Automatische Validierungsfehler bei ungültigem ma_type oder ma_window.

  Beispiele:

    # SMA 50 auf Daily-Chart für AAPL
    curl -X POST http://localhost:8003/features/ma \
      -H "Content-Type: application/json" \
      -d '{"ticker": "AAPL", "ma_type": "sma", "ma_window": 50}'

    # EMA 20 auf Daily-Chart für MSFT
    curl -X POST http://localhost:8003/features/ma \
      -H "Content-Type: application/json" \
      -d '{"ticker": "MSFT", "ma_type": "ema", "ma_window": 20}'

    # SMA 200 auf Weekly-Chart für TSLA
    curl -X POST http://localhost:8003/features/ma \
      -H "Content-Type: application/json" \
      -d '{"ticker": "TSLA", "ma_type": "sma", "chart_timeframe": "1W", "ma_window": 200}'


POST /features/rs
------------------
Berechnet on-the-fly das IBD RS Rating für einen einzelnen Ticker.
Zwei Modi je nachdem ob ein Benchmark angegeben wird.

  Request Body (JSON):
    {
      "ticker":           "AAPL",         (string, Pflicht)  Ticker-Symbol
      "benchmark":        "SPX",          (string, Optional) Benchmark-Ticker, Default: null
      "chart_timeframe":  "1D"            (string, Optional) Quell-Timeframe, Default: "1D"
    }

  Modus A — Mit Benchmark (Response 200 OK):
    {
      "ticker":               "AAPL",
      "benchmark":            "SPX",
      "mode":                 "vs_benchmark",
      "ticker_raw_score":     185.4321,
      "benchmark_raw_score":  120.1234,
      "rs_relative":          65.3087,
      "interpretation":       "positive = ticker outperforms benchmark"
    }

  Modus B — Ohne Benchmark = vs alle Ticker (Response 200 OK):
    {
      "ticker":               "AAPL",
      "benchmark":            null,
      "mode":                 "vs_all",
      "rs_rating":            87,
      "raw_score":            185.4321,
      "universe_size":        1450,
      "interpretation":       "Outperforms 87% of 1450 tickers"
    }

  Response (404 Not Found):
    {
      "error": "No data found for ticker 'XYZ'"
    }
    oder:
    {
      "error": "No data found for benchmark 'INVALID'"
    }

  Response (400 Bad Request):
    {
      "error": "Not enough data for 'XYZ' (need >= 63 rows, have 10)"
    }

  Beispiele:

    # RS Rating von AAPL vs alle Ticker (Cross-Sectional Rank)
    curl -X POST http://localhost:8003/features/rs \
      -H "Content-Type: application/json" \
      -d '{"ticker": "AAPL"}'

    # RS Rating von AAPL vs SPX (Benchmark-Vergleich)
    curl -X POST http://localhost:8003/features/rs \
      -H "Content-Type: application/json" \
      -d '{"ticker": "AAPL", "benchmark": "SPX"}'

    # RS Rating von MSFT vs QQQ
    curl -X POST http://localhost:8003/features/rs \
      -H "Content-Type: application/json" \
      -d '{"ticker": "MSFT", "benchmark": "QQQ"}'


POST /features/minervini
-------------------------
Berechnet on-the-fly den Minervini Trend Template Score für einen Ticker.
Prüft alle 8 Bedingungen des Mark Minervini SEPA-Systems.

  Request Body (JSON):
    {
      "ticker":           "AAPL",         (string, Pflicht)  Ticker-Symbol
      "chart_timeframe":  "1D"            (string, Optional) Quell-Timeframe, Default: "1D"
    }

  Die 8 Minervini-Bedingungen:
    1. Preis > SMA 150 UND Preis > SMA 200
    2. SMA 150 > SMA 200
    3. SMA 200 steigt (> SMA 200 vor 20 Tagen)
    4. SMA 50 > SMA 150 UND SMA 50 > SMA 200
    5. Preis > SMA 50
    6. Preis >= 52-Wochen-Tief * 1.30 (mind. 30% über Tief)
    7. Preis >= 52-Wochen-Hoch * 0.75 (max. 25% unter Hoch)
    8. RS Rating >= 70 (aus Batch-Berechnung, falls verfügbar)

  Response (200 OK):
    {
      "ticker":             "AAPL",
      "chart_timeframe":    "1D",
      "score":              7,
      "max_score":          8,
      "is_trend_template":  false,
      "conditions": {
        "1_price_above_sma150_and_sma200":    true,
        "2_sma150_above_sma200":              true,
        "3_sma200_trending_up":               true,
        "4_sma50_above_sma150_and_sma200":    true,
        "5_price_above_sma50":                true,
        "6_price_30pct_above_52w_low":        true,
        "7_price_within_25pct_of_52w_high":   true,
        "8_rs_rating_above_70":               null
      },
      "rs_rating":          null,
      "rs_available":       false,
      "context": {
        "close":    185.50,
        "sma_50":   182.30,
        "sma_150":  178.10,
        "sma_200":  175.40,
        "high_52w": 198.23,
        "low_52w":  124.17
      }
    }

  Hinweis zu Bedingung 8:
    Das RS Rating stammt aus der letzten Batch-Berechnung (POST /features/calculate).
    Wurde noch kein Batch-Lauf ausgeführt, ist rs_available=false und Bedingung 8
    wird als null (nicht auswertbar) gemeldet. max_score ist dann 7 statt 8.

  Response (404 Not Found):
    { "error": "No data found for ticker 'XYZ'" }

  Response (400 Bad Request):
    { "error": "Not enough data for 'XYZ' (need >= 260 rows for 52-week analysis, have 50)" }

  Beispiele:

    # Minervini Score für AAPL
    curl -X POST http://localhost:8003/features/minervini \
      -H "Content-Type: application/json" \
      -d '{"ticker": "AAPL"}'

    # Minervini Score für NVDA
    curl -X POST http://localhost:8003/features/minervini \
      -H "Content-Type: application/json" \
      -d '{"ticker": "NVDA"}'


POST /scanner/run
------------------
Filtert sämtliche Ticker basierend auf einem Indikator und exportiert eine Watchlist.

  Request Body (JSON):
    {
      "scanner_name":  "ibd_rs",       (string, Pflicht)  ID des Indikators (wie in features.json)
      "condition":     "higher",       (string, Pflicht)  "higher", "lower" oder "range"
      "value":         90,             (float,  Opt.)     Schwellenwert für higher/lower
      "min_val":       20,             (float,  Opt.)     Minimum für range
      "max_val":       80              (float,  Opt.)     Maximum für range
    }

  Hinweis: Der Dateiname der exportierten Watchlist entspricht dem "scanner_name".

  Response (200 OK):
    {
      "status":         "success",
      "scanner":        "ibd_rs",
      "matches_found":  142,
      "watchlist_path": "/app/data/watchlists/ibd_rs.txt"
    }

  Beispiele:

    # Alle Aktien mit RS Rating > 90 finden
    curl -X POST http://localhost:8003/scanner/run \
      -H "Content-Type: application/json" \
      -d '{"scanner_name": "ibd_rs", "condition": "higher", "value": 90}'

    # Alle Aktien mit Trend Template (Score = 8)
    curl -X POST http://localhost:8003/scanner/run \
      -H "Content-Type: application/json" \
      -d '{"scanner_name": "minervini_score", "condition": "higher", "value": 8}'

    # Aktien mit Stochastik %K im Bereich 20 bis 80
    curl -X POST http://localhost:8003/scanner/run \
      -H "Content-Type: application/json" \
      -d '{"scanner_name": "stock_10_k", "condition": "range", "min_val": 20, "max_val": 80}'


GET /status
-----------
Gibt zurück, ob gerade eine Batch-Berechnung läuft.

  Response:
    { "is_running": false }


GET /health
-----------
Docker Healthcheck Endpoint.

  Response:
    { "status": "ok" }


================================================================================
  KONFIGURATION
================================================================================

Umgebungsvariablen:
  APP_BASE_DIR            Basis-Verzeichnis (Default: Projektordner)
  FEATURES_API_PORT       API-Port (Default: 8003)

Shared Volumes (Docker):
  /app/config             → features.json, settings.json (von stock-data-node)
  /app/data               → Parquet-Dateien (OHLCV + Features)

Dateien:
  config/features.json    Feature-Definitionen (fachlich + visuell)
  config/settings.json    processing_threads, etc.


================================================================================
  ERWEITERBARKEIT
================================================================================

Das On-the-Fly Interface unterstützt aktuell Moving Averages, RS Rating und
Minervini Trend Template. Geplante Erweiterungen:

  - POST /features/bollinger   → Bollinger Bänder
  - POST /features/stochastic  → Stochastik %K / %D
  - POST /features/rsi         → Relative Strength Index

Die bestehende calculator.py enthält bereits die Berechnungslogik für
Bollinger und Stochastic — die Endpunkte müssen nur analog zu /features/ma
implementiert werden.
