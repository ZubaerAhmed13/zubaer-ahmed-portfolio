interface GuardState {
  root: HTMLElement;
  selectedCount: number;
  frame: number;
  observer: MutationObserver;
}

const states = new WeakMap<HTMLElement, GuardState>();
let installed = false;

const observerOptions: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['hidden', 'aria-current']
};

function pageCountFromRows(root: HTMLElement): number {
  let total = 0;
  root.querySelectorAll<HTMLElement>('#file-list .file-row small').forEach((node) => {
    const match = node.textContent?.match(/^(\d+)\s+pages?\b/i);
    if (match) total += Number(match[1]);
  });
  return total;
}

function claimLegacyUi(root: HTMLElement): void {
  const legacyCount = root.querySelector<HTMLElement>('[data-legacy-file-count]');
  if (legacyCount) {
    legacyCount.removeAttribute('data-legacy-file-count');
    legacyCount.dataset.legacyFileCountUi = 'true';
  }

  const legacyFooter = root.querySelector<HTMLElement>('[data-legacy-footer-state]');
  if (legacyFooter) {
    legacyFooter.removeAttribute('data-legacy-footer-state');
    legacyFooter.dataset.legacyFooterStateUi = 'true';
  }

  const legacyEmpty = root.querySelector<HTMLElement>('.legacy-preview-empty');
  if (legacyEmpty) {
    legacyEmpty.classList.remove('legacy-preview-empty');
    legacyEmpty.classList.add('legacy-preview-empty-ui');
  }
}

function sync(state: GuardState): void {
  const { root } = state;
  if (!root.isConnected) return;
  claimLegacyUi(root);

  const fileCount = root.querySelector<HTMLElement>('[data-legacy-file-count-ui]');
  const rows = root.querySelectorAll('#file-list .file-row').length;
  if (fileCount && fileCount.textContent !== String(rows)) fileCount.textContent = String(rows);

  const totalPages = pageCountFromRows(root);
  state.selectedCount = Math.min(state.selectedCount, totalPages);
  const footer = root.querySelector<HTMLElement>('[data-legacy-footer-state-ui]');
  const footerText = `${state.selectedCount} selected / 0 removed / ${totalPages} output pages`;
  if (footer && footer.textContent !== footerText) footer.textContent = footerText;

  const empty = root.querySelector<HTMLElement>('.legacy-preview-empty-ui');
  const preview = root.querySelector<HTMLElement>('.pre-edit-preview');
  const shouldHideEmpty = Boolean(preview && !preview.hidden);
  if (empty && empty.hidden !== shouldHideEmpty) empty.hidden = shouldHideEmpty;
}

function queueSync(state: GuardState): void {
  if (state.frame) cancelAnimationFrame(state.frame);
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    state.observer.disconnect();
    try {
      sync(state);
    } finally {
      if (state.root.isConnected) state.observer.observe(state.root, observerOptions);
    }
  });
}

function guardRoot(root: HTMLElement): void {
  if (states.has(root)) return;
  const state: GuardState = {
    root,
    selectedCount: 0,
    frame: 0,
    observer: new MutationObserver(() => queueSync(state))
  };
  states.set(root, state);

  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const mode = target?.closest<HTMLElement>('[data-legacy-select]')?.dataset.legacySelect;
    if (!mode) return;
    const total = pageCountFromRows(root);
    if (mode === 'all') state.selectedCount = total;
    else if (mode === 'none') state.selectedCount = 0;
    else if (mode === 'invert') state.selectedCount = Math.max(0, total - state.selectedCount);
    queueSync(state);
  });

  root.addEventListener('docflow-cleanup', () => {
    state.observer.disconnect();
    if (state.frame) cancelAnimationFrame(state.frame);
    states.delete(root);
  }, { once: true });

  claimLegacyUi(root);
  state.observer.observe(root, observerOptions);
  queueSync(state);
}

function findWorkspaces(): void {
  document.querySelectorAll<HTMLElement>('.workspace .legacy-editor-shell').forEach((shell) => {
    const root = shell.closest<HTMLElement>('.workspace');
    if (root) guardRoot(root);
  });
}

export function installLegacyExactLoopGuard(): void {
  if (installed) return;
  installed = true;
  const observer = new MutationObserver(findWorkspaces);
  observer.observe(document.body, { subtree: true, childList: true });
  findWorkspaces();
}
