/**
 * 電子ブック作成・閲覧アプリ（Google Apps Script）
 *
 * 画面
 *   本棚     : （デプロイURL）
 *   閲覧     : （デプロイURL）?book=ブックID
 *   管理画面 : （デプロイURL）?page=admin&key=管理キー
 *
 * 保存先
 *   マイドライブ直下に「電子ブック」フォルダを自動作成し、
 *   PDF本体と管理シート（電子ブック管理）をその中に置く。
 *
 * 注意
 *   google.script.run からは末尾が「_」でないグローバル関数をだれでも呼べる。
 *   管理用の関数は必ず assertAdmin_() を通すこと。
 */

const APP_TITLE = '電子ブック本棚';
const FOLDER_NAME = '電子ブック';
const SHEET_NAME = 'books';
const MAX_UPLOAD_MB = 30;              // google.script.run で1回に送れる量の目安
const CHUNK_SIZE = 4 * 1024 * 1024;    // 閲覧時にPDFを分割して返すサイズ
const COVER_MAX_CHARS = 45000;         // 表紙画像(dataURL)はセルに直接入れる（上限50,000文字）

const COLS = ['id', 'title', 'fileId', 'fileName', 'size', 'pageCount', 'direction',
  'listed', 'allowDownload', 'cover', 'views', 'createdAt', 'updatedAt'];

// ─────────────────────────────── 画面 ───────────────────────────────

function doGet(e) {
  const p = (e && e.parameter) || {};
  const execUrl = ScriptApp.getService().getUrl();

  if (p.book) {
    const book = findBook_(p.book);
    if (!book) return render_('NotFound', { execUrl: execUrl }, 'ブックが見つかりません');
    countView_(book.id);
    return render_('Viewer', {
      execUrl: execUrl,
      book: toViewerMeta_(book),
      startPage: Number(p.p) || 1,
      fromShelf: p.open === '1',   // 本棚から開いたときは表紙をめくって見せる
    }, book.title);
  }

  if (p.page === 'admin') {
    const key = p.key || '';
    if (!isAdmin_(key)) return render_('NotFound', { execUrl: execUrl, message: '管理画面を開く権限がありません。' }, APP_TITLE);
    return render_('Admin', {
      execUrl: execUrl,
      key: key,
      maxUploadMb: MAX_UPLOAD_MB,
      coverMaxChars: COVER_MAX_CHARS,
      appTitle: APP_TITLE,
    }, '管理画面 - ' + APP_TITLE);
  }

  return render_('Shelf', {
    execUrl: execUrl,
    appTitle: APP_TITLE,
    adminUrl: isAdmin_(p.key || '') ? execUrl + '?page=admin' + (p.key ? '&key=' + encodeURIComponent(p.key) : '') : '',
  }, APP_TITLE);
}

