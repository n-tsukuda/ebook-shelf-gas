"""GitHub Pages 用のデモ（docs/）を src/ の画面から作る。

  python3 demo/build.py

- src/Shelf.html → docs/index.html（本棚）
- src/Viewer.html → docs/viewer.html（閲覧）
- samples/*.pdf → docs/samples/
GAS のテンプレート記法（include_ と boot）をここで展開し、
google.script.run の代わりに demo/shim.js を差し込む。PDFの登録（管理画面）はデモに含めない。
"""
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
DOCS = ROOT / 'docs'
DEMO = ROOT / 'demo'
APP_TITLE = '電子ブック本棚 デモ'


def include(name):
    return (SRC / f'{name}.html').read_text(encoding='utf-8')


def render(file, boot_js, books):
    html = include(file)
    html = re.sub(r"<\?!= include_\('(\w+)'\) \?>", lambda m: include(m.group(1)), html)
    html = html.replace('<?!= boot ?>', boot_js)
    if '<?' in html:
        raise SystemExit(f'{file}: 展開できないテンプレート記法が残っています')
    data = json.dumps(books, ensure_ascii=False).replace('<', '\\u003c')
    head = (
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
        f'<title>{APP_TITLE}</title>'
        f'<script>window.__DEMO_BOOKS__ = {data};</script>'
        f'<script>{(DEMO / "shim.js").read_text(encoding="utf-8")}</script>'
    )
    return html.replace('<head>', '<head>' + head, 1)


def main():
    books = json.loads((DEMO / 'books.json').read_text(encoding='utf-8'))
    DOCS.mkdir(exist_ok=True)

    shelf_boot = json.dumps({'execUrl': 'viewer.html', 'appTitle': APP_TITLE, 'adminUrl': ''}, ensure_ascii=False)
    (DOCS / 'index.html').write_text(render('Shelf', shelf_boot, books), encoding='utf-8')
    (DOCS / 'viewer.html').write_text(render('Viewer', 'window.__demoViewerBoot()', books), encoding='utf-8')

    out = DOCS / 'samples'
    out.mkdir(exist_ok=True)
    for b in books:
        shutil.copy2(ROOT / 'samples' / b['fileName'], out / b['fileName'])
        if not (DOCS / b['cover']).exists():
            raise SystemExit(f'表紙画像がありません: docs/{b["cover"]}')

    (DOCS / '.nojekyll').write_text('')   # GitHub Pages の Jekyll 処理を止める
    print('docs/index.html, docs/viewer.html を作りました（', len(books), '冊）')


if __name__ == '__main__':
    main()
