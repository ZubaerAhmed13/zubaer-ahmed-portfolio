import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

interface PdfMeta {
  pageCount: number;
  width: number | null;
  height: number | null;
  rotation: number;
}

interface ParityState {
  root: HTMLElement;
  files: File[];
  metadata: PdfMeta[];
  selectedCount: number;
  rebuilding: boolean;
  replacementIndex: number | null;
  generation: number;
  syncFrame: number;
  observer: MutationObserver | null;
}

const states = new WeakMap<HTMLElement, ParityState>();
let installed = false;
const observerOptions: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['hidden', 'aria-current']
};

function workspaceRoot(target: Element): HTMLElement | null {
  return target.closest<HTMLElement>('.workspace');
}

function toolName(root: HTMLElement): string {
  return root.querySelector<HTMLElement>('.legacy-title-block h2, .workspace-side h2')?.textContent?.trim() ?? '';
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function safePdfFilename(value: string): string {
  const withoutControls = [...value].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  }).join('');
  const stripped = withoutControls.replace(/[\\/:*?"<>|]/g, '').trim().replace(/^\.+/, '');
  const base = stripped || 'merged.pdf';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

async function readPdfMeta(file: File): Promise<PdfMeta> {
  if (!isPdf(file)) return { pageCount: 1, width: null, height: null, rotation: 0 };
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const pdf = await task.promise;
    const pageCount = pdf.numPages;
    let width: number | null = null;
    let height: number | null = null;
    let rotation = 0;
    if (pageCount > 0) {
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      width = Math.round(viewport.width);
      height = Math.round(viewport.height);
      rotation = page.rotate || 0;
      page.cleanup();
    }
    await pdf.destroy();
    return { pageCount, width, height, rotation };
  } catch {
    try { await task.destroy(); } catch { /* best effort */ }
    return { pageCount: 0, width: null, height: null, rotation: 0 };
  }
}

function totalPages(state: ParityState): number {
  return state.metadata.reduce((sum, meta) => sum + Math.max(0, meta.pageCount), 0);
}

function queueSync(state: ParityState): void {
  if (state.syncFrame) cancelAnimationFrame(state.syncFrame);
  state.syncFrame = requestAnimationFrame(() => {
    state.syncFrame = 0;
    state.observer?.disconnect();
    try {
      syncState(state);
    } finally {
      if (state.root.isConnected) state.observer?.observe(state.root, observerOptions);
    }
  });
}

async function refreshMetadata(state: ParityState): Promise<void> {
  const generation = ++state.generation;
  const metadata = await Promise.all(state.files.map((file) => readPdfMeta(file)));
  if (generation !== state.generation) return;
  state.metadata = metadata;
  state.selectedCount = Math.min(state.selectedCount, totalPages(state));
  queueSync(state);
}

function setFiles(state: ParityState, files: File[]): void {
  state.files = files;
  state.metadata = files.map(() => ({ pageCount: 0, width: null, height: null, rotation: 0 }));
  state.selectedCount = 0;
  state.root.dataset.parityFileCount = String(files.length);
  queueSync(state);
  void refreshMetadata(state);
}

function enhanceDropZone(state: ParityState): void {
  const drop = state.root.querySelector<HTMLElement>('.legacy-files-pane .drop-zone');
  const input = state.root.querySelector<HTMLInputElement>('#workspace-file');
  if (!drop || !input || drop.dataset.parityDrop === 'true') return;
  drop.dataset.parityDrop = 'true';
  const strong = drop.querySelector<HTMLElement>('strong');
  const detail = drop.querySelector<HTMLElement>('span');
  if (strong) strong.textContent = input.multiple ? 'Add compatible files' : 'Add a compatible file';
  if (detail) detail.textContent = input.multiple
    ? 'Files stay on this device · add in the order you want to process them'
    : 'The file stays on this device for local processing';
  const icon = document.createElement('span');
  icon.className = 'legacy-upload-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '↥';
  drop.prepend(icon);
  input.classList.add('legacy-native-file-input');
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'legacy-choose-files';
  choose.textContent = input.multiple ? 'Choose files' : 'Choose file';
  choose.addEventListener('click', () => input.click());
  drop.insertAdjacentElement('afterend', choose);
}

function ensureToolbar(state: ParityState): void {
  const toolbar = state.root.querySelector<HTMLElement>('.legacy-center-toolbar');
  const selection = toolbar?.querySelector<HTMLElement>('.legacy-selection-tools');
  const overview = toolbar?.querySelector<HTMLElement>('[data-legacy-overview]');
  if (!toolbar || !selection || !overview) return;
  if (!toolbar.querySelector('[data-parity-trash]')) {
    const destructive = document.createElement('div');
    destructive.className = 'legacy-toolbar-group legacy-page-edit-tools';
    destructive.innerHTML = '<button type="button" data-parity-trash disabled aria-label="Remove selected pages" title="Page removal remains tool-specific">♲</button><button type="button" data-parity-restore disabled>Restore</button>';
    selection.insertAdjacentElement('afterend', destructive);
  }
  if (!toolbar.querySelector('[data-parity-undo]')) {
    const history = document.createElement('div');
    history.className = 'legacy-toolbar-group legacy-history-tools';
    history.innerHTML = '<button type="button" data-parity-undo disabled aria-label="Undo">↶</button><button type="button" data-parity-redo disabled aria-label="Redo">↷</button>';
    overview.insertAdjacentElement('beforebegin', history);
  }
}

function ensureMergeSettings(state: ParityState): void {
  if (toolName(state.root) !== 'Merge PDF') return;
  const form = state.root.querySelector<HTMLFormElement>('#tool-options');
  if (!form) return;
  if (!form.querySelector('[data-parity-output-name]')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'legacy-output-name';
    wrapper.dataset.parityOutputName = 'true';
    wrapper.innerHTML = '<label>Output filename<input name="outputFilename" value="merged.pdf" autocomplete="off" spellcheck="false"></label><p class="help">Unsafe path and control characters are removed automatically.</p>';
    form.prepend(wrapper);
    const input = wrapper.querySelector<HTMLInputElement>('input[name="outputFilename"]');
    input?.addEventListener('blur', () => {
      if (input) input.value = safePdfFilename(input.value);
      applyDownloadName(state);
    });
  }
  if (!state.root.querySelector('[data-parity-file-status]')) {
    const status = document.createElement('div');
    status.className = 'legacy-file-added-status';
    status.dataset.parityFileStatus = 'true';
    status.hidden = true;
    form.insertAdjacentElement('afterend', status);
  }
}

function applyDownloadName(state: ParityState): void {
  if (toolName(state.root) !== 'Merge PDF') return;
  const input = state.root.querySelector<HTMLInputElement>('input[name="outputFilename"]');
  const anchor = state.root.querySelector<HTMLAnchorElement>('#result a.download');
  if (!input || !anchor) return;
  const name = safePdfFilename(input.value);
  if (anchor.download === name) return;
  anchor.download = name;
  const size = anchor.querySelector<HTMLElement>('span');
  if (size) anchor.replaceChildren(document.createTextNode(`Download ${name} `), size);
  else anchor.textContent = `Download ${name}`;
}

function ensureReplacementInput(state: ParityState): HTMLInputElement | null {
  const pane = state.root.querySelector<HTMLElement>('.legacy-files-pane');
  const source = state.root.querySelector<HTMLInputElement>('#workspace-file');
  if (!pane || !source) return null;
  let input = pane.querySelector<HTMLInputElement>('[data-parity-replacement-input]');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.accept = source.accept;
  input.hidden = true;
  input.dataset.parityReplacementInput = 'true';
  input.addEventListener('change', () => {
    const replacement = input?.files?.[0];
    const index = state.replacementIndex;
    state.replacementIndex = null;
    if (!replacement || index === null || index < 0 || index >= state.files.length) {
      if (input) input.value = '';
      return;
    }
    const next = [...state.files];
    next[index] = replacement;
    setFiles(state, next);
    rebuildWorkspaceFiles(state);
    if (input) input.value = '';
  });
  pane.append(input);
  return input;
}

function rebuildWorkspaceFiles(state: ParityState): void {
  const input = state.root.querySelector<HTMLInputElement>('#workspace-file');
  if (!input) return;
  try {
    state.rebuilding = true;
    const removeButtons = [...state.root.querySelectorAll<HTMLButtonElement>('#file-list [data-remove]')];
    for (const button of removeButtons.reverse()) button.click();
    const transfer = new DataTransfer();
    for (const file of state.files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch {
    // Some browsers may block synthetic FileList replacement. The next user file
    // change restores authoritative ordering without changing document bytes.
  } finally {
    window.setTimeout(() => {
      state.rebuilding = false;
      queueSync(state);
    }, 0);
  }
}

function enhanceFileRows(state: ParityState): void {
  const rows = [...state.root.querySelectorAll<HTMLElement>('#file-list .file-row')];
  rows.forEach((row, index) => {
    const file = state.files[index];
    if (!file) return;
    const meta = state.metadata[index];
    const size = row.querySelector<HTMLElement>('small');
    if (size) {
      const pageText = meta?.pageCount ? `${meta.pageCount} page${meta.pageCount === 1 ? '' : 's'} / ` : '';
      const nextText = `${pageText}${humanBytes(file.size)}`;
      if (size.textContent !== nextText) size.textContent = nextText;
    }
    row.querySelector<HTMLElement>('.order')?.setAttribute('aria-hidden', 'true');
    if (row.dataset.parityEnhanced === 'true') {
      row.querySelectorAll<HTMLButtonElement>('[data-parity-move]').forEach((button) => {
        const direction = Number(button.dataset.parityMove);
        button.disabled = direction < 0 ? index === 0 : index === state.files.length - 1;
      });
      return;
    }
    row.dataset.parityEnhanced = 'true';
    row.dataset.parityIndex = String(index);
    const remove = row.querySelector<HTMLButtonElement>('[data-remove]');
    const actions = document.createElement('div');
    actions.className = 'legacy-file-row-actions';
    const replace = document.createElement('button');
    replace.type = 'button';
    replace.dataset.parityReplace = String(index);
    replace.className = 'legacy-replace-file';
    replace.textContent = 'Replace';
    actions.append(replace);
    if (state.root.querySelector<HTMLInputElement>('#workspace-file')?.multiple) {
      const up = document.createElement('button');
      up.type = 'button';
      up.dataset.parityMove = '-1';
      up.dataset.parityIndex = String(index);
      up.className = 'legacy-file-move';
      up.setAttribute('aria-label', `Move ${file.name} up`);
      up.textContent = '⌃';
      up.disabled = index === 0;
      const down = document.createElement('button');
      down.type = 'button';
      down.dataset.parityMove = '1';
      down.dataset.parityIndex = String(index);
      down.className = 'legacy-file-move';
      down.setAttribute('aria-label', `Move ${file.name} down`);
      down.textContent = '⌄';
      down.disabled = index === state.files.length - 1;
      actions.append(up, down);
    }
    if (remove) actions.append(remove);
    row.append(actions);
  });
}

function syncPreviewMeta(state: ParityState): void {
  const toolbar = state.root.querySelector<HTMLElement>('.legacy-live-preview .pre-edit-viewer-toolbar');
  if (!toolbar) return;
  let right = toolbar.querySelector<HTMLElement>('[data-parity-page-meta]');
  if (!right) {
    right = document.createElement('span');
    right.dataset.parityPageMeta = 'true';
    right.className = 'legacy-page-meta';
    toolbar.append(right);
  }
  const activeSource = state.root.querySelector<HTMLButtonElement>('[data-pre-edit-source][aria-current="true"]');
  const index = activeSource ? Number(activeSource.dataset.preEditSource) : 0;
  const meta = state.metadata[index];
  const text = meta?.width && meta?.height ? `${meta.width} × ${meta.height} pt / ${meta.rotation} degrees` : '';
  if (right.textContent !== text) right.textContent = text;
}

function syncSelection(state: ParityState): void {
  const total = totalPages(state);
  const all = state.root.querySelector<HTMLButtonElement>('[data-legacy-select="all"]');
  const none = state.root.querySelector<HTMLButtonElement>('[data-legacy-select="none"]');
  const invert = state.root.querySelector<HTMLButtonElement>('[data-legacy-select="invert"]');
  if (all) all.disabled = total === 0;
  if (none) none.disabled = state.selectedCount === 0;
  if (invert) invert.disabled = total === 0;
  const selected = String(total > 0 && state.selectedCount === total);
  state.root.querySelectorAll<HTMLElement>('.pre-edit-thumbnail-item').forEach((item) => {
    if (item.dataset.paritySelected !== selected) item.dataset.paritySelected = selected;
  });
}

function syncFooter(state: ParityState): void {
  const footer = state.root.querySelector<HTMLElement>('[data-legacy-footer-state]');
  const text = `${state.selectedCount} selected / 0 removed / ${totalPages(state)} output pages`;
  if (footer && footer.textContent !== text) footer.textContent = text;
}

function syncSettingsStatus(state: ParityState): void {
  const status = state.root.querySelector<HTMLElement>('[data-parity-file-status]');
  if (!status) return;
  const count = state.files.length;
  status.hidden = count === 0;
  const text = count ? `${count} file${count === 1 ? '' : 's'} added.` : '';
  if (status.textContent !== text) status.textContent = text;
}

function syncState(state: ParityState): void {
  if (!state.root.isConnected) return;
  state.root.dataset.parityFileCount = String(state.files.length);
  enhanceDropZone(state);
  ensureToolbar(state);
  ensureMergeSettings(state);
  ensureReplacementInput(state);
  enhanceFileRows(state);
  syncPreviewMeta(state);
  syncSelection(state);
  syncFooter(state);
  syncSettingsStatus(state);
  applyDownloadName(state);
}

function ensureState(root: HTMLElement): ParityState {
  const existing = states.get(root);
  if (existing) return existing;
  const state: ParityState = {
    root,
    files: [],
    metadata: [],
    selectedCount: 0,
    rebuilding: false,
    replacementIndex: null,
    generation: 0,
    syncFrame: 0,
    observer: null
  };
  states.set(root, state);
  const observer = new MutationObserver(() => queueSync(state));
  observer.observe(root, observerOptions);
  state.observer = observer;

  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const select = target.closest<HTMLElement>('[data-legacy-select]')?.dataset.legacySelect;
    const total = totalPages(state);
    if (select === 'all') state.selectedCount = total;
    else if (select === 'none') state.selectedCount = 0;
    else if (select === 'invert') state.selectedCount = Math.max(0, total - state.selectedCount);
    else {
      const replace = target.closest<HTMLElement>('[data-parity-replace]');
      if (replace?.dataset.parityReplace) {
        state.replacementIndex = Number(replace.dataset.parityReplace);
        ensureReplacementInput(state)?.click();
        return;
      }
      const move = target.closest<HTMLElement>('[data-parity-move]');
      if (move?.dataset.parityMove && move.dataset.parityIndex) {
        const index = Number(move.dataset.parityIndex);
        const other = index + Number(move.dataset.parityMove);
        if (index >= 0 && other >= 0 && index < state.files.length && other < state.files.length) {
          const next = [...state.files];
          [next[index], next[other]] = [next[other]!, next[index]!];
          setFiles(state, next);
          rebuildWorkspaceFiles(state);
        }
        return;
      }
      return;
    }
    queueSync(state);
  });

  root.addEventListener('docflow-cleanup', () => {
    observer.disconnect();
    if (state.syncFrame) cancelAnimationFrame(state.syncFrame);
    state.generation += 1;
    states.delete(root);
  }, { once: true });
  queueSync(state);
  return state;
}

function enhanceAvailable(): void {
  document.querySelectorAll<HTMLElement>('.workspace .legacy-editor-shell').forEach((shell) => {
    const root = shell.closest<HTMLElement>('.workspace');
    if (root) ensureState(root);
  });
}

export function installLegacyScreenshotParity(): void {
  if (installed) return;
  installed = true;
  const bodyObserver = new MutationObserver(enhanceAvailable);
  bodyObserver.observe(document.body, { subtree: true, childList: true });
  enhanceAvailable();

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== 'workspace-file' || !target.files?.length) return;
    const root = workspaceRoot(target);
    if (!root) return;
    const state = ensureState(root);
    if (state.rebuilding) return;
    const selected = [...target.files];
    setFiles(state, target.multiple ? [...state.files, ...selected] : selected.slice(0, 1));
  }, true);

  document.addEventListener('drop', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const drop = target?.closest<HTMLElement>('.drop-zone');
    if (!drop || !event.dataTransfer?.files.length) return;
    const root = workspaceRoot(drop);
    const input = drop.querySelector<HTMLInputElement>('#workspace-file');
    if (!root || !input) return;
    const state = ensureState(root);
    if (state.rebuilding) return;
    const selected = [...event.dataTransfer.files];
    setFiles(state, input.multiple ? [...state.files, ...selected] : selected.slice(0, 1));
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const remove = target?.closest<HTMLElement>('#file-list [data-remove]');
    if (!remove) return;
    const root = workspaceRoot(remove);
    if (!root) return;
    const state = states.get(root);
    if (!state || state.rebuilding) return;
    const row = remove.closest<HTMLElement>('.file-row');
    const rows = [...root.querySelectorAll<HTMLElement>('#file-list .file-row')];
    const index = row ? rows.indexOf(row) : -1;
    if (index < 0) return;
    const next = [...state.files];
    next.splice(index, 1);
    setFiles(state, next);
  }, true);
}