function render_(file, boot, title) {
  const t = HtmlService.createTemplateFromFile(file);
  // </script> を閉じさせないよう < をエスケープして埋め込む
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ─────────────────────────── 閲覧者向けAPI ───────────────────────────

/** 本棚に並べるブック一覧（本棚に表示=ONのものだけ） */
function getShelf() {
  return readBooks_()
    .filter(function (b) { return b.listed; })
    .map(function (b) {
      return { id: b.id, title: b.title, pageCount: b.pageCount, cover: b.cover, createdAt: b.createdAt };
    });
}

/** PDF本体を CHUNK_SIZE ごとに base64 で返す。ブックIDからしか引けない（fileIdは受け付けない） */
function getPdfChunk(bookId, index) {
  const fileId = fileIdOf_(bookId);
  if (!fileId) throw new Error('ブックが見つかりません');
  const bytes = DriveApp.getFileById(fileId).getBlob().getBytes();
  const start = index * CHUNK_SIZE;
  if (start >= bytes.length) return '';
  return Utilities.base64Encode(bytes.slice(start, start + CHUNK_SIZE));
}

// ─────────────────────────── 管理者向けAPI ───────────────────────────

function adminList(key) {
  assertAdmin_(key);
  const execUrl = ScriptApp.getService().getUrl();
  return readBooks_().map(function (b) {
    b.url = execUrl + '?book=' + b.id;
    return b;
  });
}

/**
 * @param {string} key 管理キー
 * @param {{title:string, fileName:string, base64:string, pageCount:number,
 *          direction:string, listed:boolean, allowDownload:boolean, cover:string}} d
 */
function adminUpload(key, d) {
  assertAdmin_(key);
  if (!d || !d.base64) throw new Error('PDFが空です');

  const bytes = Utilities.base64Decode(d.base64);
  if (bytes.length > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(MAX_UPLOAD_MB + 'MBを超えるPDFは登録できません');

  const id = newId_();
  const fileName = String(d.fileName || 'book.pdf');
  const blob = Utilities.newBlob(bytes, 'application/pdf', fileName);
  const file = folder_().createFile(blob);
  file.setDescription('電子ブック ' + id);

  const now = new Date();
  const book = {
    id: id,
    title: String(d.title || fileName.replace(/\.pdf$/i, '')).slice(0, 200),
    fileId: file.getId(),
    fileName: fileName,
    size: bytes.length,
    pageCount: Number(d.pageCount) || 0,
    direction: d.direction === 'rtl' ? 'rtl' : 'ltr',
    listed: d.listed !== false,
    allowDownload: !!d.allowDownload,
    cover: safeCover_(d.cover),
    views: 0,
    createdAt: now,
    updatedAt: now,
  };

  withLock_(function () {
    sheet_().appendRow(COLS.map(function (c) { return book[c]; }));
  });
  return book.id;
}

/** タイトル・開き方向・本棚表示・ダウンロード可否・表紙を更新 */
function adminUpdate(key, id, fields) {
  assertAdmin_(key);
  const editable = ['title', 'direction', 'listed', 'allowDownload', 'cover'];
  withLock_(function () {
    const sh = sheet_();
    const row = rowOf_(sh, id);
    if (!row) throw new Error('ブックが見つかりません');
    editable.forEach(function (name) {
      if (!(name in fields)) return;
      let v = fields[name];
      if (name === 'title') v = String(v).slice(0, 200);
      if (name === 'direction') v = v === 'rtl' ? 'rtl' : 'ltr';
      if (name === 'listed' || name === 'allowDownload') v = !!v;
      if (name === 'cover') v = safeCover_(v);
      sh.getRange(row, COLS.indexOf(name) + 1).setValue(v);
    });
    sh.getRange(row, COLS.indexOf('updatedAt') + 1).setValue(new Date());
  });
  return true;
}

/** 管理シートから削除し、PDFはゴミ箱へ（30日間はドライブから復元できる） */
function adminDelete(key, id) {
  assertAdmin_(key);
  withLock_(function () {
    const sh = sheet_();
    const row = rowOf_(sh, id);
    if (!row) return;
    const fileId = sh.getRange(row, COLS.indexOf('fileId') + 1).getValue();
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch (err) { /* 既に手動で消されている */ }
    sh.deleteRow(row);
  });
  CacheService.getScriptCache().remove('f_' + id);
  return true;
}

// ─────────────────────────── エディタから実行 ───────────────────────────

/**
 * 初回に1度エディタから実行する。
 * 保存先フォルダと管理シートを作り、管理画面のURLをログに出す。
 * （戻り値を返さないので、閲覧者が google.script.run で呼んでもキーは漏れない）
 */
function setup() {
  const sh = sheet_();
  const url = ScriptApp.getService().getUrl() || '（未デプロイ：デプロイ後にもう一度 setup を実行してください）';
  Logger.log('保存先フォルダ: ' + folder_().getUrl());
  Logger.log('管理シート    : ' + sh.getParent().getUrl());
  Logger.log('本棚URL      : ' + url);
  Logger.log('管理画面URL  : ' + url + '?page=admin&key=' + adminKey_());
}

/** 管理キーを作り直す（管理画面URLが漏れたとき用）。新しいURLはログに出る */
function resetAdminKey() {
  PropertiesService.getScriptProperties().deleteProperty('ADMIN_KEY');
  setup();
}

// ─────────────────────────────── 内部処理 ───────────────────────────────

function isAdmin_(key) {
  if (key && key === adminKey_()) return true;
  // 自分（デプロイしたアカウント）でログインしていればキーなしでも管理者扱い。
  // 公開設定によってはメールが取れないため、キー付きURLを正とする。
  const me = Session.getEffectiveUser().getEmail();
  const user = Session.getActiveUser().getEmail();
  return !!user && user === me;
}

function assertAdmin_(key) {
  if (!isAdmin_(key)) throw new Error('管理者のみ実行できます');
}

function adminKey_() {
  const props = PropertiesService.getScriptProperties();
  let k = props.getProperty('ADMIN_KEY');
  if (!k) {
    k = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('ADMIN_KEY', k);
  }
  return k;
}

function folder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* 削除されていたら作り直す */ }
  }
  const folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function sheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  if (id) {
    try {
      const sh = SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
      if (sh) return sh;
    } catch (err) { /* 削除されていたら作り直す */ }
  }
  const ss = SpreadsheetApp.create('電子ブック管理');
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  const sh = ss.getSheets()[0].setName(SHEET_NAME);
  sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  props.setProperty('SHEET_ID', ss.getId());
  return sh;
}

