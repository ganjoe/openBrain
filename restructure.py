import html
import re

def restructure():
    with open("handbuch.html", "r", encoding="utf-8") as f:
        content = f.read()
    
    # Unescape HTML entities
    content = html.unescape(content)
    
    # Ensure UTF-8 meta tag
    if '<meta charset="UTF-8">' not in content:
        content = content.replace('<HEAD>', '<HEAD>\n<meta charset="UTF-8">')
    
    # We will manually do the rearranging by breaking it into sections.
    # Actually, doing it via a script might be too error-prone for rearranging HTML headers and divs.
    # It's safer to just do the unescaping and UTF-8 tag with the script, and then I will use multi_replace_file_content or a template to rewrite the structure.
    
    with open("handbuch.html", "w", encoding="utf-8") as f:
        f.write(content)

if __name__ == "__main__":
    restructure()
