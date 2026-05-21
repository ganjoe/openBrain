import re

def main():
    with open("handbuch.html", "r", encoding="utf-8") as f:
        content = f.read()

    # Split the document into HEAD/intro, TOC, and chapters.
    # The TOC is between "<H2>Inhaltsverzeichnis</H2>" and "</OL>\n<HR>"
    toc_pattern = re.compile(r'(<H2>Inhaltsverzeichnis</H2>.*?<OL>)(.*?)(</OL>\s*<HR>)', re.DOTALL)
    
    # Extract the header part (everything before the first chapter, i.e., before <A NAME="architektur">)
    header_pattern = re.compile(r'^(.*?)<A NAME="architektur"></A>', re.DOTALL)
    header_match = header_pattern.search(content)
    header = header_match.group(1) if header_match else ""

    # Now we need to extract chapters. Let's find all <A NAME="..."></A> followed by <H2>
    chapter_splits = re.split(r'(<A NAME="[^"]+"></A>\s*<H2>.*?</H2>)', content)
    
    # chapter_splits[0] is the header.
    # The rest are in pairs: chapter_splits[1] is the chapter title tag, chapter_splits[2] is the content, etc.
    
    chapters = {}
    last_chapter_content = ""
    
    if len(chapter_splits) > 1:
        for i in range(1, len(chapter_splits), 2):
            title_tag = chapter_splits[i]
            chap_content = chapter_splits[i+1]
            
            # Extract NAME attribute
            name_match = re.search(r'<A NAME="([^"]+)"></A>', title_tag)
            name = name_match.group(1) if name_match else f"unknown_{i}"
            
            chapters[name] = {
                "title_tag": title_tag,
                "content": chap_content
            }

    # Now let's reorganize them into the two parts + Schlusswort
    
    # TEIL 1: Basis-System
    teil1_names = ["architektur", "db", "postgrest", "studio", "ollama", "gateway", "nexus", "mcp", "sicherheit", "wartung", "deployment"]
    
    # TEIL 2: Agenten
    teil2_names = ["bot", "minervini"] # "bot" has the general concepts + EA/CCO. "minervini" is PTA.
    
    # TEIL 3: Schluss
    teil3_names = ["fluss"]

    # Let's construct the new HTML
    new_html = header

    # We need to build a new TOC
    new_html = re.sub(r'<H2>Inhaltsverzeichnis</H2>.*?<OL>.*?</OL>\s*<HR>', '', new_html, flags=re.DOTALL)
    
    toc = "<H2>Inhaltsverzeichnis</H2>\n"
    toc += "<H3>TEIL I: DAS BASIS-SYSTEM</H3>\n<OL>\n"
    counter = 1
    
    def extract_h2_text(tag):
        m = re.search(r'<H2>(.*?)</H2>', tag)
        if m:
            text = m.group(1)
            # Remove leading numbers
            return re.sub(r'^\d+\.\s*', '', text)
        return "Unknown"

    for name in teil1_names:
        if name in chapters:
            title = extract_h2_text(chapters[name]["title_tag"])
            toc += f'<LI><A HREF="#{name}">{title}</A></LI>\n'
            chapters[name]["new_num"] = counter
            counter += 1
            
    toc += "</OL>\n<H3>TEIL II: DIE AGENTEN</H3>\n<OL>\n"
    for name in teil2_names:
        if name in chapters:
            title = extract_h2_text(chapters[name]["title_tag"])
            toc += f'<LI><A HREF="#{name}">{title}</A></LI>\n'
            chapters[name]["new_num"] = counter
            counter += 1

    toc += "</OL>\n<H3>TEIL III: ABSCHLUSS</H3>\n<OL>\n"
    for name in teil3_names:
        if name in chapters:
            title = extract_h2_text(chapters[name]["title_tag"])
            toc += f'<LI><A HREF="#{name}">{title}</A></LI>\n'
            chapters[name]["new_num"] = counter
            counter += 1
            
    toc += "</OL>\n<HR>\n"
    
    # Insert TOC before the first chapter
    new_html += toc

    # Now append chapters, updating their H2 and H3 numbers
    
    def update_chapter(name):
        if name not in chapters: return ""
        chap = chapters[name]
        new_num = chap["new_num"]
        
        # Replace H2 number
        new_title_tag = re.sub(r'(<H2>)\d+\.\s*', f'\\g<1>{new_num}. ', chap["title_tag"])
        
        # Replace H3 numbers (e.g. 1.1 -> new_num.1)
        content = chap["content"]
        content = re.sub(r'(<H3(?:.*?)>)\d+\.\d+', f'\\g<1>{new_num}.X', content) # Temporary placeholder
        
        # We need to sequentially number H3s
        h3_counter = 1
        def replace_h3(match):
            nonlocal h3_counter
            res = f'{match.group(1)}{new_num}.{h3_counter}'
            h3_counter += 1
            return res
            
        content = re.sub(r'(<H3(?:.*?)>)\d+\.X', replace_h3, content)
        
        # Same for H4
        # Since H4 are sub of H3, it is harder to do automatically without a real DOM parser, 
        # so we just replace the first number.
        content = re.sub(r'(<H4(?:.*?)>)\d+\.\d+\.\d+', f'\\g<1>{new_num}.X.Y', content)
        # We will leave H4 numbering out or let it be for now.
        content = re.sub(r'(<H4(?:.*?)>)\d+\.X\.Y', r'\g<1>', content) # Remove numbers from H4 to avoid mess
        
        return new_title_tag + content

    new_html += "<H1 style='color: #01579b; border-bottom: 2px solid #01579b;'>TEIL I: DAS BASIS-SYSTEM</H1>\n"
    for name in teil1_names:
        new_html += update_chapter(name)

    new_html += "<H1 style='color: #e65100; border-bottom: 2px solid #e65100;'>TEIL II: DIE AGENTEN</H1>\n"
    for name in teil2_names:
        new_html += update_chapter(name)

    new_html += "<H1 style='color: #2e7d32; border-bottom: 2px solid #2e7d32;'>TEIL III: ABSCHLUSS</H1>\n"
    for name in teil3_names:
        new_html += update_chapter(name)

    with open("handbuch_new.html", "w", encoding="utf-8") as f:
        f.write(new_html)

if __name__ == "__main__":
    main()
