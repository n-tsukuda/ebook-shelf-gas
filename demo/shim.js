// GitHub Pages のデモ用：GAS の google.script.run / history を、静的ファイルで置き換える。
// demo/build.py がビルド時に BOOKS を埋め込み、各ページの <head> 先頭に差し込む。
(function () {
  const BOOKS = window.__DEMO_BOOKS__;
  const find = id => BOOKS.find(b => b.id === id);

  const api = {
    getShelf() {
      return BOOKS.map(b => ({ id: b.id, title: b.title, pageCount: b.pageCount, cover: b.cover, createdAt: b.createdAt }));
    },
    // GAS 版は4MBずつ返すが、デモは chunkCount=1 にしてファイル全体を一度に返す
    async getPdfChunk(id) {
      const b = find(id);
      if (!b) throw new Error('ブックが見つかりません');
      const blob = await fetch(b.file).then(r => {
        if (!r.ok) throw new Error('PDFを取得できませんでした（' + r.status + '）');
        return r.blob();
      });
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1]);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
    },
  };

  function makeRunner(ok, ng) {
    return new Proxy({}, {
      get(_, fn) {
        if (fn === 'withSuccessHandler') return h => makeRunner(h, ng);
        if (fn === 'withFailureHandler') return h => makeRunner(ok, h);
        return (...args) => {
          if (!api[fn]) { if (ng) ng(new Error('デモ版では使えない機能です')); return; }
          Promise.resolve().then(() => api[fn](...args)).then(r => ok && ok(r), e => ng && ng(e));
        };
      },
    });
  }

  window.google = {
    script: {
      run: makeRunner(null, null),
      history: {
        replace(_, params) {
          try { history.replaceState(null, '', '?' + new URLSearchParams(params)); } catch (e) { /* 失敗しても閲覧には影響しない */ }
        },
      },
    },
  };

  /** viewer.html の BOOT を URL から組み立てる（GAS 版では doGet が行う処理） */
  window.__demoViewerBoot = function () {
    const q = new URLSearchParams(location.search);
    const b = find(q.get('book'));
    if (!b) {
      location.replace('./');
      throw new Error('book not found');
    }
    return {
      execUrl: location.origin + location.pathname,   // 共有用URL（viewer.html?book=…）
      homeUrl: './',
      startPage: Number(q.get('p')) || 1,
      fromShelf: q.get('open') === '1',
      book: {
        id: b.id, title: b.title, fileName: b.fileName, size: 0, pageCount: b.pageCount,
        direction: b.direction, allowDownload: b.allowDownload, cover: b.cover,
        chunkSize: 0, chunkCount: 1,
      },
    };
  };

  // 本棚の下に「デモ版」の注記を出す
  window.addEventListener('DOMContentLoaded', () => {
    const footer = document.querySelector('body.paper footer');
    if (!footer) return;
    const note = document.createElement('p');
    note.style.cssText = 'margin:14px 0 0;font-size:13px;color:var(--ink-2);line-height:1.8';
    note.innerHTML = 'これはデモ版です。PDFの登録は、Google Apps Script に設置すると使えます。<br><a href="https://github.com/n-tsukuda/ebook-shelf-gas">GitHub でコードを見る</a>';
    footer.appendChild(note);
  });
})();
