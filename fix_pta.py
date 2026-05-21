import re

def main():
    with open("handbuch.html", "r", encoding="utf-8") as f:
        content = f.read()

    # Recovered PTA text
    pta_text = """<P>Der PTA ist primär ein hochrobuster Exekutions-Agent für das Trading, der <b>ergänzend</b> mit den strengen Risikomanagement-Regeln von Mark Minervini ausgestattet ist. Er führt nicht nur abstrakte Risiko-Validierungen durch, sondern orchestriert über seine Trading-Tools (z.B. <CODE>trade</CODE>, <CODE>list_active_positions</CODE>, <CODE>get_trade_history</CODE>) den kompletten Lifecycle von Trades direkt über Interactive Brokers.</P>

<H3>14.1 Event-Sourcing Datenmodell (Single Source of Truth)</H3>
<P>Die Datenbank-Architektur des PTA weicht radikal von traditionellen State-Machines ab. Anstatt den Status eines Trades (OPEN, CLOSED) in der Datenbank zu aktualisieren, speichert die Tabelle <CODE>pta_execution_log</CODE> ausschließlich atomare, unveränderliche Events (z.B. <CODE>ORDER_SUBMITTED</CODE>, <CODE>FILL</CODE>, <CODE>CANCEL</CODE>).</P>
<P>Der aktuelle Zustand eines Portfolios (Equity, Winrate, Active Positions) wird <B>on-the-fly</B> über aggregierende SQL-Views (<CODE>pta_active_positions</CODE>, <CODE>pta_portfolio_summary</CODE>) berechnet. Dieses Design garantiert mathematische Präzision und eliminiert "State-Drift" zwischen lokaler Datenbank und Broker.</P>

<H3>14.2 Die "Dumb MCP" + "Background Sync" Architektur</H3>
<P>Um das System für LLMs leicht wartbar und maximal ausfallsicher zu gestalten, ist die Ausführungslogik entkoppelt:</P>
<UL>
<LI><B>Das MCP Tool (<CODE>trade</CODE>):</B> Dient ausschließlich dazu, die "Absicht" (<CODE>ORDER_SUBMITTED</CODE>) in die Datenbank zu schreiben. Es kommuniziert <I>nicht</I> mit dem Broker. Dies hält den MCP-Server extrem schlank.</LI>
<LI><B>Der IBKR-Sync Prozess (<CODE>ibkr_sync.ts</CODE>):</B> Ein minimalistisches Hintergrund-Skript, das im Bot-Container läuft. Es pollt die Datenbank nach ausstehenden Orders, sendet sie über eine TCP-Socket-Verbindung (Port 4002) an den IB Gateway Container und schreibt asynchron empfangene Ausführungen (Fills) zurück in die Datenbank.</LI>
</UL>

<H3>14.3 Robustheit durch Idempotenz</H3>
<P>Der Sync-Prozess ist "Exactly-Once" garantiert. Jeder Fill vom Broker erhält eine eindeutige <CODE>broker_exec_id</CODE>. Durch einen <CODE>UNIQUE INDEX</CODE> in PostgreSQL kann das Sync-Skript bei einem Neustart blind historische Fills abfragen und in die Datenbank pushen, ohne dass es zu Duplikaten (Double-Counting) kommt.</P>

<H3>14.4 Live-Portfolio-Synchronisation von Interactive Brokers</H3>
<P>Wenn der Nutzer oder ein koordinierender Agent den Live-Status des Portfolios abfragt, wird das MCP-Tool <CODE>list_active_positions</CODE> aufgerufen. Um sicherzustellen, dass keine permanente Hintergrundlast oder ein ungewollter Live-Mirror läuft, wird das Portfolio rein auf Anfrage (On-Demand Snapshot) synchronisiert:</P>
<OL>
<LI><B>Refresh-Trigger:</B> Das MCP-Tool schreibt einen Kontroll-Event des Typs <CODE>REFRESH_REQUESTED</CODE> in das <CODE>pta_execution_log</CODE>.</LI>
<LI><B>Sync-Reaktion:</B> Das Hintergrund-Skript <CODE>ibkr_sync.ts</CODE> erkennt diesen Request im nächsten Durchlauf, setzt die Sync-Kennzeichnung und stößt einmalig <CODE>ib.reqPositions()</CODE> an.</LI>
<LI><B>Snapshot-Verarbeitung:</B> Eintreffende Positionen werden im Speicher gesammelt. Sobald das Event <CODE>EventName.positionEnd</CODE> signalisiert, dass der Snapshot vollständig ist, wird die Verbindung über <CODE>ib.cancelPositions()</CODE> sofort wieder beendet.</LI>
<LI><B>Speicherung & Bericht:</B> Die alte Tabelle <CODE>pta_ibkr_positions</CODE> wird geleert und mit dem neuen Snapshot überschrieben. Das MCP-Tool liest diese Daten nach einer Wartezeit von 1,5 Sekunden aus und gibt einen konsolidierten Bericht (Live-Broker-Status + lokal getrackte Trades) zurück.</LI>
</OL>

<H3>14.5 Multi-Währungs-Support & Live FX-Conversion</H3>
<P>Um ein globales Portfolio sauber analysieren zu können, implementiert der PTA ein dynamisches Multi-Währungs-Management:</P>
<UL>
<LI><B>Erfassung der Ursprungswährung:</B> Das Hintergrund-Skript <CODE>ibkr_sync.ts</CODE> liest beim Snapshot-Abruf die native Währung (<CODE>currency</CODE>) jeder Aktie von Interactive Brokers aus und persistiert diese in der <CODE>pta_ibkr_positions</CODE> Tabelle.</LI>
<LI><B>Dynamische Umrechnung (Frankfurter API):</B> Anstatt Wechselkurse aufwändig intern zu cachen, führt das <CODE>list_active_positions</CODE> MCP-Tool beim Aufruf einen On-the-fly Fetch zur <CODE>api.frankfurter.app</CODE> durch, um die tagesaktuellen Devisenkurse zu laden. Der Report listet anschließend sowohl den originalen Marktwert (z.B. USD) als auch das dynamisch berechnete Äquivalent in Euro auf. Dies erhält die Architektur schlank (kein Forex-Sync-Prozess nötig) und garantiert punktgenaue Live-Berichte für den Agenten.</LI>
</UL>

<H3>14.6 Generische Trade-Historie (Flexible MCP Tools)</H3>
<P>Das System-Design verhindert den Bau von spezialisierten "UI-Tools" für jede einzelne Tabellen-Anforderung. Stattdessen vertraut das Architekturmodell auf die Abstraktionsfähigkeit des LLMs:</P>
<UL>
<LI><B>Das `get_trade_history` Tool:</B> Dieses Werkzeug wurde generisch gestaltet. Wird eine spezifische <CODE>trade_id</CODE> übergeben, liefert es die atomaren Execution-Events dieses einen Trades. Lässt der Agent den Parameter jedoch leer, fungiert das Tool als Bulk-Daten-Provider: Es fragt den <CODE>pta_trade_history</CODE> View ab und liefert eine strukturierte Rohdaten-Liste aller geschlossenen Trades (inklusive Laufnummer, kumulierter Winrate, PnL) zurück.</LI>
<LI><B>Flexible Filterung:</B> Das Tool unterstützt optionale Zeit-Filter (<CODE>start_date</CODE>, <CODE>end_date</CODE>) sowie Index-Filter (<CODE>min_trade_index</CODE>, <CODE>max_trade_index</CODE>), um riesige Portfolios paginieren zu können. Dies befähigt den Agenten, exakt die gewünschten Epochen abzurufen und auf Wunsch beliebig (z.B. zeilenweise als Tabelle) für den Nutzer zu formatieren, ohne dass hierfür TypeScript-Code geändert werden muss.</LI>
</UL>

<H3>14.7 Offline Queuing & Local Cancel (Ausfallsicherheit)</H3>
<P>Der PTA ist so konzipiert, dass er auch bei Ausfällen des IB-Gateways voll funktionsfähig bleibt. Das System nutzt ein <B>Offline Queuing</B>:</P>
<UL>
<LI><B>Lokales Speichern:</B> Ist das IB-Gateway offline (Verbindungsabbruch zu Interactive Brokers), schlagen Order-Eingaben nicht hart fehl. Das Tool speichert die <CODE>ORDER_SUBMITTED</CODE>-Events lokal in <CODE>pta_execution_log</CODE> und weist den Agenten im Rückgabewert darauf hin, dass die Order "queued" ist und übermittelt wird, sobald das Gateway online geht.</LI>
<LI><B>Erkennung unbestätigter Orders:</B> Der Agent warnt proaktiv, wenn für einen Ticker bereits Orders in der Warteschlange hängen, die vom Broker noch nicht durch eine ID bestätigt wurden (<CODE>broker_order_id IS NULL</CODE>).</LI>
<LI><B>Lokales Stornieren (Local Cancel):</B> Wenn eine Order noch lokal gequeued ist (unbestätigt) und der Agent ein <CODE>CANCEL</CODE> ausführt, wird die Order <B>lokal in der Datenbank storniert</B> (<CODE>broker_order_id</CODE> wird zu <CODE>CANCELLED</CODE>). Sie wird aus der Warteschlange entfernt und bei Reconnection des Gateways nicht mehr an den Broker übermittelt, was riskante "Geister-Orders" verhindert.</LI>
</UL>

<H3>14.8 Automatisierte Lifecycle Validierung (`validate_mcp.ts`)</H3>
<P>Um die Stabilität des Order-Lifecycles permanent zu gewährleisten, verfügt das System über das Deno-Skript <CODE>validate_mcp.ts</CODE>. Es testet den gesamten Flow auf MCP-Ebene:</P>
<UL>
<LI><B>Online Test:</B> Platziert eine Limit-Order weit unter dem Marktpreis, wartet auf den Sync-Bot, verifiziert die Order in den aktiven Broker-Positionen und storniert sie anschließend wieder sauber über die API.</LI>
<LI><B>Offline Test:</B> Das Skript nutzt die Nexus-REST-API (<CODE>POST /api/settings/ib_gateway/stop</CODE>), um das Gateway physisch zu trennen. Anschließend testet es das lokale Queuing, verifiziert die Offline-Warnungen und das lokale Stornieren. Abschließend startet es das Gateway wieder per API, wobei der Nutzer aufgerufen wird, ein eventuell erforderliches 2FA (Two-Factor Authentication) auf dem Smartphone zu bestätigen.</LI>
</UL>

<H3>14.9 Minervini Risk Management (ask_minervini)</H3>
"""

    # We will replace the <H2>13. Minervini Risk Management (PTA Agent)</H2> section.
    
    # First, let's change H2 to 14. Der Personal Trading Assistant (PTA)
    # Then append the recovered PTA text, and make the old Minervini text part of 14.9.
    
    old_minervini_start = '<A NAME="minervini"></A>\n<H2>13. Minervini Risk Management (PTA Agent)</H2>\n<P>Das System implementiert ein striktes, in Skripten hart-codiertes Risikomanagement'
    
    if old_minervini_start in content:
        new_pta_chapter = f'<A NAME="pta"></A>\n<A NAME="minervini"></A>\n<H2>14. Der Personal Trading Assistant (PTA)</H2>\n{pta_text}\n<P>Das System implementiert ein striktes, in Skripten hart-codiertes Risikomanagement'
        content = content.replace(old_minervini_start, new_pta_chapter)
        
        # Now fix the H3 numbers inside Minervini
        content = content.replace('<H3>13.1 Die Datenbank-Parameter</H3>', '<H3>14.9.1 Die Datenbank-Parameter</H3>')
        content = content.replace('<H3>13.2 Der Entscheidungsfluss (Solver-Logik)</H3>', '<H3>14.9.2 Der Entscheidungsfluss (Solver-Logik)</H3>')
        content = content.replace('<H3>13.3 Live-Kurse via IBKR & Yahoo Finance</H3>', '<H3>14.9.3 Live-Kurse via IBKR & Yahoo Finance</H3>')
        content = content.replace('<H3>13.4 EU-Nummernformate</H3>', '<H3>14.9.4 EU-Nummernformate</H3>')
        
        # Also fix the TOC!
        # Current TOC: <LI><A HREF="#minervini">Minervini Risk Management (PTA Agent)</A></LI>
        toc_old = '<LI><A HREF="#minervini">Minervini Risk Management (PTA Agent)</A></LI>'
        toc_new = '<LI><A HREF="#pta">Der Personal Trading Assistant (PTA)</A></LI>'
        content = content.replace(toc_old, toc_new)
        
        with open("handbuch_pta_fix.html", "w", encoding="utf-8") as f:
            f.write(content)
        print("Success")
    else:
        print("Old minervini start not found")

if __name__ == "__main__":
    main()
