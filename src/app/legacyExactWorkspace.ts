import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { toolCategories, tools, type ToolDefinition } from '../tools/registry';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const FAVORITES_KEY = 'docflow.favorites.v1';
const fileState = new WeakMap<HTMLElement, File[]>();
const rootObservers = new WeakMap<HTMLElement, MutationObserver>();
let installed = false;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character] ?? character));
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function categoryLabel(tool: ToolDefinition): string {
  return toolCategories.find((category) => category.id === tool.category)?.label.toUpperCase() ?? tool.category.toUpperCase();
}

function findTool(root: HTMLElement): ToolDefinition | null {
  const name = root.querySelector<HTMLElement>('.workspace-side h2')?.textContent?.trim();
  return tools.find((tool) => tool.name === name) ?? null;
}

function readFavorites(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function setFavorite(button: HTMLButtonElement, tool: ToolDefinition): void {
  const favorites = new Set(readFavorites());
  const active = favorites.has(tool.id);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', active ? `Remove ${tool.name} from favorites` : `Add ${tool.name} to favorites`);
  button.title = active ? 'Remove from favorites' : 'Add to favorites';
  button.textContent = active ? '★' : '☆';
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function closeWorkspace(root: HTMLElement): void {
  root.closest<HTMLDialogElement>('.workspace-dialog')?.close();
}

function structuralWarning(tool: ToolDefinition): string {
  if (tool.quality === 'Inspection') return 'Preview only — the source document is not changed.';
  if (tool.id === 'protect-pdf' || tool.id === 'unlock-pdf') return 'Security processing stays local; passwords are not stored by DocFlow.';
  return 'Bookmarks may not be preserved; modifying signed files can invalidate signatures.';
}

function outputLabel(tool: ToolDefinition): string {
  if (tool.quality === 'Inspection') return 'PDF preview';
  if (tool.id === 'images-to-pdf') return 'PDF output';
  if (tool.id === 'pdf-to-images' || tool.id === 'extract-images') return 'Image output';
  return 'PDF output';
}

function createLegacyShell(root: HTMLElement, grid: HTMLElement, tool: ToolDefinition): void {
  if (grid.dataset.legacyExact === 'true') return;
  const side = grid.querySelector<HTMLElement>('.workspace-side');
  const main = grid.querySelector<HTMLElement>('.workspace-main');
  if (!side || !main) return;

  const description = side.querySelector<HTMLElement>(':scope > p:not(.eyebrow)');
  const quality = side.querySelector<HTMLElement>('.quality-box');
  const privacy = side.querySelector<HTMLElement>('.privacy-box');
  const drop = main.querySelector<HTMLElement>('.drop-zone');
  const memory = main.querySelector<HTMLElement>('#memory-warning');
  const fileList = main.querySelector<HTMLElement>('#file-list');
  const options = main.querySelector<HTMLElement>('#tool-options');
  const previewArea = main.querySelector<HTMLElement>('#preview-area');
  const status = main.querySelector<HTMLElement>('.operation-status');
  const actions = main.querySelector<HTMLElement>('.workspace-actions');
  const result = main.querySelector<HTMLElement>('#result');
  if (!drop || !fileList || !options || !previewArea || !status || !actions || !result) return;

  grid.dataset.legacyExact = 'true';
  grid.classList.add('legacy-editor-shell');

  const dialog = root.closest<HTMLDialogElement>('.workspace-dialog');
  const dialogBar = dialog?.querySelector<HTMLFormElement>(':scope > .dialog-bar') ?? null;
  const nativeClose = dialogBar?.querySelector<HTMLButtonElement>('button') ?? null;
  if (nativeClose) {
    nativeClose.textContent = '×';
    nativeClose.title = 'Close';
  }

  const header = document.createElement('header');
  header.className = 'legacy-editor-header';
  header.innerHTML = `<div class="legacy-tool-icon" aria-hidden="true">${escapeHtml(tool.icon)}</div>`;
  side.classList.add('legacy-title-block');
  const eyebrow = side.querySelector<HTMLElement>('.eyebrow');
  if (eyebrow) eyebrow.textContent = categoryLabel(tool);
  const meta = document.createElement('div');
  meta.className = 'legacy-title-meta';
  meta.innerHTML = `<span class="legacy-full-badge">${tool.status === 'Migrated' ? 'Full' : escapeHtml(tool.status)}</span><span>${escapeHtml(outputLabel(tool))}</span>`;
  side.append(meta);
  header.append(side);

  const headerActions = document.createElement('div');
  headerActions.className = 'legacy-header-actions';
  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.className = 'legacy-favorite-button';
  setFavorite(favorite, tool);
  favorite.addEventListener('click', () => {
    const values = new Set(readFavorites());
    if (values.has(tool.id)) values.delete(tool.id); else values.add(tool.id);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...values]));
    setFavorite(favorite, tool);
  });
  headerActions.append(favorite);
  if (dialogBar) {
    dialogBar.classList.add('legacy-header-close-form');
    headerActions.append(dialogBar);
  }
  header.append(headerActions);

  const info = document.createElement('div');
  info.className = 'legacy-editor-info';
  info.innerHTML = `<span>${escapeHtml(description?.textContent?.trim() || tool.description)}</span><span class="legacy-editor-warning"><b aria-hidden="true">ⓘ</b>${escapeHtml(structuralWarning(tool))}</span>`;
  description?.remove();

  const body = document.createElement('div');
  body.className = 'legacy-editor-body';

  const filesPane = document.createElement('aside');
  filesPane.className = 'legacy-files-pane';
  filesPane.innerHTML = '<div class="legacy-pane-title"><strong>Files</strong><span data-legacy-file-count>0</span></div>';
  filesPane.append(drop, fileList);
  if (memory) filesPane.append(memory);

  const center = document.createElement('main');
  center.className = 'legacy-center-pane';
  const centerToolbar = document.createElement('div');
  centerToolbar.className = 'legacy-center-toolbar';
  centerToolbar.innerHTML = `
    <div class="legacy-toolbar-group legacy-selection-tools" aria-label="Page selection controls">
      <button type="button" data-legacy-select="all">Select all</button>
      <button type="button" data-legacy-select="none">Deselect</button>
      <button type="button" data-legacy-select="invert">Invert</button>
    </div>
    <div class="legacy-toolbar-spacer"></div>
    <button type="button" class="legacy-overview-button" data-legacy-overview><span aria-hidden="true">◉</span> Overview</button>
  `;
  const empty = document.createElement('div');
  empty.className = 'legacy-preview-empty';
  empty.innerHTML = '<span class="legacy-empty-document" aria-hidden="true">▯</span><strong>Add a compatible file</strong><span>Its pages will appear here after local validation.</span>';
  const livePreview = document.createElement('div');
  livePreview.className = 'legacy-live-preview';
  center.append(centerToolbar, livePreview, empty, previewArea);

  const settings = document.createElement('aside');
  settings.className = 'legacy-settings-pane';
  settings.innerHTML = `<h3>Settings</h3><div class="legacy-settings-note">${escapeHtml(tool.id === 'merge' ? 'The output follows the file list first, then every visible page inside each file. Review the source before running the tool.' : 'Review the source preview and settings before applying this operation. Changes are made only when you run the tool.')}</div>`;
  settings.append(options);
  if (quality) settings.append(quality);
  if (privacy) settings.append(privacy);
  settings.append(status, result);

  body.append(filesPane, center, settings);

  const footer = document.createElement('footer');
  footer.className = 'legacy-editor-footer';
  const footerState = document.createElement('span');
  footerState.dataset.legacyFooterState = 'true';
  footerState.textContent = '0 files ready · review before running';
  const footerButtons = document.createElement('div');
  footerButtons.className = 'legacy-footer-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'secondary legacy-footer-close';
  close.textContent = 'Close';
  close.addEventListener('click', () => closeWorkspace(root));
  footerButtons.append(close, actions);
  footer.append(footerState, footerButtons);

  grid.replaceChildren(header, info, body, footer);

  [...centerToolbar.querySelectorAll<HTMLButtonElement>('[data-legacy-select]')].forEach((button) => { button.disabled = true; });
  centerToolbar.querySelector('[data-legacy-overview]')?.addEventListener('click', () => { void openOverview(root); });

  const observer = new MutationObserver(() => syncLegacyWorkspace(root));
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-current'] });
  rootObservers.set(root, observer);
  root.addEventListener('docflow-cleanup', () => {
    observer.disconnect();
    rootObservers.delete(root);
    fileState.delete(root);
  }, { once: true });
  syncLegacyWorkspace(root);
}

