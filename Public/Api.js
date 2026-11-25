// Api.js - thin fetch wrapper for the search portal API (same origin, JSON only).
// Search terms are always sent in a POST body, never in the URL (Design.md §4-1).

// User-facing messages keyed by the error codes defined in Design.md §2-5
const ERROR_MESSAGES = {
  access_not_configured: '認証の設定が完了していません．管理者に連絡してください．',
  unauthorized: 'ログインが確認できません．ページを再読み込みしてください．',
  forbidden: 'このアカウントには閲覧権限がありません．',
  sheet_layout_changed: 'データベースの列構成が変わっています．管理者に連絡してください．',
  sheet_not_configured: 'データベースの設定が完了していません．管理者に連絡してください．',
  sheet_unavailable: 'データベースに接続できません．しばらくしてから再試行してください．',
  not_found: '該当する記録がありません．',
  bad_request: '検索条件の形式が正しくありません．',
  // Attachment delivery errors (Design.md §10-3)
  // Default wording without a folder name; errorMessage() names the folder once /api/meta reports one
  attachment_unavailable: '添付ファイルを開けません．ファイルが Google ドライブの共有フォルダにあり，サービスアカウントに共有されているか確認してください．',
  attachment_unsupported: 'この形式のファイルは表示できません（JPEG・PNG・WebP・PDF のみ）．HEIC は JPEG に変換して保存し直してください．',
  attachment_too_large: 'ファイルが大きすぎます（上限 20 MB）．縮小して保存し直してください．',
  // Client-side only: Access answered with a redirect to its login page (session expired or cookie missing)
  session_expired: 'ログインの有効期限が切れました．「ログインし直す」を押すと，ログイン画面に移ります．',
  // Client-side only: the request never reached the Worker
  network: 'サーバーに接続できません．通信環境を確認してから再試行してください．',
};

// Fallback code when the response body carries no recognizable code
function codeFromStatus(status) {
  // Map well-known HTTP statuses to the closest documented code
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'sheet_unavailable';
}

// Drive folder name for attachment errors, taken from /api/meta ('' = not configured)
let attachmentFolderName = '';

// Remember the configured Drive folder name (anything but a non-blank string clears it)
export function setAttachmentFolder(name) {
  attachmentFolderName = typeof name === 'string' ? name.trim() : '';
}

// Return the Japanese message for an error code (unknown codes fall back by family)
export function errorMessage(code) {
  // Name the configured folder so staff know exactly where to check (same text as the server)
  if (code === 'attachment_unavailable' && attachmentFolderName) {
    return `添付ファイルを開けません．ファイルが Google ドライブの「${attachmentFolderName}」フォルダにあり，共有されているか確認してください．`;
  }
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.sheet_unavailable;
}

// Error type carrying the API code, HTTP status and display message
export class ApiError extends Error {
  constructor(code, status) {
    // Store the display message as the Error message for convenience
    super(errorMessage(code));
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

// Pull an error code out of the many plausible JSON error shapes
function extractCode(body) {
  // Accept {error:"code"}, {error:{code}}, or {code}
  if (!body || typeof body !== 'object') return null;
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error.code === 'string') return body.error.code;
  if (typeof body.code === 'string') return body.code;
  return null;
}

// Core request helper: JSON in, JSON out, typed errors
async function request(path, { method = 'GET', body, signal } = {}) {
  // Build fetch options; credentials stay same-origin so Access cookies flow
  const init = {
    method,
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    // Never follow redirects: the only redirect here is Access sending an expired session to its login page
    // on another origin, which the page CSP (connect-src 'self') blocks and fetch reports as a network error
    redirect: 'manual',
    headers: { Accept: 'application/json' },
  };
  // Attach the JSON body for POST requests
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    // Perform the request
    response = await fetch(path, init);
  } catch (err) {
    // Let aborts propagate untouched so callers can ignore them
    if (err && err.name === 'AbortError') throw err;
    // Anything else (offline, DNS, connection reset) is a genuine network failure
    throw new ApiError('network', 0);
  }

