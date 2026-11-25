// App.js - state management, event wiring and keyboard handling for the search portal.
// Search terms live only in memory and in POST bodies: no URL params, no history entries, no storage.

import * as api from './Api.js';
import {
  h, renderRow, renderSkeletonRows, renderEmpty, renderErrorContent, renderPagination,
  renderChips, renderOptionList, renderRangeFields, renderRangePopover,
  renderDrawerHeader, renderDrawerBody, renderDrawerSkeleton, renderDrawerError, compactDate, icon,
  fillAttachmentItem, renderLightbox,
} from './Render.js';

// ---------------------------------------------------------------------------
// Constants and DOM references
// ---------------------------------------------------------------------------

// Page size fixed by the design (50 per page)
const PAGE_SIZE = 50;
// Debounce for typing (ms)
const DEBOUNCE_MS = 250;
// Show the skeleton only when a request takes longer than this (ms)
const SKELETON_DELAY_MS = 200;
// Must match the CSS motion duration (plus a little slack) so hidden is applied after the slide-out
const MOTION_MS = 170;
// localStorage key for the theme preference (the only thing ever stored)
const THEME_KEY = 'theme';

// Default option lists when /api/meta is unavailable
const DEFAULT_KINDS = ['インフルエンザ', 'コロナ'];
const DEFAULT_CATEGORIES = ['任意', '公費'];

// Cache the DOM nodes declared in index.html
const $ = (id) => document.getElementById(id);
const el = {
  email: $('user-email'),
  themeSwitch: $('theme-switch'),
  searchInput: $('search-input'),
  searchClear: $('search-clear'),
  filterSheetButton: $('filter-sheet-button'),
  filterSheetBadge: $('filter-sheet-badge'),
  chips: $('chips'),
  results: $('results'),
  resultsTitle: $('results-title'),
  resultCount: $('result-count'),
  resultRange: $('result-range'),
  sortSelect: $('sort-select'),
  staleNotice: $('stale-notice'),
  errorBanner: $('error-banner'),
  listPanel: $('list-panel'),
  list: $('result-list'),
  skeleton: $('skeleton'),
  empty: $('empty-state'),
  pagination: $('pagination'),
  scrim: $('scrim'),
  drawer: $('drawer'),
  filterSheet: $('filter-sheet'),
  popover: $('popover'),
  lightbox: $('lightbox'),
  toast: $('toast'),
};

// Reduced-motion preference (checked at call time so OS changes apply live)
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Narrow screens use overlays (scrim + scroll lock) instead of the side-by-side layout
const narrowScreen = window.matchMedia('(max-width: 899px)');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Empty query (all filter fields blank)
function emptyQuery(sort = 'visitDesc') {
  return {
    q: '', kind: '', category: '', managementNumber: '',
    visitFrom: '', visitTo: '', birthFrom: '', birthTo: '',
    ageMin: '', ageMax: '', flagged: false, sort, page: 1,
  };
}

// Single source of truth for the page
const state = {
  query: emptyQuery(),
  results: null, // last successful search response
  error: null, // last ApiError (or null)
  meta: null, // /api/meta response
  selectedRow: null, // rowNumber highlighted in the list
};

// In-flight request bookkeeping
const searchCtl = { controller: null, seq: 0, debounceTimer: null, skeletonTimer: null };
// Drawer bookkeeping
const drawerState = { open: false, rowNumber: null, returnRow: null, controller: null, closeTimer: null };
// Popover bookkeeping
const popoverState = { key: null, anchor: null };
// Filter sheet bookkeeping
const sheetState = { open: false, closeTimer: null, fields: null };
// Lightbox bookkeeping (trigger = thumbnail that receives focus back on close)
const lightboxState = { open: false, trigger: null, parts: null, actual: false, closeTimer: null };

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

// Filter keys other than the free-text query
const FILTER_KEYS = ['kind', 'category', 'managementNumber', 'visitFrom', 'visitTo', 'birthFrom', 'birthTo', 'ageMin', 'ageMax'];

// True when any filter (not the free text) is applied
function hasFilters() {
  return FILTER_KEYS.some((k) => state.query[k] !== '') || state.query.flagged;
}

// True when any condition (free text or filter) is applied
function hasConditions() {
  return state.query.q.trim() !== '' || hasFilters();
}

// Build the POST body (Query object, Design.md §3-2), omitting empty fields
function buildRequestBody() {
  const q = state.query;
  const body = { sort: q.sort, page: q.page, pageSize: PAGE_SIZE };
  // Free text
  if (q.q.trim()) body.q = q.q.trim();
  // Exact / partial string filters and date ranges
  for (const key of ['kind', 'category', 'managementNumber', 'visitFrom', 'visitTo', 'birthFrom', 'birthTo']) {
    if (q[key]) body[key] = q[key];
  }
  // Numeric age range
  if (q.ageMin !== '') body.ageMin = Number(q.ageMin);
  if (q.ageMax !== '') body.ageMax = Number(q.ageMax);
  // Flagged-only toggle
  if (q.flagged) body.flagged = true;
  return body;
}

// Human label for a date range chip
function dateRangeLabel(from, to) {
  if (from && to) return `${compactDate(from)}–${compactDate(to)}`;
  if (from) return `${compactDate(from)}以降`;
  return `${compactDate(to)}以前`;
}