function syncLegacyWorkspace(root: HTMLElement): void {
  const shell = root.querySelector<HTMLElement>('.legacy-editor-shell');
  if (!shell) return;
  const center = shell.querySelector<HTMLElement>('.legacy-live-preview');
  const settings = shell.querySelector<HTMLElement>('.legacy-settings-pane');
  const list = shell.querySelector<HTMLElement>('#file-list');
  if (!center || !settings || !list) return;

  const preEdit = root.querySelector<HTMLElement>('.pre-edit-preview');
  if (preEdit && preEdit.parentElement !== center) center.append(preEdit);

  const recovery = root.querySelector<HTMLElement>('[data-recovery-panel]');
  const saveStatus = root.querySelector<HTMLElement>('[data-project-save-status]');
  if (recovery && recovery.parentElement !== settings) settings.append(recovery);
  if (saveStatus && saveStatus.parentElement !== settings) settings.append(saveStatus);

  const count = list.querySelectorAll('.file-row').length;
  const countNode = shell.querySelector<HTMLElement>('[data-legacy-file-count]');
  const footer = shell.querySelector<HTMLElement>('[data-legacy-footer-state]');
  if (countNode) countNode.textContent = String(count);
  if (footer) footer.textContent = `${count} file${count === 1 ? '' : 's'} ready · review before running`;

  const empty = shell.querySelector<HTMLElement>('.legacy-preview-empty');
  if (empty) empty.hidden = Boolean(preEdit && !preEdit.hidden);

  const overview = shell.querySelector<HTMLButtonElement>('[data-legacy-overview]');
  if (overview) overview.disabled = !(fileState.get(root) ?? []).some(isPdf);
}