  // A manual-mode redirect surfaces as an opaque response: the Access session has expired
  if (response.type === 'opaqueredirect') throw new ApiError('session_expired', 0);

  // A non-JSON answer usually means Access served its login page
  const contentType = response.headers.get('Content-Type') || '';
  const isJson = contentType.includes('application/json');

  // Parse the JSON body when present (tolerate empty or broken bodies)
  let data = null;
  if (isJson) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  // Translate failures into ApiError with the documented code
  if (!response.ok) {
    const code = extractCode(data) || codeFromStatus(response.status);
    throw new ApiError(code, response.status);
  }

  // A 200 that is not JSON means the session was bounced to a login page
  if (!isJson || data === null) {
    throw new ApiError('unauthorized', response.status);
  }

  // Success
  return data;
}

// POST /api/search with the Query object (Design.md §3-2) as the JSON body
export function search(query, signal) {
  return request('/api/search', { method: 'POST', body: query, signal });
}

// GET /api/records/:rowNumber - one full record plus sameNumberCount
export function getRecord(rowNumber, signal) {
  // rowNumber is numeric; coerce defensively so nothing else can be injected into the path
  const n = Number.parseInt(rowNumber, 10);
  return request(`/api/records/${encodeURIComponent(String(n))}`, { signal });
}

// GET /api/meta - totals, flagged count, available kinds/categories
export function getMeta(signal) {
  return request('/api/meta', { signal });
}

// GET /api/me - signed-in email and auth mode
export function getMe(signal) {
  return request('/api/me', { signal });
}

// ---------------------------------------------------------------------------
// Attachments (Design.md §10-3 / §10-7)
// ---------------------------------------------------------------------------

// HEAD status -> error code (a HEAD response has no body, so the status is all we get)
const ATTACHMENT_STATUS_CODES = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'attachment_unavailable',
  413: 'attachment_too_large',
  415: 'attachment_unsupported',
  503: 'sheet_unavailable',
};

// Content types the portal can render inline, mapped to the viewer kind
const ATTACHMENT_VIEWERS = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
};

// Same-origin URL of one Drive attachment (row number + index only; never a file id)
export function attachmentUrl(rowNumber, index) {
  // Coerce both parts to integers so nothing else can be injected into the path
  const row = Number.parseInt(rowNumber, 10);
  const idx = Number.parseInt(index, 10);
  return `/api/records/${encodeURIComponent(String(row))}/attachments/${encodeURIComponent(String(idx))}`;
}

// HEAD the attachment to learn whether it can be shown, without downloading it.
// Resolves to {ok:true, viewer:'image'|'pdf', mimeType} or {ok:false, code}; rejects only on abort.
export async function probeAttachment(rowNumber, index, signal) {
  let response;
  try {
    // Same credentials/cache policy as the JSON API
    response = await fetch(attachmentUrl(rowNumber, index), {
      method: 'HEAD',
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      // Same as the JSON API: a redirect means the Access session expired
      redirect: 'manual',
    });
  } catch (err) {
    // Aborts propagate so the caller can drop the result silently
    if (err && err.name === 'AbortError') throw err;
    return { ok: false, code: 'network' };
  }

  // An opaque redirect is Access bouncing an expired session to its login page
  if (response.type === 'opaqueredirect') return { ok: false, code: 'session_expired' };

  // Failures: translate the status into a documented code
  if (!response.ok) {
    return { ok: false, code: ATTACHMENT_STATUS_CODES[response.status] || (response.status >= 500 ? 'sheet_unavailable' : 'attachment_unavailable') };
  }

  // Success: decide the viewer from the normalized Content-Type (parameters stripped)
  const mimeType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  // An HTML 200 means Access bounced the session to its login page
  if (mimeType === 'text/html') return { ok: false, code: 'unauthorized' };
  const viewer = ATTACHMENT_VIEWERS[mimeType];
  if (!viewer) return { ok: false, code: 'attachment_unsupported' };
  return { ok: true, viewer, mimeType };
}
