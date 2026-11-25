// Render.js - DOM builders for rows, drawer, chips, popovers and states.
// Everything is built with createElement/textContent; data never touches innerHTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Flag colour -> short Japanese meaning (same semantics as the sheet colours)
export const FLAG_LABELS = { red: '判断不能', yellow: '推測', orange: '年齢不一致' };

// Placeholder shown for empty values
export const EMPTY_VALUE = '—';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

// Create an element with attributes, listeners and children
export function h(tag, props, ...children) {
  // Create the element itself
  const el = document.createElement(tag);
  // Apply every prop according to its kind
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      // Skip unset values so callers can pass conditionals inline
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  // Append children (strings become text nodes)
  appendChildren(el, children);
  return el;
}

// Append nested children, ignoring null/false and flattening arrays
function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else if (child instanceof Node) parent.append(child);
    else parent.append(document.createTextNode(String(child)));
  }
}

// Build an <svg><use href="Icons.svg#id"></svg> icon (decorative)
export function icon(name, extraClass = '') {
  // Outer svg carries the sizing class and is hidden from assistive tech
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // Reference the shared sprite
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `Icons.svg#${name}`);
  svg.append(use);
  return svg;
}

// Normalize any value to a trimmed string
export function str(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// Format an age value as "13歳" when it is a bare number
export function formatAge(age) {
  const s = str(age);
  if (!s) return '';
  return /^\d+$/.test(s) ? `${s}歳` : s;
}

// Shorten the vaccine kind for the dense list row
export function shortKind(kind) {
  const s = str(kind);
  return s === 'インフルエンザ' ? 'インフル' : s;
}

// Format an ISO date (YYYY-MM-DD) compactly for chip labels
export function compactDate(iso) {
  // Drop the year when it is the current year to keep chips short
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const sameYear = Number(m[1]) === new Date().getFullYear();
  const md = `${Number(m[2])}/${Number(m[3])}`;
  return sameYear ? md : `${m[1]}/${md}`;
}

// Flag dot with an accessible label (role=img so the colour has a text equivalent)
export function flagDot(level, { labelled = true } = {}) {
  // Ignore unknown levels
  if (!FLAG_LABELS[level]) return null;
  const dot = h('span', { class: `flag-dot flag-${level}` });
  // Expose the meaning as text for screen readers
  if (labelled) {
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', FLAG_LABELS[level]);
  } else {
    dot.setAttribute('aria-hidden', 'true');
  }
  return dot;
}

// ---------------------------------------------------------------------------
// Result list
// ---------------------------------------------------------------------------

// One result row: ul > li > button (Design.md §5-3)
export function renderRow(item, { selected = false, tabbable = false } = {}) {
  // Second line parts: visit date · kind · category · age (empty parts dropped)
  const metaParts = [str(item.visitDate), shortKind(item.kind), str(item.category), formatAge(item.age)].filter(Boolean);

  // Left column: name + furigana on line 1, metadata on line 2
  const main = h('span', { class: 'row-main' },
    h('span', { class: 'row-line1' },
      h('span', { class: 'row-name', text: str(item.name) || '（氏名なし）' }),
      str(item.furigana) ? h('span', { class: 'row-furigana', text: str(item.furigana) }) : null,
    ),
    h('span', { class: 'row-meta' }, metaParts.length ? metaParts.join(' · ') : EMPTY_VALUE),
  );

  // Right column: attachment clip, flag dot and management number
  const hasAttachments = Number(item.attachmentCount) > 0;
  // Paperclip sits left of the flag dot; the count is intentionally not shown (Design.md §10-7)
  const clip = hasAttachments
    ? h('span', { class: 'row-attachment', role: 'img', 'aria-label': '添付あり', title: '添付あり', 'data-testid': 'row-attachment-icon' }, icon('paperclip'))
    : null;
  const dot = item.flagLevel ? flagDot(item.flagLevel) : null;
  const aside = h('span', { class: 'row-aside' },
    // Clip and dot share one line so they stay together when the aside stacks on phones
    clip || dot ? h('span', { class: 'row-marks' }, clip, dot) : null,
    str(item.managementNumber) ? h('span', { class: 'row-number', text: `No.${str(item.managementNumber)}` }) : null,
  );

  // The row button carries stable E2E hooks and selection state
  const button = h('button', {
    type: 'button',
    class: 'row',
    'data-testid': 'result-row',
    'data-row-number': String(item.rowNumber),
    'aria-current': selected ? 'true' : null,
    tabindex: tabbable ? '0' : '-1',
  }, main, aside);

  return h('li', { class: 'row-item' }, button);
}

// Five row-shaped skeleton placeholders (no spinner)
export function renderSkeletonRows(count = 5) {
  const frag = document.createDocumentFragment();
  // Vary bar widths so the placeholder reads as real rows
  const widths = [[38, 22, 52], [30, 26, 46], [42, 18, 56], [34, 24, 44], [28, 20, 50]];
  for (let i = 0; i < count; i += 1) {
    const [a, b, c] = widths[i % widths.length];
    frag.append(h('div', { class: 'skeleton-row' },
      h('div', { class: 'skeleton-line1' },
        h('span', { class: `skeleton-bar w-${a}` }),
        h('span', { class: `skeleton-bar thin w-${b}` }),
      ),
      h('span', { class: `skeleton-bar thin w-${c}` }),
    ));
  }
  return frag;
}

// Zero-result state with the exact copy from Design.md §5-3
export function renderEmpty({ onClear, hasConditions }) {
  return h('div', { class: 'empty-inner' },
    h('span', { class: 'empty-icon' }, icon('empty')),
    // Two block spans keep the exact sentence as textContent while breaking cleanly between sentences
    h('p', { class: 'empty-text', 'data-testid': 'zero-result' },
      h('span', { class: 'empty-lead', text: '該当する記録がありません．' }),
      h('span', { text: '空白やハイフンの有無，ひらがな／カタカナは区別しません．' })),
    hasConditions
      ? h('button', { type: 'button', class: 'button secondary', 'data-testid': 'empty-clear', onclick: onClear }, '絞り込みを解除')
      : null,
  );
}

// Error banner content (message + optional action)
export function renderErrorContent({ message, actionLabel, onAction }) {
  return [
    icon('alert', 'error-icon'),
    h('p', { class: 'error-text', text: message }),
    actionLabel
      ? h('button', { type: 'button', class: 'button ghost small', 'data-testid': 'error-action', onclick: onAction }, icon('refresh'), actionLabel)
      : null,
  ];
}

// Compact page list with ellipses: 1 … 4 5 6 … 12
function pageWindow(page, totalPages) {
  // Show everything when there are few pages
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set([1, totalPages, page - 1, page, page + 1]);
  // Keep the window wide enough near the edges
  if (page <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (page >= totalPages - 2) [totalPages - 1, totalPages - 2, totalPages - 3].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  // Insert ellipsis markers where pages are skipped
  const out = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('…');
    out.push(p);
  });
  return out;
}