function enhanceAvailableWorkspaces(): void {
  document.querySelectorAll<HTMLElement>('.workspace .workspace-grid:not([data-legacy-exact="true"])').forEach((grid) => {
    const root = grid.closest<HTMLElement>('.workspace');
    if (!root) return;
    const tool = findTool(root);
    if (tool) createLegacyShell(root, grid, tool);
  });
}

function updateFilesFromInput(input: HTMLInputElement): void {
  const root = input.closest<HTMLElement>('.workspace');
  if (!root || !input.files?.length) return;
  const selected = [...input.files];
  const current = fileState.get(root) ?? [];
  fileState.set(root, input.multiple ? [...current, ...selected] : selected.slice(0, 1));
  queueMicrotask(() => syncLegacyWorkspace(root));
}

function updateFilesFromDrop(dropZone: HTMLElement, files: FileList): void {
  const root = dropZone.closest<HTMLElement>('.workspace');
  const input = dropZone.querySelector<HTMLInputElement>('#workspace-file');
  if (!root || !input || !files.length) return;
  const selected = [...files];
  const current = fileState.get(root) ?? [];
  fileState.set(root, input.multiple ? [...current, ...selected] : selected.slice(0, 1));
  queueMicrotask(() => syncLegacyWorkspace(root));
}

