let installed = false;

function normalizeSourceButton(button: HTMLButtonElement): void {
  if (button.dataset.sourceLabelNormalized === 'true') return;
  const index = Number(button.dataset.preEditSource ?? '0');
  const fileName = button.textContent?.trim() || button.title.replace(/^Preview\s+/, '') || `source ${index + 1}`;
  button.dataset.sourceLabelNormalized = 'true';
  button.dataset.sourceFileName = fileName;
  button.textContent = `PDF ${index + 1}`;
  button.setAttribute('aria-label', `Preview source ${index + 1}: ${fileName}`);
  button.title = fileName;
}

function normalizeSources(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-pre-edit-source]').forEach(normalizeSourceButton);
}

export function installPreEditPreviewLabels(): void {
  if (installed) return;
  installed = true;
  normalizeSources();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('[data-pre-edit-source]') && node instanceof HTMLButtonElement) normalizeSourceButton(node);
        normalizeSources(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