// Pagination controls (bottom only; first/last disable the arrows)
export function renderPagination({ page, totalPages, onGo }) {
  const frag = document.createDocumentFragment();
  // Previous page arrow
  frag.append(h('button', {
    type: 'button', class: 'page-button page-arrow', 'data-testid': 'pagination-prev',
    'aria-label': '前のページ', disabled: page <= 1, onclick: () => onGo(page - 1),
  }, icon('chevron-left')));
  // Numbered pages
  for (const p of pageWindow(page, totalPages)) {
    if (p === '…') {
      frag.append(h('span', { class: 'page-ellipsis', 'aria-hidden': 'true', text: '…' }));
      continue;
    }
    frag.append(h('button', {
      type: 'button', class: 'page-button', 'data-testid': 'pagination-page', 'data-page': String(p),
      'aria-label': `${p}ページ目`, 'aria-current': p === page ? 'page' : null,
      onclick: () => onGo(p),
    }, String(p)));
  }
  // Next page arrow
  frag.append(h('button', {
    type: 'button', class: 'page-button page-arrow', 'data-testid': 'pagination-next',
    'aria-label': '次のページ', disabled: page >= totalPages, onclick: () => onGo(page + 1),
  }, icon('chevron-right')));
  return frag;
}

// ---------------------------------------------------------------------------
// Filter chips and popovers
// ---------------------------------------------------------------------------

