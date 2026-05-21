import re

def fix_cco():
    with open("handbuch.html", "r", encoding="utf-8") as f:
        content = f.read()

    # Extract X-Integration section
    x_sync_pattern = re.compile(r'(<H3>8\.4 X-Integration:.*?</UL>\s*<H4>.*?</UL>\s*)<H3>8\.5', re.DOTALL)
    x_sync_match = x_sync_pattern.search(content)
    if not x_sync_match:
        print("X-Integration not found.")
        return
    x_sync_text = x_sync_match.group(1)

    # Extract Direct-Dump section
    dump_pattern = re.compile(r'(<H3>8\.6 Direct-Dump:.*?</P>\s*)<A NAME="sicherheit"></A>', re.DOTALL)
    dump_match = dump_pattern.search(content)
    if not dump_match:
        print("Direct-Dump not found.")
        return
    dump_text = dump_match.group(1)

    # Remove them from the original locations
    content = content.replace(x_sync_text, "")
    content = content.replace(dump_text, "")

    # Now create the CCO chapter
    cco_chapter = f"""<A NAME="cco"></A>
<H2>13. Der Chief Communications Officer (CCO)</H2>
<P>Der CCO ist für die externe Informationsbeschaffung und Kommunikation zuständig. Er interagiert primär mit der X-API (ehemals Twitter) und liefert dem System Echtzeit-Nachrichten und Sentiment-Analysen.</P>
{x_sync_text}
{dump_text}
"""
    # Replace H3 numbers inside cco_chapter
    cco_chapter = cco_chapter.replace("<H3>8.4", "<H3>13.1").replace("<H4>", "<H4>13.1.1").replace("<H3>8.6", "<H3>13.2")

    # Insert it right before PTA Minervini (which is <A NAME="minervini"></A>)
    content = content.replace('<A NAME="minervini"></A>', cco_chapter + '<A NAME="minervini"></A>')

    # Update the TOC
    # We need to add CCO to the TOC
    toc_insertion = '<LI><A HREF="#cco">Der Chief Communications Officer (CCO)</A></LI>\n<LI><A HREF="#minervini">'
    content = content.replace('<LI><A HREF="#minervini">', toc_insertion)

    with open("handbuch_cco_fix.html", "w", encoding="utf-8") as f:
        f.write(content)

if __name__ == "__main__":
    fix_cco()