function removeTrackedFile(button: HTMLElement): void {
  const root = button.closest<HTMLElement>('.workspace');
  if (!root) return;
  const current = [...(fileState.get(root) ?? [])];
  const aria = button.getAttribute('aria-label') ?? '';
  const name = aria.startsWith('Remove ') ? aria.slice('Remove '.length) : '';
  const index = name ? current.findIndex((file) => file.name === name) : -1;
  if (index >= 0) current.splice(index, 1);
  else if (current.length === 1) current.length = 0;
  fileState.set(root, current);
  queueMicrotask(() => syncLegacyWorkspace(root));
}

interface OverviewState {
  overlay: HTMLElement;
  pdfDocument: PDFDocumentProxy;
  currentPage: number;
  scale: number;
  renderTask: RenderTask | null;
  thumbnailTasks: Set<RenderTask>;
  thumbnailObserver: IntersectionObserver | null;
  disposed: boolean;
}

async function openOverview(root: HTMLElement): Promise<void> {
  const files = fileState.get(root) ?? [];
  const sourceButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-pre-edit-source]')];
  const activeSource = sourceButtons.find((button) => button.getAttribute('aria-current') === 'true');
  const sourceIndex = activeSource ? Number(activeSource.dataset.preEditSource) : 0;
  const file = files[sourceIndex] ?? files.find(isPdf);
  if (!file || !isPdf(file)) return;

  const dialog = root.closest<HTMLDialogElement>('.workspace-dialog');
  if (!dialog || dialog.querySelector('.legacy-overview-overlay')) return;

  const overlay = document.createElement('section');
  overlay.className = 'legacy-overview-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `PDF overview for ${file.name}`);
  overlay.innerHTML = `
    <header class="legacy-overview-header">
      <div><span>PDF OVERVIEW</span><h2>${escapeHtml(file.name)}</h2><p data-overview-meta>Opening PDF…</p></div>
      <button type="button" data-overview-close aria-label="Close PDF overview">×</button>
    </header>
    <div class="legacy-overview-toolbar">
      <div class="legacy-overview-page-controls">
        <button type="button" data-overview-page="prev" aria-label="Previous page">‹</button>
        <input data-overview-page-input type="number" min="1" value="1" aria-label="Page number"><span data-overview-total>/ 1</span>
        <button type="button" data-overview-page="next" aria-label="Next page">›</button>
      </div>
      <div class="legacy-overview-zoom-controls">
        <button type="button" data-overview-view="zoom-out" aria-label="Zoom out">−</button>
        <span data-overview-zoom>100%</span>
        <button type="button" data-overview-view="zoom-in" aria-label="Zoom in">+</button>
        <button type="button" data-overview-view="fit-page">Fit page</button>
        <button type="button" data-overview-view="fit-width">Fit width</button>
        <button type="button" data-overview-view="reset">Reset</button>
      </div>
    </div>
    <div class="legacy-overview-body">
      <aside class="legacy-overview-pages"><div class="legacy-overview-pane-title"><strong>Pages</strong><span data-overview-page-count></span></div><div data-overview-thumbnails></div></aside>
      <main class="legacy-overview-canvas-shell" tabindex="0"><canvas data-overview-canvas></canvas></main>
      <aside class="legacy-overview-text"><div class="legacy-overview-pane-title"><strong>Text layer</strong><span data-overview-text-state>Checking…</span></div><div data-overview-text></div></aside>
    </div>
  `;
  dialog.append(overlay);

  const canvas = overlay.querySelector<HTMLCanvasElement>('[data-overview-canvas]');
  const canvasShell = overlay.querySelector<HTMLElement>('.legacy-overview-canvas-shell');
  const thumbnails = overlay.querySelector<HTMLElement>('[data-overview-thumbnails]');
  const meta = overlay.querySelector<HTMLElement>('[data-overview-meta]');
  const total = overlay.querySelector<HTMLElement>('[data-overview-total]');
  const pageCount = overlay.querySelector<HTMLElement>('[data-overview-page-count]');
  const input = overlay.querySelector<HTMLInputElement>('[data-overview-page-input]');
  const zoom = overlay.querySelector<HTMLElement>('[data-overview-zoom]');
  const textState = overlay.querySelector<HTMLElement>('[data-overview-text-state]');
  const text = overlay.querySelector<HTMLElement>('[data-overview-text]');
  if (!canvas || !canvasShell || !thumbnails || !meta || !total || !pageCount || !input || !zoom || !textState || !text) { overlay.remove(); return; }

  try {
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const pdfDocument = await loadingTask.promise;
    const state: OverviewState = {
      overlay, pdfDocument, currentPage: 1, scale: 1, renderTask: null,
      thumbnailTasks: new Set(), thumbnailObserver: null, disposed: false
    };

    total.textContent = `/ ${pdfDocument.numPages}`;
    pageCount.textContent = `${pdfDocument.numPages} page${pdfDocument.numPages === 1 ? '' : 's'}`;
    input.max = String(pdfDocument.numPages);

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'legacy-overview-thumbnail';
      button.dataset.overviewThumbnail = String(pageNumber);
      button.setAttribute('aria-label', `View page ${pageNumber}`);
      button.innerHTML = `<canvas aria-hidden="true"></canvas><span>Page ${pageNumber}</span>`;
      thumbnails.append(button);
    }

    const renderThumbnail = async (button: HTMLButtonElement): Promise<void> => {
      if (button.dataset.rendered === 'true' || state.disposed) return;
      button.dataset.rendered = 'true';
      const pageNumber = Number(button.dataset.overviewThumbnail);
      const target = button.querySelector<HTMLCanvasElement>('canvas');
      if (!target) return;
      const page = await state.pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 0.18 });
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      target.width = Math.max(1, Math.floor(viewport.width * ratio));
      target.height = Math.max(1, Math.floor(viewport.height * ratio));
      target.style.width = `${Math.max(1, Math.floor(viewport.width))}px`;
      target.style.height = `${Math.max(1, Math.floor(viewport.height))}px`;
      const context = target.getContext('2d', { alpha: false });
      if (!context) { page.cleanup(); return; }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const task = page.render({ canvasContext: context, viewport });
      state.thumbnailTasks.add(task);
      try { await task.promise; } catch { button.dataset.rendered = 'false'; }
      finally { state.thumbnailTasks.delete(task); page.cleanup(); }
    };

    state.thumbnailObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const button = entry.target as HTMLButtonElement;
        state.thumbnailObserver?.unobserve(button);
        void renderThumbnail(button);
      });
    }, { root: thumbnails, rootMargin: '320px 0px' });
    thumbnails.querySelectorAll<HTMLButtonElement>('.legacy-overview-thumbnail').forEach((button) => state.thumbnailObserver?.observe(button));

    const markCurrent = (): void => {
      thumbnails.querySelectorAll('[aria-current="page"]').forEach((item) => item.removeAttribute('aria-current'));
      const selected = thumbnails.querySelector<HTMLElement>(`[data-overview-thumbnail="${state.currentPage}"]`);
      selected?.setAttribute('aria-current', 'page');
      selected?.scrollIntoView({ block: 'nearest' });
    };

    const renderPage = async (pageNumber: number): Promise<void> => {
      if (state.disposed) return;
      state.currentPage = Math.max(1, Math.min(state.pdfDocument.numPages, pageNumber));
      state.renderTask?.cancel();
      const page = await state.pdfDocument.getPage(state.currentPage);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: state.scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) { page.cleanup(); return; }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      state.renderTask = page.render({ canvasContext: context, viewport });
      try { await state.renderTask.promise; } catch (error) {
        if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') throw error;
        return;
      }
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => 'str' in item ? item.str : '').filter(Boolean).join(' ');
      text.textContent = pageText || 'No selectable text was found on this page.';
      textState.textContent = pageText ? 'Text available' : 'No text';
      input.value = String(state.currentPage);
      zoom.textContent = `${Math.round(state.scale * 100)}%`;
      meta.textContent = `${file.name} / workspace page ${state.currentPage} of ${state.pdfDocument.numPages} / source page ${state.currentPage} / ${humanBytes(file.size)} / ${Math.round(base.width)} × ${Math.round(base.height)} pt`;
      markCurrent();
      page.cleanup();
    };

    const fit = async (mode: 'page' | 'width'): Promise<void> => {
      const page = await state.pdfDocument.getPage(state.currentPage);
      const base = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, canvasShell.clientWidth - 48);
      const availableHeight = Math.max(360, canvasShell.clientHeight - 36);
      state.scale = mode === 'width' ? availableWidth / base.width : Math.min(availableWidth / base.width, availableHeight / base.height);
      page.cleanup();
      await renderPage(state.currentPage);
    };

    const close = async (): Promise<void> => {
      if (state.disposed) return;
      state.disposed = true;
      state.renderTask?.cancel();
      state.thumbnailTasks.forEach((task) => task.cancel());
      state.thumbnailTasks.clear();
      state.thumbnailObserver?.disconnect();
      overlay.remove();
      await state.pdfDocument.destroy().catch(() => undefined);
    };

    overlay.querySelector('[data-overview-close]')?.addEventListener('click', () => { void close(); });
    thumbnails.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-overview-thumbnail]');
      if (button?.dataset.overviewThumbnail) void renderPage(Number(button.dataset.overviewThumbnail));
    });
    overlay.querySelector('.legacy-overview-toolbar')?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const direction = target.closest<HTMLElement>('[data-overview-page]')?.dataset.overviewPage;
      if (direction) { void renderPage(state.currentPage + (direction === 'next' ? 1 : -1)); return; }
      const action = target.closest<HTMLElement>('[data-overview-view]')?.dataset.overviewView;
      if (action === 'zoom-in') { state.scale = Math.min(4, state.scale * 1.15); void renderPage(state.currentPage); }
      else if (action === 'zoom-out') { state.scale = Math.max(.3, state.scale / 1.15); void renderPage(state.currentPage); }
      else if (action === 'reset') { state.scale = 1; void renderPage(state.currentPage); }
      else if (action === 'fit-page') void fit('page');
      else if (action === 'fit-width') void fit('width');
    });
    input.addEventListener('change', () => { void renderPage(Number(input.value)); });
    canvasShell.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); void renderPage(state.currentPage - 1); }
      else if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); void renderPage(state.currentPage + 1); }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); state.scale = Math.min(4, state.scale * 1.15); void renderPage(state.currentPage); }
      else if (event.key === '-') { event.preventDefault(); state.scale = Math.max(.3, state.scale / 1.15); void renderPage(state.currentPage); }
    });
    root.addEventListener('docflow-cleanup', () => { void close(); }, { once: true });

    await renderPage(1);
    await fit('page');
    overlay.querySelector<HTMLButtonElement>('[data-overview-close]')?.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The PDF overview could not be opened.';
    overlay.innerHTML = `<div class="legacy-overview-error"><strong>PDF overview unavailable</strong><p>${escapeHtml(message)}</p><button type="button">Close</button></div>`;
    overlay.querySelector('button')?.addEventListener('click', () => overlay.remove());
  }
}

export function installLegacyExactWorkspace(): void {
  if (installed) return;
  installed = true;

  const documentObserver = new MutationObserver(() => queueMicrotask(enhanceAvailableWorkspaces));
  documentObserver.observe(document.body, { subtree: true, childList: true });
  enhanceAvailableWorkspaces();

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.id === 'workspace-file' && input.type === 'file') updateFilesFromInput(input);
  }, true);

  document.addEventListener('drop', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !event.dataTransfer?.files.length) return;
    const dropZone = target.closest<HTMLElement>('.drop-zone');
    if (dropZone) updateFilesFromDrop(dropZone, event.dataTransfer.files);
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const remove = target.closest<HTMLElement>('[data-remove]');
    if (remove) removeTrackedFile(remove);
  }, true);
}