// Render the chip row. Each model: {key, label, activeLabel, active, kind:'popover'|'toggle', mobileHidden, count}
export function renderChips(models, { onOpen, onClear, onToggle, onClearAll, anyActive }) {
  const frag = document.createDocumentFragment();
  for (const m of models) {
    // Wrapper lets an active chip hold two sibling buttons (main + clear) without nesting
    const wrap = h('span', {
      class: `chip${m.active ? ' is-active' : ''}${m.mobileHidden && !m.active ? ' mobile-hidden' : ''}`,
      'data-chip': m.key,
    });
    if (m.kind === 'toggle') {
      // Toggle chip (要確認のみ) uses aria-pressed
      wrap.append(h('button', {
        type: 'button', class: 'chip-main', 'data-testid': `chip-${m.key}`, 'aria-pressed': m.active ? 'true' : 'false',
        onclick: () => onToggle(m.key),
      },
      m.active ? icon('check', 'chip-check') : h('span', { class: 'chip-flag-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'chip-label', text: m.label }),
      Number.isFinite(m.count) ? h('span', { class: 'chip-count', text: String(m.count), 'aria-label': `${m.count}件` }) : null));
    } else if (m.kind === 'static') {
      // Static chip (管理番号 from the drawer link): label only, removable
      wrap.append(h('span', { class: 'chip-main chip-static', 'data-testid': `chip-${m.key}`, text: m.activeLabel }));
      wrap.append(h('button', {
        type: 'button', class: 'chip-clear', 'data-testid': `chip-${m.key}-clear`,
        'aria-label': `${m.label}の絞り込みを解除`, title: '解除',
        onclick: () => onClear(m.key),
      }, icon('close')));
    } else {
      // Popover chip opens its editor and shows the applied value
      const main = h('button', {
        type: 'button', class: 'chip-main', 'data-testid': `chip-${m.key}`,
        'aria-haspopup': 'dialog', 'aria-expanded': 'false',
        onclick: (e) => onOpen(m.key, e.currentTarget),
      },
      h('span', { class: 'chip-label', text: m.active ? m.activeLabel : m.label }),
      icon('chevron-down', 'chip-caret'));
      wrap.append(main);
      // Active chips get an explicit "× 解除" button
      if (m.active) {
        wrap.append(h('button', {
          type: 'button', class: 'chip-clear', 'data-testid': `chip-${m.key}-clear`,
          'aria-label': `${m.label}の絞り込みを解除`, title: '解除',
          onclick: () => onClear(m.key),
        }, icon('close')));
      }
    }
    frag.append(wrap);
  }
  // "Clear all" link appears only when something is applied
  if (anyActive) {
    frag.append(h('button', {
      type: 'button', class: 'chips-clear-all', 'data-testid': 'chip-clear-all', onclick: onClearAll,
    }, '絞り込みを解除'));
  }
  return frag;
}

// Single-select option list (種別 / 区分)
export function renderOptionList({ title, options, current, onPick }) {
  // Options are plain buttons with aria-pressed; arrow keys are wired by App.js
  const list = h('div', { class: 'option-list', role: 'group', 'aria-label': title },
    options.map((opt) => h('button', {
      type: 'button', class: 'option', 'data-testid': 'popover-option', 'data-value': opt.value,
      'aria-pressed': opt.value === current ? 'true' : 'false',
      onclick: () => onPick(opt.value),
    },
    h('span', { class: 'option-label', text: opt.label }),
    opt.value === current ? icon('check', 'option-check') : null)),
  );
  return h('div', { class: 'popover-inner' }, h('p', { class: 'popover-title', text: title }), list);
}

// From/to field pair for dates or ages. Returns {el, read, validate, focusFirst}
export function renderRangeFields({ idPrefix, title, type, fromLabel, toLabel, from, to, unit }) {
  // Shared attributes for the two inputs
  const isNumber = type === 'number';
  const common = isNumber
    ? { type: 'number', inputmode: 'numeric', min: '0', max: '150', step: '1', class: 'field-input' }
    : { type: 'date', class: 'field-input' };
  // Build each labelled input
  const fromInput = h('input', { ...common, id: `${idPrefix}-from`, 'data-testid': `${idPrefix}-from` });
  const toInput = h('input', { ...common, id: `${idPrefix}-to`, 'data-testid': `${idPrefix}-to` });
  fromInput.value = from ?? '';
  toInput.value = to ?? '';
  // Inline validation message (announced when shown)
  const error = h('p', { class: 'field-error', role: 'alert', hidden: true });

  const el = h('fieldset', { class: 'range-fields' },
    h('legend', { class: 'range-legend', text: title }),
    h('div', { class: 'range-row' },
      h('label', { class: 'field', for: `${idPrefix}-from` },
        h('span', { class: 'field-label', text: fromLabel }),
        h('span', { class: 'field-control' }, fromInput, unit ? h('span', { class: 'field-unit', text: unit }) : null)),
      h('span', { class: 'range-sep', 'aria-hidden': 'true', text: '〜' }),
      h('label', { class: 'field', for: `${idPrefix}-to` },
        h('span', { class: 'field-label', text: toLabel }),
        h('span', { class: 'field-control' }, toInput, unit ? h('span', { class: 'field-unit', text: unit }) : null)),
    ),
    error,
  );

  // Read the current values as trimmed strings
  const read = () => ({ from: fromInput.value.trim(), to: toInput.value.trim() });

  // Validate: numbers must be whole and from <= to
  const validate = () => {
    const { from: f, to: t } = read();
    let message = '';
    if (isNumber) {
      if ((f && !/^\d{1,3}$/.test(f)) || (t && !/^\d{1,3}$/.test(t))) message = '年齢は0以上の整数で入力してください．';
      else if (f && t && Number(f) > Number(t)) message = '下限が上限を超えています．';
    } else if ((fromInput.validity && fromInput.validity.badInput) || (toInput.validity && toInput.validity.badInput)) {
      message = '日付の形式が正しくありません．';
    } else if (f && t && f > t) {
      message = '開始日が終了日より後になっています．';
    }
    // Show or hide the message
    error.textContent = message;
    error.hidden = !message;
    return !message;
  };

  return { el, read, validate, focusFirst: () => fromInput.focus() };
}

// Popover wrapper around a range field pair with clear/apply buttons
export function renderRangePopover({ fields, onApply, onClear }) {
  return h('div', { class: 'popover-inner' },
    fields.el,
    h('div', { class: 'popover-actions' },
      h('button', { type: 'button', class: 'button ghost small', 'data-testid': 'popover-clear', onclick: onClear }, 'クリア'),
      h('button', { type: 'button', class: 'button primary small', 'data-testid': 'popover-apply', onclick: onApply }, '適用'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

// Drawer field layout per section (Design.md §5-3: 基本情報/連絡先/接種/公費関連/備考)
const SECTIONS = [
  { title: '基本情報', fields: [
    { key: 'managementNumber', label: '管理番号' },
    { key: 'kind', label: '種別' },
    { key: 'category', label: '区分' },
    { key: 'visitDate', label: '受診日' },
    { key: 'birthDate', label: '生年月日' },
    // Sex column inserted right after 生年月日 on the sheet (filled for 公費 rows only)
    { key: 'gender', label: '性別' },
    { key: 'age', label: '年齢' },
    // Left/right column, right after 年齢 on the sheet (entered by staff)
    { key: 'side', label: '左右' },
  ] },
  { title: '連絡先', fields: [
    { key: 'postalCode', label: '郵便番号' },
    { key: 'phone', label: '電話番号' },
    { key: 'address', label: '住所', wide: true },
    { key: 'guardianName', label: '保護者署名', wide: true },
  ] },
  { title: '接種', fields: [
    { key: 'desiredVaccine', label: '希望ワクチン', wide: true },
    { key: 'temperature', label: '体温' },
    { key: 'lotNumber', label: 'LOT No.' },
  ] },
  { title: '公費関連', fields: [
    { key: 'disability6064', label: '60～64歳の方', wide: true },
    { key: 'copayExemption', label: '自己負担免除対象者', wide: true },
  ] },
];

// Sheet header names, used as a fallback when flags are keyed by Japanese column names
const HEADER_BY_KEY = {
  category: '区分', managementNumber: '管理番号', kind: '種別', visitDate: '受診日', name: '氏名', furigana: 'ふりがな',
  birthDate: '生年月日', gender: '性別', age: '年齢', side: '左右', guardianName: '保護者署名', postalCode: '郵便番号', address: '住所', phone: '電話番号',
  desiredVaccine: '希望ワクチン', temperature: '体温', lotNumber: 'LOT No.', disability6064: '60～64歳の方', copayExemption: '自己負担免除対象者',
};

// Look up the flag colour for a field, tolerating either key style
export function flagFor(record, key) {
  const flags = (record && record.flags) || {};
  return flags[key] || flags[HEADER_BY_KEY[key]] || null;
}

// Flag annotation next to a value: dot (labelled) + visible short text
function flagNote(level) {
  if (!FLAG_LABELS[level]) return null;
  // The dot carries the accessible name, so the visible word is hidden from AT to avoid double reading
  return h('span', { class: `field-flag flag-text-${level}` },
    flagDot(level),
    h('span', { class: 'field-flag-text', 'aria-hidden': 'true', text: FLAG_LABELS[level] }),
  );
}

// Strip a phone number to characters valid in a tel: URI
function telHref(phone) {
  const digits = phone.replace(/[^\d+]/g, '');
  return digits ? `tel:${digits}` : null;
}

// Value cell for one field, with special handling for phone/address/management number
function renderValue(record, field, handlers) {
  const raw = str(record[field.key]);
  // Empty values render as a dash
  if (!raw) return h('span', { class: 'value-empty', text: EMPTY_VALUE });

  // Phone: tel: link (dials on mobile)
  if (field.key === 'phone') {
    const href = telHref(raw);
    if (href) {
      return h('a', { class: 'phone-link', href, 'data-testid': 'phone-link', 'aria-label': `${raw} に発信` }, icon('phone'), h('span', { text: raw }));
    }
  }

  // Address: text plus a copy button
  if (field.key === 'address') {
    return h('span', { class: 'value-with-action' },
      h('span', { class: 'value-text', text: raw }),
      h('button', {
        type: 'button', class: 'button ghost small copy-button', 'data-testid': 'copy-address',
        'aria-label': '住所をコピー', onclick: () => handlers.onCopy(raw, '住所'),
      }, icon('copy'), h('span', { class: 'copy-label', text: 'コピー' })),
    );
  }

  // Management number: "同番号 N件" link when other rows share it
  if (field.key === 'managementNumber') {
    const count = Number(record.sameNumberCount) || 0;
    return h('span', { class: 'value-with-action' },
      h('span', { class: 'value-text tnum', text: raw }),
      count > 1
        ? h('button', {
          type: 'button', class: 'link-button', 'data-testid': 'same-number-link',
          onclick: () => handlers.onSameNumber(raw),
        }, `同番号 ${count}件`)
        : null,
    );
  }

  // Age: append 歳 for bare numbers
  if (field.key === 'age') return h('span', { class: 'value-text tnum', text: formatAge(raw) });

  // Default: plain text
  return h('span', { class: 'value-text', text: raw });
}

// Drawer header: name (+flag), furigana (+flag), row badge, close button
export function renderDrawerHeader(record, { onClose }) {
  const nameFlag = flagFor(record, 'name');
  const furiganaFlag = flagFor(record, 'furigana');
  return h('header', { class: 'drawer-header' },
    h('div', { class: 'drawer-handle', 'aria-hidden': 'true' }),
    h('div', { class: 'drawer-titles' },
      h('h2', { class: 'drawer-title', id: 'drawer-title', tabindex: '-1' },
        h('span', { text: str(record.name) || '（氏名なし）' }),
        nameFlag ? flagNote(nameFlag) : null),
      h('p', { class: 'drawer-sub' },
        str(record.furigana) ? h('span', { class: 'drawer-furigana', text: str(record.furigana) }) : null,
        furiganaFlag ? flagNote(furiganaFlag) : null,
        h('span', { class: 'row-badge', text: `行 ${record.rowNumber}` })),
    ),
    h('button', {
      type: 'button', class: 'icon-button drawer-close', 'data-testid': 'drawer-close', 'aria-label': '閉じる', title: '閉じる (Esc)', onclick: onClose,
    }, icon('close')),
  );
}

// Drawer body: attachments (when present), five sections and the legend
export function renderDrawerBody(record, handlers) {
  const frag = document.createDocumentFragment();
  // Attachments come first: staff compare the paper original against the transcribed values (Design.md §10-7)
  const attachments = renderAttachmentsSection(record, handlers);
  if (attachments) frag.append(attachments);
  // Field sections
  for (const section of SECTIONS) {
    const id = `section-${section.title}`;
    const dl = h('dl', { class: 'fields' },
      section.fields.map((field) => {
        const level = flagFor(record, field.key);
        return h('div', { class: `field-item${field.wide ? ' wide' : ''}${level ? ` has-flag flag-bg-${level}` : ''}`, 'data-field': field.key },
          h('dt', { class: 'field-name', text: field.label }),
          h('dd', { class: 'field-value' }, renderValue(record, field, handlers), level ? flagNote(level) : null),
        );
      }),
    );
    frag.append(h('section', { class: 'detail-section', 'aria-labelledby': id },
      h('h3', { class: 'detail-heading', id, text: section.title }), dl));
  }
  // Notes section (free text written by staff; null means the column is absent)
  const note = str(record.note);
  frag.append(h('section', { class: 'detail-section', 'aria-labelledby': 'section-note' },
    h('h3', { class: 'detail-heading', id: 'section-note', text: '備考' }),
    note ? h('p', { class: 'note-text', text: note }) : h('p', { class: 'value-empty', text: EMPTY_VALUE })));
  // Legend, always shown at the end
  frag.append(renderLegend());
  return frag;
}

// Colour legend for the flag dots
export function renderLegend() {
  return h('footer', { class: 'legend', 'aria-label': '凡例' },
    h('span', { class: 'legend-title', text: '凡例' }),
    Object.entries(FLAG_LABELS).map(([level, label]) => h('span', { class: 'legend-item' },
      flagDot(level, { labelled: false }), h('span', { text: label }))),
  );
}

// Skeleton for the drawer body while the record loads
export function renderDrawerSkeleton() {
  const frag = document.createDocumentFragment();
  // Three placeholder sections
  for (let s = 0; s < 3; s += 1) {
    frag.append(h('div', { class: 'detail-section skeleton-section', 'aria-hidden': 'true' },
      h('span', { class: 'skeleton-bar thin w-20' }),
      h('div', { class: 'skeleton-fields' },
        Array.from({ length: 4 }, () => h('div', { class: 'skeleton-field' },
          h('span', { class: 'skeleton-bar thin w-30' }), h('span', { class: 'skeleton-bar w-70' }))))));
  }
  return frag;
}

// Error message inside the drawer (e.g. not_found)
export function renderDrawerError(message) {
  return h('div', { class: 'drawer-error', role: 'alert', 'data-testid': 'drawer-error' }, icon('alert', 'error-icon'), h('p', { text: message }));
}

// ---------------------------------------------------------------------------
// Attachments (Design.md §10-7)
// ---------------------------------------------------------------------------

// Fallback caption when an attachment arrives without a label
const ATTACHMENT_FALLBACK_LABEL = '添付ファイル';

// Visible caption for an attachment (source column, e.g. 「氏名のリンク」)
export function attachmentLabel(att) {
  return str(att && att.label) || ATTACHMENT_FALLBACK_LABEL;
}

// Accept only absolute https URLs for outbound links (defence in depth; the Worker already drops others)
export function safeHttpsUrl(url) {
  try {
    // Parse strictly and reject every other scheme (javascript:, data:, http: ...)
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// Hostname shown for external links ("www." trimmed for readability)
function displayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Small caption line: icon + source label
function attachmentCaption(att, iconName) {
  return h('p', { class: 'attachment-caption' },
    icon(iconName, 'attachment-caption-icon'),
    h('span', { class: 'attachment-caption-text', text: attachmentLabel(att) }));
}

// Link that opens in a new tab without leaking the opener or the referrer
function newTabLink(href, props, ...children) {
  return h('a', { ...props, href, target: '_blank', rel: 'noopener noreferrer' },
    ...children,
    h('span', { class: 'visually-hidden', text: '（新しいタブで開きます）' }));
}

// External (non-Drive) link row: never proxied, just opened in a new tab
function renderExternalAttachment(att) {
  const href = safeHttpsUrl(att.url);
  // A link the Worker should have dropped: show the caption only
  if (!href) return [attachmentCaption(att, 'external')];
  const host = displayHost(href);
  return [newTabLink(href, { class: 'attachment-external', 'data-testid': 'attachment-external' },
    h('span', { class: 'attachment-external-icon', 'aria-hidden': 'true' }, icon('external')),
    h('span', { class: 'attachment-external-text' },
      h('span', { class: 'attachment-external-title', text: host ? `外部リンク（${host}）` : '外部リンク' }),
      h('span', { class: 'attachment-external-sub', text: attachmentLabel(att) })),
    icon('chevron-right', 'attachment-external-chevron'))];
}

// Placeholder for a Drive attachment while the HEAD probe is in flight
function renderPendingAttachment(att) {
  return [
    // Neutral frame; the shimmer only fades in after 200ms (pure CSS, see .is-pending)
    h('div', { class: 'attachment-frame is-pending', 'aria-hidden': 'true' }),
    attachmentCaption(att, 'paperclip'),
  ];
}

// Attachments section placed above 基本情報; returns null when the record has none
export function renderAttachmentsSection(record) {
  const list = Array.isArray(record && record.attachments) ? record.attachments : [];
  if (!list.length) return null;
  // One list item per attachment; Drive items start pending and are filled by App.js after the probe
  const items = list.map((att) => {
    const isDrive = att.kind === 'drive';
    return h('li', {
      class: 'attachment-item',
      'data-testid': 'attachment-item',
      'data-kind': isDrive ? 'pending' : 'external',
      'data-index': String(Number.parseInt(att.index, 10)),
    }, isDrive ? renderPendingAttachment(att) : renderExternalAttachment(att));
  });
  return h('section', { class: 'detail-section attachments-section', 'data-testid': 'attachments-section', 'aria-labelledby': 'section-attachments' },
    h('h3', { class: 'detail-heading', id: 'section-attachments' },
      h('span', { text: '添付ファイル' }),
      list.length > 1 ? h('span', { class: 'section-count', text: `${list.length}件` }) : null),
    h('ul', { class: 'attachment-list' }, items));
}

// Image thumbnail button; click/Enter opens the lightbox
function renderImageAttachment(att, { url, onOpenImage, onImageError }) {
  const label = attachmentLabel(att);
  // alt is the source label only (no patient name, so screen readers do not add PII)
  const img = h('img', { class: 'attachment-thumb-img', alt: label, decoding: 'async' });
  const button = h('button', {
    type: 'button', class: 'attachment-thumb', 'data-testid': 'attachment-thumb',
    'aria-label': `添付画像を拡大（${label}）`,
  },
  img,
  h('span', { class: 'attachment-thumb-hint', 'aria-hidden': 'true' }, icon('expand'), h('span', { text: '拡大' })));
  // Reveal the image once decoded; until then the frame shows the delayed skeleton
  img.addEventListener('load', () => button.classList.add('is-loaded'), { once: true });
  // HEAD said OK but the body failed: fall back to the error card
  img.addEventListener('error', () => onImageError(), { once: true });
  // Open the lightbox from this thumbnail (focus returns here on close)
  button.addEventListener('click', () => onOpenImage({ url, label, trigger: button }));
  // Set src last so the listeners are attached before a cached image can fire load
  img.src = url;
  return [button, attachmentCaption(att, 'image')];
}

// Inline PDF viewer plus the "open in a new tab" link (the main path on iOS Safari)
function renderPdfAttachment(att, { url }) {
  const label = attachmentLabel(att);
  const frame = h('div', { class: 'attachment-pdf' });
  const iframe = h('iframe', { class: 'attachment-iframe', src: url, title: `${label}（PDF）`, 'data-testid': 'attachment-iframe' });
  // Drop the skeleton once the viewer has loaded
  iframe.addEventListener('load', () => frame.classList.add('is-loaded'), { once: true });
  frame.append(iframe);
  return [
    frame,
    h('div', { class: 'attachment-footer' },
      attachmentCaption(att, 'file'),
      newTabLink(url, { class: 'button ghost small attachment-open-tab', 'data-testid': 'attachment-open-tab' },
        icon('external'), h('span', { text: '新しいタブで開く' }))),
  ];
}

// Error card with the mapped message and a link to the original Drive URL
function renderErrorAttachment(att, { message }) {
  const href = safeHttpsUrl(att.url);
  return [h('div', { class: 'attachment-error', role: 'alert', 'data-testid': 'attachment-error' },
    h('span', { class: 'attachment-error-icon', 'aria-hidden': 'true' }, icon('alert')),
    h('div', { class: 'attachment-error-body' },
      h('p', { class: 'attachment-error-label', text: attachmentLabel(att) }),
      h('p', { class: 'attachment-error-text', text: message }),
      href
        ? newTabLink(href, { class: 'button secondary small attachment-drive-link', 'data-testid': 'attachment-drive-link' },
          icon('external'), h('span', { text: 'Google ドライブで開く' }))
        : null))];
}

// Replace a pending Drive item with its final viewer.
// outcome: {viewer:'image'|'pdf', url} or {error: message}
export function fillAttachmentItem(item, att, outcome, handlers = {}) {
  // Error card for any failed probe
  if (outcome.error) {
    item.dataset.kind = 'error';
    item.replaceChildren(...renderErrorAttachment(att, { message: outcome.error }));
    return;
  }
  // Image thumbnail (a later load failure downgrades it to the error card)
  if (outcome.viewer === 'image') {
    item.dataset.kind = 'image';
    item.replaceChildren(...renderImageAttachment(att, {
      url: outcome.url,
      onOpenImage: handlers.onOpenImage || (() => {}),
      onImageError: () => fillAttachmentItem(item, att, { error: handlers.imageErrorMessage || '' }, handlers),
    }));
    return;
  }
  // Inline PDF
  item.dataset.kind = 'pdf';
  item.replaceChildren(...renderPdfAttachment(att, { url: outcome.url }));
}

// Lightbox chrome: toolbar (caption, pixel size, actual-size toggle, close) and a scrollable stage
export function renderLightbox({ label, onToggleZoom, onClose }) {
  // Image element; clicking it toggles fit / actual size
  const img = h('img', { class: 'lightbox-img', alt: label, decoding: 'async', 'data-testid': 'lightbox-img' });
  const size = h('span', { class: 'lightbox-size' });
  const zoom = h('button', {
    type: 'button', class: 'lightbox-button', 'data-testid': 'lightbox-zoom', 'aria-pressed': 'false', title: '原寸で表示（もう一度押すと画面に合わせる）',
  }, icon('zoom-in'), h('span', { text: '原寸' }));
  const close = h('button', {
    type: 'button', class: 'lightbox-button lightbox-close', 'data-testid': 'lightbox-close', 'aria-label': '閉じる', title: '閉じる (Esc)',
  }, icon('close'));
  // The stage is focusable so arrow keys can scroll an actual-size image
  const stage = h('div', { class: 'lightbox-stage', tabindex: '0', role: 'group', 'aria-label': `${label}（矢印キーでスクロール）` },
    h('span', { class: 'lightbox-loading', 'aria-hidden': 'true' }), img);
  // Wire controls
  zoom.addEventListener('click', onToggleZoom);
  close.addEventListener('click', onClose);
  img.addEventListener('click', onToggleZoom);
  // Clicking the dark backdrop around the image closes
  stage.addEventListener('click', (e) => { if (e.target === stage) onClose(); });
  const toolbar = h('div', { class: 'lightbox-toolbar' },
    h('p', { class: 'lightbox-caption' }, icon('image', 'lightbox-caption-icon'), h('span', { class: 'lightbox-label', text: label }), size),
    h('div', { class: 'lightbox-actions' }, zoom, close));
  return { toolbar, stage, img, zoom, close, size };
}
