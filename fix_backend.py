import re

def update_handbuch():
    with open("handbuch.html", "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Update TOC title
    content = content.replace("<H3>TEIL III: ABSCHLUSS</H3>", "<H3>TEIL III: BACKEND</H3>")
    
    # 2. Add Stock-Data-Node to TOC
    toc_insertion = '<LI><A HREF="#stockdatanode">Stock-Data-Node (IBKR Data Engine)</A></LI>\n</OL>'
    content = content.replace('<H3>TEIL III: BACKEND</H3>\n<OL>\n</OL>', f'<H3>TEIL III: BACKEND</H3>\n<OL>\n{toc_insertion}')

    # 3. Update body title
    content = content.replace("<H1 style='color: #2e7d32; border-bottom: 2px solid #2e7d32;'>TEIL III: ABSCHLUSS</H1>", "<H1 style='color: #2e7d32; border-bottom: 2px solid #2e7d32;'>TEIL III: BACKEND</H1>")

    # 4. Insert the new chapter content after the Teil III header
    stock_data_node_chapter = """
<A NAME="stockdatanode"></A>
<H2>15. Stock-Data-Node (IBKR Data Engine)</H2>
<P>Das <CODE>stock-data-node</CODE> Projekt (lokalisiert in <CODE>/home/daniel/stock-data-node</CODE>) fungiert als autarkes Backend für den massenhaften Download und die Verarbeitung von historischen und Live-Aktienkursen über das Interactive Brokers (IBKR) Gateway. Es speichert Marktdaten hochperformant im Parquet-Format.</P>

<H3>15.1 Architektur & Datei-Watcher</H3>
<P>Der Node läuft als Docker-Container im <CODE>host</CODE>-Netzwerk und verbindet sich direkt mit dem lokalen IB Gateway. Das primäre Interface für neue Ticker ist ein dateibasierter <B>File Watcher</B>:</P>
<UL>
<LI><B>Drop-in Download:</B> Werden Textdateien (z.B. <CODE>meine_ticker.txt</CODE>) mit Ticker-Symbolen in den <CODE>watch/</CODE> Ordner gelegt, liest das System diese sofort ein, verschiebt die Datei nach <CODE>watchlists/</CODE> und reiht die Ticker asynchron in die IBKR-Download-Warteschlange ein.</LI>
<LI><B>Automatische US-Klassifizierung:</B> Standardmäßig werden Ticker als US-Aktien (SMART, USD) behandelt. Europäische Aktien oder Aliasse (z.B. "google" zu "GOOGL") können über die <CODE>config/ticker_map.json</CODE> explizit gemappt werden.</LI>
</UL>

<H3>15.2 Fehlerbehandlung & Blacklisting</H3>
<P>Lehnt IBKR einen Ticker ab (z.B. aufgrund eines Tippfehlers), greift ein automatischer Schutzmechanismus:</P>
<UL>
<LI>Der Ticker wird auf eine Blacklist in <CODE>state/failed_ticker.json</CODE> geschrieben und in der Map als "SKIP" markiert.</LI>
<LI>Das System verschwendet bei künftigen Bulk-Downloads keine wertvollen API-Limits mehr auf diesen Ticker. Um ihn zu entsperren, muss er physisch aus der Blacklist-Datei gelöscht werden.</LI>
</UL>

<H3>15.3 API-Steuerung (Port 8002)</H3>
<P>Neben dem File-Watcher stellt der Node eine REST-API bereit, um Hintergrundprozesse manuell zu forcieren:</P>
<UL>
<LI><B>Staleness-Check:</B> Ein POST auf <CODE>/trigger-staleness</CODE> veranlasst das System, alle vorhandenen Parquet-Dateien auf Aktualität zu prüfen und fehlende Kerzen nachzuladen.</LI>
<LI><B>Feature-Berechnung:</B> Ein POST auf <CODE>/features/calculate</CODE> triggert die asynchrone Berechnung von technischen Indikatoren (RS-Line, Bollinger Bands, EMA) über den Datenstamm. Bei parallelen Anfragen blockt die API via <CODE>409 Conflict</CODE>.</LI>
</UL>

<H3>15.4 Performance Tuning & Concurrency</H3>
<P>Um das IBKR Gateway bei Bulk-Downloads nicht zum Absturz zu bringen, nutzt das System dynamisches Pacing:</P>
<UL>
<LI><B>Dynamic Semaphore Throttling:</B> Die Parallelität (<CODE>delayed_max_concurrent</CODE>, <CODE>live_max_concurrent</CODE>) in der <CODE>settings.json</CODE> reguliert die gleichzeitigen Requests. Bei Pacing-Fehlern durch IBKR drosselt der Node die Semaphoren selbstständig.</LI>
<LI><B>JVM Heap:</B> Für große Datenmengen wird vorausgesetzt, dass das IB Gateway mit mindestens 4 GB Heap (<CODE>JAVA_HEAP_SIZE=4096</CODE>) gestartet wird.</LI>
</UL>
"""
    
    # Let's replace the string directly
    teil3_header = "<H1 style='color: #2e7d32; border-bottom: 2px solid #2e7d32;'>TEIL III: BACKEND</H1>"
    content = content.replace(teil3_header, teil3_header + "\n" + stock_data_node_chapter)

    with open("handbuch_backend_fix.html", "w", encoding="utf-8") as f:
        f.write(content)
    print("Success")

if __name__ == "__main__":
    update_handbuch()
