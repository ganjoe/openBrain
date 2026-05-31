# Requirements

| ID | Category | Title | Description | Covered By |
| :--- | :--- | :--- | :--- | :--- |
| F-API-010 | Trigger | API POST Trigger | Das System muss einen POST-Endpoint bereitstellen, über den der Feature-Berechnungsprozess manuell angestoßen werden kann. | - |
| F-SYS-030 | Concurrency | Job Overlap Protection | Wird ein neuer Berechnungsprozess getriggert, während ein Prozess noch läuft, muss der neue Aufruf abgewiesen werden (Skip/Drop). Ein Retrigger erfolgt erst, wenn alle Features berechnet sind. | - |
| F-PRC-040 | Processing | Config Parameter Extraction | Das System muss für die Berechnung ausschließlich fachliche Parameter (z.B. `type` wie SMA/EMA, `window`, `period`) aus der Datei `features.json` extrahieren und rein optische Parameter (z.B. `color`, `thickness`, `chart_type`) ignorieren. | - |
| F-PRC-045 | Processing | Dynamic Feature Mapping | Die zu berechnenden Indikatoren müssen zur Laufzeit basierend auf den extrahierten fachlichen Parametern auf die entsprechenden Berechnungs-Algorithmen (z.B. SMA vs EMA) gemappt werden. | - |
| F-PRC-047 | Processing | Feature Implementation Scope | Die Implementierung umfasst Moving Averages (SMA, EMA), Stochastik, IBD_RS sowie den Minervini Trend Template Score. | - |
| F-SYS-050 | Concurrency | Ticker Level Parallel Execution | Das System muss die Berechnungen parallel auf Ticker-Ebene (z.B. ein Worker pro Ticker) ausführen, um Multi-Core-Prozessoren auszulasten. | - |
| F-SYS-060 | Concurrency | Configurable Thread Count | Die maximale Anzahl der parallel genutzten Threads/Worker muss konfigurierbar sein. | - |
| F-INP-070 | Storage | Parquet Source Data | Der Prozess muss die Quelldaten für die Berechnungen aus existierenden Dateien im Pfad `/data/parquet/<ticker>/<timeframe>.parquet` laden. | - |
| F-OUT-080 | Storage | Parquet Target Overwrite | Die berechneten Features müssen vorerst per Overwrite-Verfahren unter dem Pfad `/data/parquet/<ticker>/<timeframe>_features.parquet` abgespeichert werden. | - |
| F-LOG-090 | Error | Terminal Error Logging | Schlägt die Berechnung für einen Ticker fehl, muss der Fehler ins Terminal geloggt werden, während der Prozess die übrigen Ticker weiter abarbeitet. | - |
| F-PRC-100 | Data | Backfill Missing Data | Wenn historische Daten für Indikatoren fehlen, muss das System künstliche Daten durch Rückwärts-Duplikation des ersten Tages erzeugen, sodass Indikatoren niemals Null/0 sind. | - |
| F-CFG-010 | Config | Aggregation Tagging | In der `features.json` können Indikatoren mit dem Parameter `"aggregation": "all"` markiert werden, um sie als aktienübergreifende Metriken zu kennzeichnen. | - |
| F-PRC-110 | Process | Globale Vorab-Berechnung | Markierte "aggregated"-Indikatoren werden in der Pre-Compute-Phase (Pass 0) aufgesammelt und global exakt einmal über den gesamten Marktdatensatz berechnet. | - |
| F-PRC-120 | Process | Globale Injektion | Die resultierende Zeitreihe der aggregierten Metriken wird in Pass 1 automatisiert als Spalte in die Parquet-Strukturen aller individuellen Ticker injiziert. | - |

| ID | Category | Title | Description | Covered By |
| :--- | :--- | :--- | :--- | :--- |
| F-SCN-010 | API | Scanner POST Endpoint | Das System muss einen REST API Endpoint (POST) bereitstellen, um einen Scanvorgang synchron für einen beliebigen Indikator zu starten. | - |
| F-SCN-020 | API | Multi-Condition Support | Der Scanner muss Bedingungen wie `higher`, `lower` und `range` unterstützen, um Ticker flexibel zu filtern. | - |
| F-SCN-030 | Data | Dynamic Indicator Source | Der Scanner nutzt den Namen des Indikators (`scanner_name`), um die entsprechende Spalte dynamisch in den Features-Parquet-Dateien zu finden. | - |
| F-SCN-040 | UX | Watchlist File Export | Das Ergebnis eines Scans muss im Verzeichnis `data/watchlists/` als `<scanner_name>.txt` gespeichert werden. Bestehende Dateien werden überschrieben. | - |
| F-SCN-050 | UX | Line-Separated Format | Die generierte Watchlist-Datei muss die Ticker-Namen strikt durch Zeilenumbrüche (Enter) getrennt enthalten. | - |
| F-SCN-060 | System | Atomic Scanner Export | Der Export der Scanner-Watchlist-Datei muss atomar erfolgen (Write-to-Temp + Rename), um Konflikte mit parallelen Lesezugriffen zu vermeiden. | - |

| ID | Category | Title | Description | Covered By |
| :--- | :--- | :--- | :--- | :--- |
| F-UX-010 | UI | Single HTML Index | Das System stellt eine einzige index.html bereit die alle API-Funktionen übersichtlich darstellt. | - |
| F-UX-020 | UI | HTML Form Triggers | API-Calls werden über einfache HTML-Formulare ausgelöst (kein JavaScript notwendig). | - |
| F-UX-030 | UI | Simple Parameter Inputs | Parameter wie scanner_name oder value werden über einfache Textfelder eingegeben. | - |
| F-UX-040 | UI | CSS Only Styling | Ein minimalistisches responsives Design wird über eine kleine CSS-Sektion im Header realisiert. | - |
| F-UX-050 | UI | Network Accessibility | Die Website und die API werden an 0.0.0.0 gebunden um im gesamten Netzwerk erreichbar zu sein. | - |
| F-UX-060 | UI | Relative API Paths | Formulare nutzen relative Pfade um hostunabhängig zu funktionieren. | - |
