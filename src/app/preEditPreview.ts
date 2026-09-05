import { createPreview, type PreviewController } from '../pdf/render';

const THUMBNAIL_ROW_HEIGHT = 176;
const THUMBNAIL_OVERSCAN = 3;
const DEFAULT_SCALE = 1.25;
const MIN_SCALE = 0.35;
const MAX_SCALE = 4;

interface PreviewSession {
  root: HTMLElement;
  panel: HTMLElement;
  files: File[];
  activeIndex: number;
  controller: PreviewController | null;
  cleanupViewer: (() => void) | null;
  generation: number;
  objectUrls: string[];
}

const sessions = new WeakMap<HTMLElement, PreviewSession>();
let installed = false;

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function isImage(file: File): boolean {
  return /image\/(png|jpeg)/.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);
}

function clampScale(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character] ?? character));
}

function workspaceRoot(target: Element): HTMLElement | null {
  return target.closest<HTMLElement>('.workspace');
}

function toolName(root: HTMLElement): string {
  return root.querySelector<HTMLElement>('.workspace-side h2')?.textContent?.trim() ?? 'PDF tool';
}

function shouldEnhance(root: HTMLElement): boolean {
  return toolName(root) !== 'View PDF';
}

function createPanel(root: HTMLElement): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'pre-edit-preview';
  panel.dataset.preEditPreview = 'true';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="pre-edit-preview-head">
      <div>
        <span class="pre-edit-kicker">PRE-EDIT PREVIEW</span>
        <strong>Review the source before applying changes</strong>
        <small data-pre-edit-hint>No changes are applied in this preview.</small>
      </div>
      <div class="pre-edit-source-tabs" data-pre-edit-sources aria-label="Preview source files"></div>
    </div>
    <div class="pre-edit-preview-body" data-pre-edit-body></div>
  `;

  const form = root.querySelector<HTMLElement>('#tool-options');
  const fileList = root.querySelector<HTMLElement>('#file-list');
  if (form) form.insertAdjacentElement('beforebegin', panel);
  else if (fileList) fileList.insertAdjacentElement('afterend', panel);
  else root.querySelector<HTMLElement>('.workspace-main')?.append(panel);
  return panel;
}

function getSession(root: HTMLElement): PreviewSession {
  const existing = sessions.get(root);
  if (existing) return existing;
  const session: PreviewSession = {
    root,
    panel: createPanel(root),
    files: [],
    activeIndex: 0,
    controller: null,
    cleanupViewer: null,
    generation: 0,
    objectUrls: []
  };
  sessions.set(root, session);
  root.addEventListener('docflow-cleanup', () => { void disposeSession(session); }, { once: true });
  root.querySelector<HTMLFormElement>('#tool-options')?.addEventListener('input', () => updateHint(session));
  root.querySelector<HTMLFormElement>('#tool-options')?.addEventListener('change', () => updateHint(session));
  session.panel.addEventListener('click', (event) => {
    const source = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-pre-edit-source]');
    if (!source) return;
    const index = Number(source.dataset.preEditSource);
    if (!Number.isInteger(index) || index < 0 || index >= session.files.length || index === session.activeIndex) return;
    session.activeIndex = index;
    renderSourceTabs(session);
    void renderActive(session);
  });
  return session;
}

function clearObjectUrls(session: PreviewSession): void {
  session.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  session.objectUrls = [];
}

async function destroyViewer(session: PreviewSession): Promise<void> {
  session.cleanupViewer?.();
  session.cleanupViewer = null;
  const controller = session.controller;
  session.controller = null;
  if (controller) await controller.destroy().catch(() => undefined);
}

async function disposeSession(session: PreviewSession): Promise<void> {
  session.generation += 1;
  clearObjectUrls(session);
  await destroyViewer(session);
  session.panel.remove();
  sessions.delete(session.root);
}

function renderSourceTabs(session: PreviewSession): void {
  const host = session.panel.querySelector<HTMLElement>('[data-pre-edit-sources]');
  if (!host) return;
  host.innerHTML = session.files.map((file, index) => `
    <button type="button" data-pre-edit-source="${index}" ${index === session.activeIndex ? 'aria-current="true"' : ''} title="Preview ${escapeHtml(file.name)}">
      ${escapeHtml(file.name)}
    </button>
  `).join('');
}

function updateHint(session: PreviewSession): void {
  const hint = session.panel.querySelector<HTMLElement>('[data-pre-edit-hint]');
  if (!hint) return;
  const root = session.root;
  const name = toolName(root);
  const form = root.querySelector<HTMLFormElement>('#tool-options');
  const value = (selector: string): string => form?.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value?.trim() ?? '';

  if (name === 'Remove pages') {
    const pages = value('[name="pages"]');
    hint.textContent = pages ? `Source preview · pages marked for removal: ${pages}` : 'Source preview · enter the pages to remove, then review them here before running.';
  } else if (name === 'Extract pages') {
    const pages = value('[name="pages"]');
    hint.textContent = pages ? `Source preview · pages marked for extraction: ${pages}` : 'Source preview · enter the pages to extract, then review them here before running.';
  } else if (name === 'Rotate pages') {
    const target = value('[name="target"]') || 'all';
    const pages = value('[name="pages"]');
    const degrees = value('[name="degrees"]') || '90';
    hint.textContent = target === 'selected' && pages
      ? `Source preview · selected pages ${pages} will rotate ${degrees}° only after you run the tool.`
      : `Source preview · ${target} pages will rotate ${degrees}° only after you run the tool.`;
  } else if (name === 'Add page numbers') {
    const pages = value('[name="pages"]');
    hint.textContent = pages ? `Source preview · numbering target: ${pages}` : 'Source preview · numbering target: all pages.';
  } else if (name === 'Split PDF') {
    hint.textContent = 'Source preview · inspect page boundaries before creating the split outputs.';
  } else if (name === 'Merge PDF') {
    hint.textContent = 'Source preview · switch between the selected PDFs above and inspect each document before merging.';
  } else if (name === 'Add watermark') {
    hint.textContent = 'Source preview · the PDF remains unchanged until you run Add watermark.';
  } else if (name === 'Optimize PDF') {
    hint.textContent = 'Source preview · inspect the original before any optimization is applied.';
  } else if (name === 'Fill PDF forms') {
    hint.textContent = 'Source preview · review the original form before writing field values.';
  } else {
    hint.textContent = 'Source preview · no changes are applied until you run the selected tool.';
  }
}

function renderImagePreview(session: PreviewSession): void {
  clearObjectUrls(session);
  const body = session.panel.querySelector<HTMLElement>('[data-pre-edit-body]');
  if (!body) return;
  body.innerHTML = `<div class="pre-edit-image-grid"></div>`;
  const grid = body.querySelector<HTMLElement>('.pre-edit-image-grid');
  if (!grid) return;
  for (const file of session.files.filter(isImage)) {
    const url = URL.createObjectURL(file);
    session.objectUrls.push(url);
    const figure = document.createElement('figure');
    figure.innerHTML = `<img src="${url}" alt="Preview of ${escapeHtml(file.name)}"><figcaption>${escapeHtml(file.name)}</figcaption>`;
    grid.append(figure);
  }
  session.panel.dataset.previewReady = 'true';
}

async function renderPdfPreview(session: PreviewSession, file: File): Promise<void> {
  const generation = ++session.generation;
  clearObjectUrls(session);
  await destroyViewer(session);
  if (generation !== session.generation) return;

  const body = session.panel.querySelector<HTMLElement>('[data-pre-edit-body]');
  if (!body) return;
  body.innerHTML = `
    <div class="pre-edit-viewer-toolbar" aria-label="Pre-edit PDF preview controls">
      <button type="button" data-pre-edit-page="prev">Previous</button>
      <span data-pre-edit-status>Opening PDF…</span>
      <button type="button" data-pre-edit-page="next">Next</button>
      <span class="pre-edit-toolbar-divider" aria-hidden="true"></span>
      <button type="button" data-pre-edit-view="zoom-out" aria-label="Zoom out">−</button>
      <span data-pre-edit-zoom aria-live="polite">125%</span>
      <button type="button" data-pre-edit-view="zoom-in" aria-label="Zoom in">+</button>
      <button type="button" data-pre-edit-view="actual">Actual size</button>
      <button type="button" data-pre-edit-view="fit-width">Fit width</button>
      <button type="button" data-pre-edit-view="fit-page">Fit page</button>
    </div>
    <div class="pre-edit-viewer-layout">
      <aside class="pre-edit-thumbnail-rail" aria-label="Page thumbnails"><div class="pre-edit-thumbnail-track"></div></aside>
      <div class="pre-edit-canvas-shell" tabindex="0" aria-label="Large PDF preview. Use left and right arrows to change pages and plus or minus to zoom."><canvas></canvas></div>
    </div>
  `;

  const canvas = body.querySelector<HTMLCanvasElement>('.pre-edit-canvas-shell canvas');
  const status = body.querySelector<HTMLElement>('[data-pre-edit-status]');
  const zoom = body.querySelector<HTMLElement>('[data-pre-edit-zoom]');
  const toolbar = body.querySelector<HTMLElement>('.pre-edit-viewer-toolbar');
  const rail = body.querySelector<HTMLElement>('.pre-edit-thumbnail-rail');
  const track = body.querySelector<HTMLElement>('.pre-edit-thumbnail-track');
  const shell = body.querySelector<HTMLElement>('.pre-edit-canvas-shell');
  if (!canvas || !status || !zoom || !toolbar || !rail || !track || !shell) return;

  try {
    const controller = await createPreview(await file.arrayBuffer(), canvas, status);
    if (generation !== session.generation) { await controller.destroy(); return; }
    session.controller = controller;
    session.panel.dataset.previewReady = 'true';
    track.style.height = `${controller.pageCount * THUMBNAIL_ROW_HEIGHT}px`;

    let currentPage = 1;
    let scale = DEFAULT_SCALE;
    let thumbnailGeneration = 0;
    let frame = 0;

    const updateZoom = (): void => { zoom.textContent = `${Math.round(scale * 100)}%`; };
    const markCurrent = (): void => {
      track.querySelectorAll<HTMLElement>('[aria-current="page"]').forEach((item) => item.removeAttribute('aria-current'));
      track.querySelector<HTMLElement>(`[data-pre-edit-thumbnail="${currentPage}"]`)?.setAttribute('aria-current', 'page');
    };
    const renderThumbnailWindow = (): void => {
      frame = 0;
      const localGeneration = ++thumbnailGeneration;
      controller.cancelThumbnails();
      const viewportHeight = Math.max(rail.clientHeight, THUMBNAIL_ROW_HEIGHT * 3);
      const firstVisible = Math.floor(rail.scrollTop / THUMBNAIL_ROW_HEIGHT) + 1;
      const start = Math.max(1, firstVisible - THUMBNAIL_OVERSCAN);
      const visibleRows = Math.ceil(viewportHeight / THUMBNAIL_ROW_HEIGHT) + THUMBNAIL_OVERSCAN * 2;
      const end = Math.min(controller.pageCount, start + visibleRows - 1);
      const fragment = document.createDocumentFragment();
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pre-edit-thumbnail-item';
        button.dataset.preEditThumbnail = String(pageNumber);
        button.style.top = `${(pageNumber - 1) * THUMBNAIL_ROW_HEIGHT + 5}px`;
        button.setAttribute('aria-label', `Preview page ${pageNumber}`);
        if (pageNumber === currentPage) button.setAttribute('aria-current', 'page');
        button.innerHTML = `<canvas aria-hidden="true"></canvas><span>Page ${pageNumber}</span>`;
        fragment.append(button);
      }
      track.replaceChildren(fragment);
      const buttons = [...track.querySelectorAll<HTMLButtonElement>('.pre-edit-thumbnail-item')];
      void (async () => {
        for (const button of buttons) {
          if (localGeneration !== thumbnailGeneration || session.controller !== controller) return;
          const pageNumber = Number(button.dataset.preEditThumbnail);
          const thumbCanvas = button.querySelector<HTMLCanvasElement>('canvas');
          if (!thumbCanvas) continue;
          try {
            await controller.renderThumbnail(pageNumber, thumbCanvas, 0.24);
          } catch {
            if (button.isConnected) button.classList.add('preview-error');
          }
        }
      })();
    };
    const scheduleThumbnails = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(renderThumbnailWindow);
    };
    const ensureThumbnailVisible = (pageNumber: number): void => {
      const top = (pageNumber - 1) * THUMBNAIL_ROW_HEIGHT;
      const bottom = top + THUMBNAIL_ROW_HEIGHT;
      if (top < rail.scrollTop || bottom > rail.scrollTop + rail.clientHeight) {
        rail.scrollTop = Math.max(0, top - Math.max(0, (rail.clientHeight - THUMBNAIL_ROW_HEIGHT) / 2));
      }
    };
    const showPage = async (pageNumber: number, revealThumbnail = true): Promise<void> => {
      currentPage = Math.max(1, Math.min(controller.pageCount, pageNumber));
      if (revealThumbnail) ensureThumbnailVisible(currentPage);
      scheduleThumbnails();
      await controller.render(currentPage, scale);
      markCurrent();
      updateZoom();
    };
    const setScale = async (nextScale: number): Promise<void> => {
      scale = clampScale(nextScale);
      await showPage(currentPage, false);
    };
    const fit = async (mode: 'width' | 'page'): Promise<void> => {
      const rect = canvas.getBoundingClientRect();
      const baseWidth = rect.width / scale;
      const baseHeight = rect.height / scale;
      if (!baseWidth || !baseHeight) return;
      const availableWidth = Math.max(240, shell.clientWidth - 32);
      const availableHeight = Math.max(360, Math.min(window.innerHeight * 0.72, 900) - 32);
      const nextScale = mode === 'width'
        ? availableWidth / baseWidth
        : Math.min(availableWidth / baseWidth, availableHeight / baseHeight);
      await setScale(nextScale);
    };

    const onRailScroll = (): void => scheduleThumbnails();
    const onRailClick = (event: Event): void => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('[data-pre-edit-thumbnail]');
      if (item?.dataset.preEditThumbnail) void showPage(Number(item.dataset.preEditThumbnail), false);
    };
    const onToolbarClick = (event: Event): void => {
      const target = event.target as HTMLElement;
      const pageDirection = target.closest<HTMLElement>('[data-pre-edit-page]')?.dataset.preEditPage;
      if (pageDirection) {
        void showPage(currentPage + (pageDirection === 'next' ? 1 : -1));
        return;
      }
      const action = target.closest<HTMLElement>('[data-pre-edit-view]')?.dataset.preEditView;
      if (action === 'zoom-in') void setScale(scale * 1.15);
      else if (action === 'zoom-out') void setScale(scale / 1.15);
      else if (action === 'actual') void setScale(1);
      else if (action === 'fit-width') void fit('width');
      else if (action === 'fit-page') void fit('page');
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); void showPage(currentPage - 1); }
      else if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); void showPage(currentPage + 1); }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); void setScale(scale * 1.15); }
      else if (event.key === '-') { event.preventDefault(); void setScale(scale / 1.15); }
      else if (event.key === '0') { event.preventDefault(); void setScale(1); }
    };

    rail.addEventListener('scroll', onRailScroll, { passive: true });
    rail.addEventListener('click', onRailClick);
    toolbar.addEventListener('click', onToolbarClick);
    shell.addEventListener('keydown', onKeyDown);
    session.cleanupViewer = () => {
      thumbnailGeneration += 1;
      if (frame) cancelAnimationFrame(frame);
      controller.cancelThumbnails();
      rail.removeEventListener('scroll', onRailScroll);
      rail.removeEventListener('click', onRailClick);
      toolbar.removeEventListener('click', onToolbarClick);
      shell.removeEventListener('keydown', onKeyDown);
    };

    await showPage(1);
    if (shell.clientWidth >= 640) await fit('page');
  } catch (error) {
    if (generation !== session.generation) return;
    session.panel.dataset.previewReady = 'false';
    const message = error instanceof Error ? error.message : 'Preview could not be opened.';
    body.innerHTML = `<div class="pre-edit-preview-error"><strong>Preview unavailable</strong><span>${escapeHtml(message)}</span><small>You can still use the tool when the source format is supported, for example to unlock an encrypted PDF.</small></div>`;
  }
}

async function renderActive(session: PreviewSession): Promise<void> {
  session.panel.hidden = session.files.length === 0;
  if (!session.files.length) {
    session.panel.dataset.previewReady = 'false';
    await destroyViewer(session);
    clearObjectUrls(session);
    return;
  }
  session.activeIndex = Math.max(0, Math.min(session.files.length - 1, session.activeIndex));
  renderSourceTabs(session);
  updateHint(session);
  const active = session.files[session.activeIndex]!;
  if (isPdf(active)) await renderPdfPreview(session, active);
  else if (session.files.every(isImage)) renderImagePreview(session);
}

function acceptFiles(root: HTMLElement, files: File[], append: boolean): void {
  if (!files.length || !shouldEnhance(root)) return;
  const supported = files.filter((file) => isPdf(file) || isImage(file));
  if (!supported.length) return;
  const session = getSession(root);
  session.files = append ? [...session.files, ...supported] : supported;
  session.activeIndex = append ? Math.max(0, session.files.length - supported.length) : 0;
  void renderActive(session);
}

function removePreviewFile(root: HTMLElement, button: HTMLElement): void {
  const session = sessions.get(root);
  if (!session) return;
  const aria = button.getAttribute('aria-label') ?? '';
  const name = aria.startsWith('Remove ') ? aria.slice('Remove '.length) : '';
  const index = name ? session.files.findIndex((file) => file.name === name) : -1;
  if (index >= 0) session.files.splice(index, 1);
  else if (session.files.length === 1) session.files = [];
  if (session.activeIndex >= session.files.length) session.activeIndex = Math.max(0, session.files.length - 1);
  void renderActive(session);
}

export function installPreEditPreview(): void {
  if (installed) return;
  installed = true;

  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || input.id !== 'workspace-file') return;
    const root = workspaceRoot(input);
    if (!root || !input.files?.length) return;
    acceptFiles(root, [...input.files], input.multiple);
  }, true);

  document.addEventListener('drop', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const dropZone = target.closest<HTMLElement>('.drop-zone');
    if (!dropZone || !event.dataTransfer?.files.length) return;
    const input = dropZone.querySelector<HTMLInputElement>('#workspace-file');
    const root = workspaceRoot(dropZone);
    if (!input || !root) return;
    acceptFiles(root, [...event.dataTransfer.files], input.multiple);
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const removeButton = target.closest<HTMLElement>('[data-remove]');
    if (!removeButton) return;
    const root = workspaceRoot(removeButton);
    if (!root) return;
    queueMicrotask(() => removePreviewFile(root, removeButton));
  }, true);

  document.addEventListener('close', (event) => {
    const dialog = event.target;
    if (!(dialog instanceof HTMLDialogElement) || !dialog.classList.contains('workspace-dialog')) return;
    const root = dialog.querySelector<HTMLElement>('.workspace');
    const session = root ? sessions.get(root) : undefined;
    if (session) void disposeSession(session);
  }, true);
}