function readBooks_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, COLS.length).getValues()
    .filter(function (r) { return r[0]; })
    .map(rowToBook_)
    .sort(function (a, b) { return b.createdAt < a.createdAt ? -1 : 1; });
}

function rowToBook_(r) {
  const b = {};
  COLS.forEach(function (c, i) { b[c] = r[i]; });
  b.id = String(b.id);
  b.title = String(b.title);
  b.size = Number(b.size) || 0;
  b.pageCount = Number(b.pageCount) || 0;
  b.views = Number(b.views) || 0;
  b.listed = b.listed === true || b.listed === 'TRUE';
  b.allowDownload = b.allowDownload === true || b.allowDownload === 'TRUE';
  // Date は google.script.run で返せないので文字列化する
  b.createdAt = b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt);
  b.updatedAt = b.updatedAt instanceof Date ? b.updatedAt.toISOString() : String(b.updatedAt);
  return b;
}

function findBook_(id) {
  if (!id) return null;
  const sh = sheet_();
  const row = rowOf_(sh, id);
  if (!row) return null;
  return rowToBook_(sh.getRange(row, 1, 1, COLS.length).getValues()[0]);
}

function rowOf_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

/** 閲覧中は分割取得で何度も呼ばれるので、ブックID→ファイルIDをキャッシュする */
function fileIdOf_(bookId) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('f_' + bookId);
  if (hit) return hit;
  const book = findBook_(bookId);
  if (!book) return '';
  cache.put('f_' + bookId, book.fileId, 21600);
  return book.fileId;
}

function toViewerMeta_(b) {
  return {
    id: b.id,
    title: b.title,
    fileName: b.fileName,
    size: b.size,
    pageCount: b.pageCount,
    direction: b.direction,
    allowDownload: b.allowDownload,
    cover: b.cover,
    chunkSize: CHUNK_SIZE,
    chunkCount: Math.max(1, Math.ceil(b.size / CHUNK_SIZE)),
  };
}

function countView_(id) {
  try {
    withLock_(function () {
      const sh = sheet_();
      const row = rowOf_(sh, id);
      if (!row) return;
      const cell = sh.getRange(row, COLS.indexOf('views') + 1);
      cell.setValue((Number(cell.getValue()) || 0) + 1);
    }, 2000);
  } catch (err) {
    // 閲覧数は取りこぼしてもよい（混雑時にロック待ちで閲覧を止めない）
  }
}

function safeCover_(v) {
  v = String(v || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(v)) return '';
  return v.length <= COVER_MAX_CHARS ? v : '';
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function withLock_(fn, timeoutMs) {
  const lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs || 10000);
  try { return fn(); } finally { lock.releaseLock(); }
}