// Human label for the age range chip
function ageRangeLabel(min, max) {
  if (min !== '' && max !== '') return min === max ? `${min}歳` : `${min}–${max}歳`;
  if (min !== '') return `${min}歳以上`;
  return `${max}歳以下`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Schedule a debounced search (typing)
function scheduleSearch() {
  clearTimeout(searchCtl.debounceTimer);
  searchCtl.debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
}

// Run a search now, aborting any previous request
async function runSearch() {
  // Cancel pending debounce and in-flight request
  clearTimeout(searchCtl.debounceTimer);
  if (searchCtl.controller) searchCtl.controller.abort();
  const controller = new AbortController();
  searchCtl.controller = controller;
  const seq = ++searchCtl.seq;

  // Show the skeleton only if the response is slow
  clearTimeout(searchCtl.skeletonTimer);
  searchCtl.skeletonTimer = setTimeout(() => {
    if (seq === searchCtl.seq) showSkeleton(true);
  }, SKELETON_DELAY_MS);
  el.results.setAttribute('aria-busy', 'true');

  try {
    // POST /api/search with the current query
    const data = await api.search(buildRequestBody(), controller.signal);
    // Ignore responses that were superseded
    if (seq !== searchCtl.seq) return;
    state.results = data;
    state.error = null;
  } catch (err) {
    // Aborted requests are expected when typing quickly
    if (err && err.name === 'AbortError') return;
    if (seq !== searchCtl.seq) return;
    state.results = null;
    state.error = err instanceof api.ApiError ? err : new api.ApiError('network', 0);
  } finally {
    // Only the latest request may clear the loading state
    if (seq === searchCtl.seq) {
      clearTimeout(searchCtl.skeletonTimer);
      showSkeleton(false);
      el.results.setAttribute('aria-busy', 'false');
    }
  }
  // Paint the outcome
  renderResults();
}

// Toggle the skeleton placeholder in place of the list
function showSkeleton(on) {
  if (on) {
    el.skeleton.replaceChildren(renderSkeletonRows(5));
    el.listPanel.hidden = false;
    el.skeleton.hidden = false;
    el.list.hidden = true;
    el.empty.hidden = true;
  } else {
    el.skeleton.hidden = true;
    el.skeleton.replaceChildren();
    el.list.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

// Paint heading, count, list, empty/error states and pagination from state
function renderResults() {
  // Heading: "最近の受診" for the initial empty query, otherwise "検索結果"
  el.resultsTitle.textContent = hasConditions() ? '検索結果' : '最近の受診';
  renderError();

  const data = state.results;
  // Error or no data yet: clear and hide the list area
  if (!data) {
    el.listPanel.hidden = true;
    el.resultCount.textContent = '';
    el.resultRange.textContent = '';
    el.list.replaceChildren();
    el.empty.hidden = true;
    el.pagination.hidden = true;
    el.staleNotice.hidden = true;
    return;
  }

  // Count and visible range
  el.listPanel.hidden = false;
  const total = Number(data.total) || 0;
  const page = Number(data.page) || 1;
  const pageSize = Number(data.pageSize) || PAGE_SIZE;
  const items = Array.isArray(data.items) ? data.items : [];
  el.resultCount.textContent = `${total.toLocaleString('ja-JP')}件`;
  el.resultRange.textContent = total > pageSize && items.length
    ? `${(page - 1) * pageSize + 1}–${(page - 1) * pageSize + items.length}件目`
    : '';

  // Rows (roving tabindex: only the selected or first row is tabbable)
  const tabbableRow = items.some((it) => it.rowNumber === state.selectedRow) ? state.selectedRow : items[0]?.rowNumber;
  el.list.replaceChildren(...items.map((item) => renderRow(item, {
    selected: item.rowNumber === state.selectedRow,
    tabbable: item.rowNumber === tabbableRow,
  })));

  // Zero-result state
  if (total === 0 || items.length === 0) {
    el.empty.replaceChildren(renderEmpty({ onClear: clearAll, hasConditions: hasConditions() }));
    el.empty.hidden = false;
  } else {
    el.empty.hidden = true;
    el.empty.replaceChildren();
  }

  // Pagination only when there is more than one page
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages > 1) {
    el.pagination.replaceChildren(renderPagination({ page, totalPages, onGo: goToPage }));
    el.pagination.hidden = false;
  } else {
    el.pagination.hidden = true;
    el.pagination.replaceChildren();
  }

  // Stale-data notice
  renderStale(data.meta);
}

// Error banner with the mapped message and a contextual action
// Surface an expired Access session in the page banner (no-op for other errors)
function showSessionExpired(err) {
  if (!err || err.code !== 'session_expired') return;
  state.error = err;
  renderError();
}

function renderError() {
  const err = state.error;
  if (!err) {
    el.errorBanner.hidden = true;
    el.errorBanner.replaceChildren();
    return;
  }
  // Pick the recovery action for the code
  let actionLabel = null;
  let onAction = null;
  if (err.code === 'session_expired') {
    // A full page load goes through Access, which shows its login page and returns here
    actionLabel = 'ログインし直す';
    onAction = () => window.location.reload();
  } else if (err.code === 'unauthorized') {
    actionLabel = '再読み込み';
    onAction = () => window.location.reload();
  } else if (err.code === 'sheet_unavailable' || err.code === 'network') {
    actionLabel = '再試行';
    onAction = () => runSearch();
  }
  el.errorBanner.replaceChildren(...renderErrorContent({ message: err.message, actionLabel, onAction }).filter(Boolean));
  el.errorBanner.hidden = false;
}

// "データは HH:MM 時点のものです" when the Worker served cached data
function renderStale(meta) {
  if (!meta || !meta.stale) {
    el.staleNotice.hidden = true;
    el.staleNotice.replaceChildren();
    return;
  }
  // Format fetchedAt in local time
  const at = meta.fetchedAt ? new Date(meta.fetchedAt) : null;
  const label = at && !Number.isNaN(at.getTime())
    ? at.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    : '不明な時刻';
  el.staleNotice.replaceChildren(icon('clock'), h('span', { text: `データは ${label} 時点のものです．` }));
  el.staleNotice.hidden = false;
}

// Move to another page and bring the heading into view
function goToPage(page) {
  state.query.page = page;
  runSearch().then(() => {
    // Scroll to the top of the list and focus the heading for screen readers
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    el.resultsTitle.focus({ preventScroll: true });
  });
}

// Reflect the selected row (accent bar) without re-rendering the list
function markSelected() {
  for (const btn of el.list.querySelectorAll('.row')) {
    const isSel = Number(btn.dataset.rowNumber) === state.selectedRow;
    if (isSel) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

// Find the summary item for a row number in the current results
function findItem(rowNumber) {
  const items = (state.results && state.results.items) || [];
  return items.find((it) => it.rowNumber === rowNumber) || null;
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

// Build the chip models from the current query
function chipModels() {
  const q = state.query;
  const models = [
    { key: 'kind', label: '種別', kind: 'popover', active: !!q.kind, activeLabel: `種別: ${q.kind}` },
    { key: 'category', label: '区分', kind: 'popover', active: !!q.category, activeLabel: `区分: ${q.category}` },
    { key: 'visit', label: '受診日', kind: 'popover', mobileHidden: true, active: !!(q.visitFrom || q.visitTo), activeLabel: `受診日: ${dateRangeLabel(q.visitFrom, q.visitTo)}` },
    { key: 'birth', label: '生年月日', kind: 'popover', mobileHidden: true, active: !!(q.birthFrom || q.birthTo), activeLabel: `生年月日: ${dateRangeLabel(q.birthFrom, q.birthTo)}` },
    { key: 'age', label: '年齢', kind: 'popover', mobileHidden: true, active: q.ageMin !== '' || q.ageMax !== '', activeLabel: `年齢: ${ageRangeLabel(q.ageMin, q.ageMax)}` },
    { key: 'flagged', label: '要確認のみ', kind: 'toggle', active: q.flagged, count: state.meta && Number.isFinite(state.meta.flagged) ? state.meta.flagged : undefined },
  ];
  // Management-number chip exists only while that filter is applied (set from the drawer link)
  if (q.managementNumber) {
    models.push({ key: 'managementNumber', label: '管理番号', kind: 'static', active: true, activeLabel: `管理番号: ${q.managementNumber}` });
  }
  return models;
}

// Re-render the chip row and the mobile filter badge
function renderChipRow() {
  el.chips.replaceChildren(renderChips(chipModels(), {
    onOpen: openPopover,
    onClear: clearFilter,
    onToggle: toggleFilter,
    onClearAll: clearAll,
    anyActive: hasFilters(),
  }));
  // Badge on the mobile sliders button counts applied date/age filters
  const q = state.query;
  const rangeCount = [q.visitFrom || q.visitTo, q.birthFrom || q.birthTo, q.ageMin !== '' || q.ageMax !== ''].filter(Boolean).length;
  el.filterSheetBadge.textContent = String(rangeCount);
  el.filterSheetBadge.hidden = rangeCount === 0;
  el.filterSheetButton.setAttribute('aria-label', rangeCount ? `日付・年齢で絞り込む（${rangeCount}件適用中）` : '日付・年齢で絞り込む');
}

// Focus a chip's main button after a re-render
function focusChip(key) {
  const btn = el.chips.querySelector(`[data-chip="${key}"] .chip-main`);
  if (btn && typeof btn.focus === 'function') btn.focus();
}

// Clear a single chip's condition
function clearFilter(key) {
  const q = state.query;
  if (key === 'visit') { q.visitFrom = ''; q.visitTo = ''; }
  else if (key === 'birth') { q.birthFrom = ''; q.birthTo = ''; }
  else if (key === 'age') { q.ageMin = ''; q.ageMax = ''; }
  else q[key] = key === 'flagged' ? false : '';
  // Apply and keep keyboard focus near the chip
  q.page = 1;
  renderChipRow();
  focusChip(key === 'managementNumber' ? 'kind' : key);
  runSearch();
}

// Toggle the flagged-only chip
function toggleFilter(key) {
  if (key !== 'flagged') return;
  state.query.flagged = !state.query.flagged;
  state.query.page = 1;
  renderChipRow();
  focusChip('flagged');
  runSearch();
}

// Clear every condition including the free text (sort is kept)
function clearAll() {
  state.query = emptyQuery(state.query.sort);
  el.searchInput.value = '';
  updateSearchClear();
  renderChipRow();
  runSearch();
  el.searchInput.focus();
}

// ---------------------------------------------------------------------------
// Popovers (chip editors)
// ---------------------------------------------------------------------------

// Open the editor for a chip, anchored under it
function openPopover(key, anchor) {
  // Clicking the open chip again closes it
  if (popoverState.key === key) {
    closePopover({ restoreFocus: true });
    return;
  }
  closePopover({ restoreFocus: false });
  const q = state.query;
  let content;
  let focusTarget = null;
  let title = '';

  if (key === 'kind' || key === 'category') {
    // Single-select list built from /api/meta (or defaults)
    title = key === 'kind' ? '種別' : '区分';
    const values = key === 'kind'
      ? (state.meta && Array.isArray(state.meta.kinds) && state.meta.kinds.length ? state.meta.kinds : DEFAULT_KINDS)
      : (state.meta && Array.isArray(state.meta.categories) && state.meta.categories.length ? state.meta.categories : DEFAULT_CATEGORIES);
    const options = [{ value: '', label: 'すべて' }, ...values.map((v) => ({ value: v, label: v }))];
    content = renderOptionList({
      title, options, current: q[key],
      onPick: (value) => {
        // Apply immediately and close
        q[key] = value;
        q.page = 1;
        closePopover({ restoreFocus: false });
        renderChipRow();
        focusChip(key);
        runSearch();
      },
    });
  } else {
    // Range editors: dates for visit/birth, numbers for age
    const spec = rangeSpec(key);
    title = spec.title;
    const fields = renderRangeFields({ idPrefix: `pop-${key}`, ...spec });
    content = renderRangePopover({
      fields,
      onApply: () => {
        // Validate, then write both ends back into the query
        if (!fields.validate()) return;
        const { from, to } = fields.read();
        writeRange(key, from, to);
        q.page = 1;
        closePopover({ restoreFocus: false });
        renderChipRow();
        focusChip(key);
        runSearch();
      },
      onClear: () => {
        // Clearing applies immediately
        writeRange(key, '', '');
        q.page = 1;
        closePopover({ restoreFocus: false });
        renderChipRow();
        focusChip(key);
        runSearch();
      },
    });
    focusTarget = fields.focusFirst;
  }

  // Show and position the popover
  el.popover.replaceChildren(content);
  el.popover.setAttribute('aria-label', title);
  el.popover.dataset.key = key;
  el.popover.hidden = false;
  popoverState.key = key;
  popoverState.anchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  positionPopover();

  // Enter applies inside range editors
  el.popover.addEventListener('keydown', onPopoverKeydown);

  // Move focus into the popover: selected option, first option, or first input
  if (focusTarget) focusTarget();
  else {
    const pressed = el.popover.querySelector('.option[aria-pressed="true"]') || el.popover.querySelector('.option');
    if (pressed) pressed.focus();
  }
}

// Range editor configuration per chip key
function rangeSpec(key) {
  const q = state.query;
  if (key === 'visit') return { title: '受診日', type: 'date', fromLabel: '開始日', toLabel: '終了日', from: q.visitFrom, to: q.visitTo };
  if (key === 'birth') return { title: '生年月日', type: 'date', fromLabel: '開始日', toLabel: '終了日', from: q.birthFrom, to: q.birthTo };
  return { title: '年齢', type: 'number', fromLabel: '下限', toLabel: '上限', from: q.ageMin, to: q.ageMax, unit: '歳' };
}

// Write a range back into the query by chip key
function writeRange(key, from, to) {
  const q = state.query;
  if (key === 'visit') { q.visitFrom = from; q.visitTo = to; }
  else if (key === 'birth') { q.birthFrom = from; q.birthTo = to; }
  else { q.ageMin = from; q.ageMax = to; }
}

// Keyboard inside the popover: arrows move between options, Enter applies ranges
function onPopoverKeydown(e) {
  const options = [...el.popover.querySelectorAll('.option')];
  if (options.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    // Cycle focus through the options
    e.preventDefault();
    const idx = options.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (idx + 1) % options.length : (idx - 1 + options.length) % options.length;
    options[next].focus();
  } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
    // Enter in an input behaves like the apply button
    e.preventDefault();
    const apply = el.popover.querySelector('[data-testid="popover-apply"]');
    if (apply) apply.click();
  }
}

// Place the popover under its anchor, clamped inside the viewport (16px gutter)
function positionPopover() {
  if (!popoverState.anchor || el.popover.hidden) return;
  const rect = popoverState.anchor.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  const width = el.popover.offsetWidth;
  // Clamp horizontally, then place 8px below the chip (fixed positioning via CSSOM is CSP-safe)
  const left = Math.max(16, Math.min(rect.left, viewport - width - 16));
  el.popover.style.left = `${Math.round(left)}px`;
  el.popover.style.top = `${Math.round(rect.bottom + 8)}px`;
}

// Close the popover (optionally returning focus to its chip)
function closePopover({ restoreFocus = true } = {}) {
  if (!popoverState.key) return;
  const { anchor, key } = popoverState;
  el.popover.removeEventListener('keydown', onPopoverKeydown);
  el.popover.hidden = true;
  el.popover.replaceChildren();
  delete el.popover.dataset.key;
  popoverState.key = null;
  popoverState.anchor = null;
  // Reset the chip's expanded state if it still exists
  if (anchor && anchor.isConnected) anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus) {
    if (anchor && anchor.isConnected) anchor.focus();
    else focusChip(key);
  }
}

// ---------------------------------------------------------------------------
// Mobile filter sheet (date/age conditions)
// ---------------------------------------------------------------------------

// Open the bottom sheet with the three range editors
function openFilterSheet() {
  closePopover({ restoreFocus: false });
  clearTimeout(sheetState.closeTimer);
  // Build the three range field groups from the current query
  const fields = {
    visit: renderRangeFields({ idPrefix: 'sheet-visit', ...rangeSpec('visit') }),
    birth: renderRangeFields({ idPrefix: 'sheet-birth', ...rangeSpec('birth') }),
    age: renderRangeFields({ idPrefix: 'sheet-age', ...rangeSpec('age') }),
  };
  sheetState.fields = fields;

  // Sheet layout: header, scrollable body, sticky footer
  el.filterSheet.replaceChildren(
    h('header', { class: 'sheet-header' },
      h('div', { class: 'drawer-handle', 'aria-hidden': 'true' }),
      h('h2', { class: 'sheet-title', id: 'filter-sheet-title', text: '日付・年齢で絞り込む' }),
      h('button', { type: 'button', class: 'icon-button', 'data-testid': 'filter-sheet-close', 'aria-label': '閉じる', onclick: () => closeFilterSheet() },
        icon('close'))),
    h('div', { class: 'sheet-body' }, fields.visit.el, fields.birth.el, fields.age.el),
    h('footer', { class: 'sheet-footer' },
      h('button', { type: 'button', class: 'button ghost', 'data-testid': 'filter-sheet-clear', onclick: clearSheetFilters }, 'クリア'),
      h('button', { type: 'button', class: 'button primary', 'data-testid': 'filter-sheet-apply', onclick: applySheetFilters }, '適用')),
  );

  // Show with the slide-up transition
  el.filterSheet.hidden = false;
  el.scrim.hidden = false;
  document.body.classList.add('sheet-open');
  void el.filterSheet.offsetWidth; // force layout so the transition runs
  el.filterSheet.classList.add('is-open');
  el.scrim.classList.add('is-visible');
  el.filterSheetButton.setAttribute('aria-expanded', 'true');
  sheetState.open = true;
  fields.visit.focusFirst();
}

// Apply all three ranges from the sheet
function applySheetFilters() {
  const { visit, birth, age } = sheetState.fields;
  // Validate every group (all messages shown at once)
  const ok = [visit.validate(), birth.validate(), age.validate()].every(Boolean);
  if (!ok) return;
  writeRange('visit', visit.read().from, visit.read().to);
  writeRange('birth', birth.read().from, birth.read().to);
  writeRange('age', age.read().from, age.read().to);
  state.query.page = 1;
  closeFilterSheet();
  renderChipRow();
  runSearch();
}

// Clear the three ranges and apply
function clearSheetFilters() {
  writeRange('visit', '', '');
  writeRange('birth', '', '');
  writeRange('age', '', '');
  state.query.page = 1;
  closeFilterSheet();
  renderChipRow();
  runSearch();
}

// Close the filter sheet and return focus to its button
function closeFilterSheet({ restoreFocus = true } = {}) {
  if (!sheetState.open) return;
  sheetState.open = false;
  el.filterSheet.classList.remove('is-open');
  el.filterSheetButton.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sheet-open');
  if (!drawerState.open) el.scrim.classList.remove('is-visible');
  // Hide after the slide-down finishes
  sheetState.closeTimer = setTimeout(() => {
    el.filterSheet.hidden = true;
    el.filterSheet.replaceChildren();
    if (!drawerState.open) el.scrim.hidden = true;
  }, reducedMotion.matches ? 0 : MOTION_MS);
  if (restoreFocus) el.filterSheetButton.focus();
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

// Open (or switch) the drawer for a list item
function openDetail(item) {
  const wasOpen = drawerState.open;
  // A lightbox from the previous record must not outlive it
  closeLightbox({ restoreFocus: false });
  // Abort any previous detail request
  if (drawerState.controller) drawerState.controller.abort();
  clearTimeout(drawerState.closeTimer);

  // Remember the originating row for focus return, and highlight it
  drawerState.rowNumber = item.rowNumber;
  drawerState.returnRow = item.rowNumber;
  state.selectedRow = item.rowNumber;
  markSelected();
  setRovingRow(item.rowNumber);

  // Render the header from the summary immediately, with a skeleton body
  el.drawer.replaceChildren(
    renderDrawerHeader(item, { onClose: () => closeDrawer() }),
    h('div', { class: 'drawer-body', 'data-testid': 'drawer-body' }, renderDrawerSkeleton()),
  );

  // Slide in when it was closed (no history entry is pushed)
  if (!wasOpen) {
    el.drawer.hidden = false;
    document.body.classList.add('drawer-open');
    if (narrowScreen.matches) {
      el.scrim.hidden = false;
    }
    void el.drawer.offsetWidth; // force layout so the transition runs
    el.drawer.classList.add('is-open');
    if (narrowScreen.matches) el.scrim.classList.add('is-visible');
    drawerState.open = true;
  }
  focusDrawerTitle();

  // Fetch the full record
  const controller = new AbortController();
  drawerState.controller = controller;
  api.getRecord(item.rowNumber, controller.signal).then((record) => {
    // Ignore stale responses
    if (controller.signal.aborted || drawerState.rowNumber !== item.rowNumber) return;
    const hadFocusInHeader = el.drawer.contains(document.activeElement);
    el.drawer.replaceChildren(
      renderDrawerHeader(record, { onClose: () => closeDrawer() }),
      h('div', { class: 'drawer-body', 'data-testid': 'drawer-body' }, renderDrawerBody(record, { onCopy: copyText, onSameNumber: filterBySameNumber })),
    );
    // Keep focus inside the dialog after the swap
    if (hadFocusInHeader || document.activeElement === document.body) focusDrawerTitle();
    // Probe and render Drive attachments (same lifetime as this detail request)
    hydrateAttachments(record, controller.signal);
  }).catch((err) => {
    // Show the mapped error inside the drawer
    if (err && err.name === 'AbortError') return;
    if (drawerState.rowNumber !== item.rowNumber) return;
    const body = el.drawer.querySelector('.drawer-body');
    if (body) body.replaceChildren(renderDrawerError(err instanceof api.ApiError ? err.message : api.errorMessage('network')));
    // An expired session also raises the page banner, which carries the re-login button
    showSessionExpired(err);
  });
}

// Focus the drawer heading (announced by screen readers as the dialog label)
function focusDrawerTitle() {
  const title = el.drawer.querySelector('#drawer-title');
  if (title) title.focus({ preventScroll: true });
}

// Close the drawer and return focus to the originating row
function closeDrawer({ restoreFocus = true } = {}) {
  if (!drawerState.open) return;
  drawerState.open = false;
  // The lightbox belongs to the drawer's record
  closeLightbox({ restoreFocus: false });
  if (drawerState.controller) drawerState.controller.abort();
  drawerState.controller = null;
  // Slide out, then hide
  el.drawer.classList.remove('is-open');
  document.body.classList.remove('drawer-open');
  if (!sheetState.open) el.scrim.classList.remove('is-visible');
  drawerState.closeTimer = setTimeout(() => {
    el.drawer.hidden = true;
    el.drawer.replaceChildren();
    if (!sheetState.open) el.scrim.hidden = true;
  }, reducedMotion.matches ? 0 : MOTION_MS);
  // Return focus to the row the drawer was opened from
  if (restoreFocus) {
    const row = el.list.querySelector(`.row[data-row-number="${drawerState.returnRow}"]`);
    if (row) row.focus();
    else el.searchInput.focus();
  }
  drawerState.rowNumber = null;
}

// "同番号 N件": filter the list by that management number
function filterBySameNumber(managementNumber) {
  closeDrawer({ restoreFocus: false });
  // Replace all conditions with the management number (keeps the sort)
  state.query = { ...emptyQuery(state.query.sort), managementNumber };
  el.searchInput.value = '';
  updateSearchClear();
  renderChipRow();
  runSearch().then(() => el.resultsTitle.focus());
}

// Copy text to the clipboard with a fallback, then confirm via the toast
async function copyText(text, label) {
  let ok = false;
  try {
    // Async Clipboard API (secure contexts)
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Fallback: temporary textarea + execCommand
    const ta = h('textarea', { class: 'clipboard-proxy', readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  showToast(ok ? `${label}をコピーしました．` : `${label}をコピーできませんでした．`);
}

// Show a short status message
let toastTimer = null;
function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2200);
}

// ---------------------------------------------------------------------------
// Attachments (Design.md §10-7)
// ---------------------------------------------------------------------------

// HEAD each Drive attachment, then swap its placeholder for the image / PDF / error card
function hydrateAttachments(record, signal) {
  const list = Array.isArray(record && record.attachments) ? record.attachments : [];
  const body = el.drawer.querySelector('.drawer-body');
  if (!body) return;
  for (const att of list) {
    // External links were rendered complete; only Drive items need the probe
    if (att.kind !== 'drive') continue;
    const index = Number.parseInt(att.index, 10);
    const item = body.querySelector(`[data-testid="attachment-item"][data-index="${index}"]`);
    if (!item) continue;
    // Shared handlers for the filled item
    const handlers = { onOpenImage: openLightbox, imageErrorMessage: api.errorMessage('sheet_unavailable') };
    api.probeAttachment(record.rowNumber, index, signal).then((result) => {
      // Drop results for a drawer that has moved on
      if (signal.aborted || !item.isConnected) return;
      const outcome = result.ok
        ? { viewer: result.viewer, url: api.attachmentUrl(record.rowNumber, index) }
        : { error: api.errorMessage(result.code) };
      // An expired session also raises the page banner with the re-login button
      if (!result.ok) showSessionExpired(new api.ApiError(result.code, 0));
      fillAttachmentItem(item, att, outcome, handlers);
    }).catch((err) => {
      // Aborts are expected when the drawer switches or closes
      if ((err && err.name === 'AbortError') || signal.aborted || !item.isConnected) return;
      fillAttachmentItem(item, att, { error: api.errorMessage('network') }, handlers);
    });
  }
}

// Open the full-screen viewer for an image thumbnail
function openLightbox({ url, label, trigger }) {
  // Replace any viewer that is still fading out
  clearTimeout(lightboxState.closeTimer);
  const parts = renderLightbox({ label, onToggleZoom: toggleLightboxZoom, onClose: () => closeLightbox() });
  lightboxState.parts = parts;
  lightboxState.trigger = trigger;
  lightboxState.actual = false;
  el.lightbox.classList.remove('is-actual', 'is-loaded', 'is-error');
  el.lightbox.setAttribute('aria-label', `添付画像（${label}）`);
  el.lightbox.replaceChildren(parts.toolbar, parts.stage);

  // Show the pixel size once decoded; the loading shimmer is hidden by .is-loaded
  parts.img.addEventListener('load', () => {
    el.lightbox.classList.add('is-loaded');
    parts.size.textContent = `${parts.img.naturalWidth} × ${parts.img.naturalHeight} px`;
  }, { once: true });
  // A failed download shows the generic message in place of the image
  parts.img.addEventListener('error', () => {
    el.lightbox.classList.add('is-error');
    parts.stage.replaceChildren(h('p', { class: 'lightbox-error', role: 'alert', text: api.errorMessage('sheet_unavailable') }));
  }, { once: true });
  parts.img.src = url;

  // Fade in (no history entry), lock the page scroll and move focus to the close button
  el.lightbox.hidden = false;
  document.body.classList.add('lightbox-open');
  void el.lightbox.offsetWidth; // force layout so the transition runs
  el.lightbox.classList.add('is-open');
  lightboxState.open = true;
  parts.close.focus();
}

// Toggle between fit-to-screen and actual pixels (clicking the image zooms toward that point)
function toggleLightboxZoom(e) {
  const parts = lightboxState.parts;
  if (!lightboxState.open || !parts) return;
  // Remember where on the image the click landed (0..1), defaulting to the centre
  let fx = 0.5;
  let fy = 0.5;
  if (e && e.currentTarget === parts.img && parts.img.clientWidth && parts.img.clientHeight) {
    fx = e.offsetX / parts.img.clientWidth;
    fy = e.offsetY / parts.img.clientHeight;
  }
  lightboxState.actual = !lightboxState.actual;
  el.lightbox.classList.toggle('is-actual', lightboxState.actual);
  parts.zoom.setAttribute('aria-pressed', lightboxState.actual ? 'true' : 'false');
  // In actual size, scroll so the clicked point (or the centre) sits in the middle of the stage
  if (lightboxState.actual) {
    const stage = parts.stage;
    stage.scrollLeft = Math.max(0, parts.img.offsetWidth * fx - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, parts.img.offsetHeight * fy - stage.clientHeight / 2);
  }
}

// Close the viewer and hand focus back to the thumbnail
function closeLightbox({ restoreFocus = true } = {}) {
  if (!lightboxState.open) return;
  lightboxState.open = false;
  el.lightbox.classList.remove('is-open');
  document.body.classList.remove('lightbox-open');
  // Hide after the fade-out, unless a new viewer was opened meanwhile
  lightboxState.closeTimer = setTimeout(() => {
    if (lightboxState.open) return;
    el.lightbox.hidden = true;
    el.lightbox.replaceChildren();
    lightboxState.parts = null;
  }, reducedMotion.matches ? 0 : MOTION_MS);
  // Return focus to the thumbnail that opened it
  const trigger = lightboxState.trigger;
  lightboxState.trigger = null;
  if (restoreFocus && trigger && trigger.isConnected) trigger.focus();
}

// ---------------------------------------------------------------------------
// List keyboard navigation
// ---------------------------------------------------------------------------

// Make exactly one row tabbable (roving tabindex)
function setRovingRow(rowNumber) {
  for (const btn of el.list.querySelectorAll('.row')) {
    btn.tabIndex = Number(btn.dataset.rowNumber) === rowNumber ? 0 : -1;
  }
}

// Move focus to a row by index (clamped)
function focusRowAt(index) {
  const rows = [...el.list.querySelectorAll('.row')];
  if (!rows.length) return;
  const target = rows[Math.max(0, Math.min(index, rows.length - 1))];
  setRovingRow(Number(target.dataset.rowNumber));
  target.focus();
}

// ---------------------------------------------------------------------------
// Focus trap for modal surfaces
// ---------------------------------------------------------------------------

// Keep Tab / Shift+Tab inside a container
function trapFocus(container, e) {
  const focusables = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
    .filter((node) => node.getClientRects().length > 0);
  // Nothing focusable: keep focus on the container's heading
  if (!focusables.length) {
    e.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const idx = focusables.indexOf(active);
  const inside = container.contains(active);
  // Wrap at both ends (the heading with tabindex=-1 counts as "before first")
  if (e.shiftKey && (idx <= 0 || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (idx === focusables.length - 1 || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

// ---------------------------------------------------------------------------
// Global keyboard handling
// ---------------------------------------------------------------------------

// True when the event target is a text-entry control
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

// Document-level shortcuts: /, Esc, arrows, Tab trap
function onGlobalKeydown(e) {
  // Ignore IME composition keystrokes (Japanese input)
  if (e.isComposing || e.keyCode === 229) return;

  // Esc: lightbox > popover > filter sheet > drawer > clear search
  if (e.key === 'Escape') {
    if (lightboxState.open) { e.preventDefault(); closeLightbox(); return; }
    if (popoverState.key) { e.preventDefault(); closePopover({ restoreFocus: true }); return; }
    if (sheetState.open) { e.preventDefault(); closeFilterSheet(); return; }
    if (drawerState.open) { e.preventDefault(); closeDrawer(); return; }
    if (el.searchInput.value) {
      e.preventDefault();
      el.searchInput.value = '';
      state.query.q = '';
      state.query.page = 1;
      updateSearchClear();
      el.searchInput.focus();
      runSearch();
    }
    return;
  }

  // Tab: trap inside the topmost modal surface
  if (e.key === 'Tab') {
    if (lightboxState.open) { trapFocus(el.lightbox, e); return; }
    if (popoverState.key) { trapFocus(el.popover, e); return; }
    if (sheetState.open) { trapFocus(el.filterSheet, e); return; }
    if (drawerState.open && (el.drawer.contains(document.activeElement) || narrowScreen.matches)) { trapFocus(el.drawer, e); }
    return;
  }

  // "/" focuses the search bar (unless typing somewhere or a modal is open)
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (isTypingTarget(e.target) || popoverState.key || sheetState.open || lightboxState.open) return;
    if (drawerState.open) closeDrawer({ restoreFocus: false });
    e.preventDefault();
    el.searchInput.focus();
    el.searchInput.select();
    return;
  }

  // Arrow keys / Home / End inside the result list
  const row = e.target instanceof HTMLElement ? e.target.closest('.row') : null;
  if (row && el.list.contains(row)) {
    const rows = [...el.list.querySelectorAll('.row')];
    const idx = rows.indexOf(row);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRowAt(idx + 1); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // From the first row, ArrowUp returns to the search bar
      if (idx === 0) el.searchInput.focus();
      else focusRowAt(idx - 1);
    } else if (e.key === 'Home') { e.preventDefault(); focusRowAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusRowAt(rows.length - 1); }
    return;
  }

  // ArrowDown from the search bar jumps into the list
  if (e.target === el.searchInput && e.key === 'ArrowDown') {
    const rows = el.list.querySelectorAll('.row');
    if (rows.length) {
      e.preventDefault();
      const selectedIdx = [...rows].findIndex((r) => Number(r.dataset.rowNumber) === state.selectedRow);
      focusRowAt(selectedIdx >= 0 ? selectedIdx : 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Search input
// ---------------------------------------------------------------------------

// Show the clear (×) button only when there is text
function updateSearchClear() {
  el.searchClear.hidden = el.searchInput.value === '';
}

// Wire the search box: debounce on input, immediate on Enter, IME-aware
function wireSearchInput() {
  // Typing schedules a debounced search (skipped while composing kana)
  el.searchInput.addEventListener('input', (e) => {
    state.query.q = el.searchInput.value;
    state.query.page = 1;
    updateSearchClear();
    if (e.isComposing) return;
    scheduleSearch();
  });
  // Composition end commits the converted text
  el.searchInput.addEventListener('compositionend', () => {
    state.query.q = el.searchInput.value;
    state.query.page = 1;
    scheduleSearch();
  });
  // Enter searches immediately
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      runSearch();
    }
  });
  // Clear button
  el.searchClear.addEventListener('click', () => {
    el.searchInput.value = '';
    state.query.q = '';
    state.query.page = 1;
    updateSearchClear();
    el.searchInput.focus();
    runSearch();
  });
}

// ---------------------------------------------------------------------------
// Theme (light / dark / system, persisted only in localStorage)
// ---------------------------------------------------------------------------

// Read the saved preference safely
function readTheme() {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

// Apply a preference to <html data-theme> and the radio group
function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
  else delete root.dataset.theme;
  for (const btn of el.themeSwitch.querySelectorAll('.theme-option')) {
    const checked = btn.dataset.themeValue === pref;
    btn.setAttribute('aria-checked', checked ? 'true' : 'false');
    btn.tabIndex = checked ? 0 : -1;
  }
}

// Persist a preference (system = remove the key)
function saveTheme(pref) {
  try {
    if (pref === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage may be blocked (private mode); the choice still applies for this page view
  }
}

// Wire the theme radio group (click + arrow keys)
function wireTheme() {
  applyTheme(readTheme());
  const options = [...el.themeSwitch.querySelectorAll('.theme-option')];
  // Click selects
  el.themeSwitch.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('.theme-option') : null;
    if (!btn) return;
    applyTheme(btn.dataset.themeValue);
    saveTheme(btn.dataset.themeValue);
  });
  // Left/Right arrows move and select (radio group pattern)
  el.themeSwitch.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const idx = options.indexOf(document.activeElement);
    const next = options[(idx + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length];
    applyTheme(next.dataset.themeValue);
    saveTheme(next.dataset.themeValue);
    next.focus();
  });
}

// ---------------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------------

// Wire every listener once
function wireEvents() {
  wireSearchInput();
  wireTheme();

  // Row clicks open the drawer (event delegation)
  el.list.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('.row') : null;
    if (!btn) return;
    const item = findItem(Number(btn.dataset.rowNumber));
    if (item) openDetail(item);
  });

  // Sort change resets to page 1
  el.sortSelect.addEventListener('change', () => {
    state.query.sort = el.sortSelect.value;
    state.query.page = 1;
    runSearch();
  });

  // Mobile filter sheet button
  el.filterSheetButton.addEventListener('click', openFilterSheet);

  // Scrim click closes whichever overlay is open
  el.scrim.addEventListener('click', () => {
    if (sheetState.open) closeFilterSheet();
    else if (drawerState.open) closeDrawer();
  });

  // Outside click closes the popover (without stealing focus from the click target)
  document.addEventListener('pointerdown', (e) => {
    if (!popoverState.key) return;
    const target = e.target;
    if (el.popover.contains(target)) return;
    if (popoverState.anchor && popoverState.anchor.contains(target)) return;
    closePopover({ restoreFocus: false });
  });

  // Keep the popover attached while scrolling / resizing
  window.addEventListener('scroll', positionPopover, { passive: true });
  window.addEventListener('resize', positionPopover);

  // Switching between wide and narrow layouts updates the scrim for an open drawer
  narrowScreen.addEventListener('change', () => {
    if (!drawerState.open || sheetState.open) return;
    el.scrim.hidden = !narrowScreen.matches;
    el.scrim.classList.toggle('is-visible', narrowScreen.matches);
  });

  // Global shortcuts
  document.addEventListener('keydown', onGlobalKeydown);
}

// Load account and metadata (non-blocking; search errors are surfaced by the banner)
async function loadContext() {
  // Signed-in account for the header
  api.getMe().then((me) => {
    if (me && me.email) {
      el.email.textContent = me.email;
      el.email.title = me.mode === 'dev' ? `${me.email}（開発モード）` : me.email;
      el.email.classList.toggle('is-dev', me.mode === 'dev');
    }
  }).catch(() => { /* the search request reports auth errors */ });

  // Metadata: kinds, categories, flagged count
  api.getMeta().then((meta) => {
    state.meta = meta;
    renderChipRow();
  }).catch(() => { /* chips fall back to default option lists */ });
}

// Entry point
function init() {
  wireEvents();
  renderChipRow();
  updateSearchClear();
  loadContext();
  // Initial empty query: "最近の受診" newest first
  runSearch();
}

init();
