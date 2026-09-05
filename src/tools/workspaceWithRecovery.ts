import type { ToolDefinition } from './registry';
import { mountWorkspace as mountBaseWorkspace } from './workspace';
import { clearProjectSnapshot, loadProjectSnapshot, saveProjectSnapshot, type ProjectFileMetadata, type ProjectOptionValue } from '../app/projectStore';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character] ?? character));
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB','MB','GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function metadataFromFiles(files: File[]): ProjectFileMetadata[] {
  return files.map((file) => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }));
}

function collectOptions(form: HTMLFormElement): Record<string, ProjectOptionValue> {
  const values: Record<string, ProjectOptionValue> = {};
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[name],select[name],textarea[name]').forEach((control) => {
    if (!control.name || (control instanceof HTMLInputElement && control.type === 'file')) return;
    if (control instanceof HTMLInputElement && control.type === 'checkbox') values[control.name] = control.checked;
    else values[control.name] = control.value;
  });
  return values;
}

function applyOptions(form: HTMLFormElement, options: Record<string, ProjectOptionValue>): void {
  for (const [name, value] of Object.entries(options)) {
    const control = form.elements.namedItem(name);
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue;
    if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = value === true;
    else if (typeof value === 'string') control.value = value;
  }
}

export function mountWorkspace(container: HTMLDivElement, tool: ToolDefinition): void {
  mountBaseWorkspace(container, tool);

  const fileInput = container.querySelector<HTMLInputElement>('#workspace-file');
  const fileList = container.querySelector<HTMLDivElement>('#file-list');
  const optionsForm = container.querySelector<HTMLFormElement>('#tool-options');
  const memoryWarning = container.querySelector<HTMLDivElement>('#memory-warning');
  if (!fileInput || !fileList || !optionsForm || !memoryWarning) return;

  const recoveryPanel = document.createElement('div');
  recoveryPanel.className = 'notice';
  recoveryPanel.dataset.recoveryPanel = 'true';
  recoveryPanel.hidden = true;
  memoryWarning.insertAdjacentElement('afterend', recoveryPanel);

  const saveStatus = document.createElement('div');
  saveStatus.className = 'help';
  saveStatus.dataset.projectSaveStatus = 'true';
  saveStatus.setAttribute('aria-live', 'polite');
  optionsForm.insertAdjacentElement('afterend', saveStatus);

  let fileMetadata: ProjectFileMetadata[] = [];
  let disposed = false;
  let touched = false;
  let saveTimer: number | null = null;
  let generation = 0;
  let persistChain: Promise<void> = Promise.resolve();

  const showRecovery = (updatedAt: string): void => {
    const files = fileMetadata.length
      ? `<ul>${fileMetadata.map((file) => `<li><strong>${escapeHtml(file.name)}</strong> — ${humanBytes(file.size)}</li>`).join('')}</ul>`
      : '<p>No file metadata was saved for this session.</p>';
    recoveryPanel.innerHTML = `<strong>Recovered local project state</strong><p>Settings from ${escapeHtml(new Date(updatedAt).toLocaleString())} were restored. PDF/image contents were not stored; reselect the original file${fileMetadata.length === 1 ? '' : 's'} to continue.</p>${files}<button type="button" class="secondary" data-clear-recovery>Clear recovery</button>`;
    recoveryPanel.hidden = false;
  };

  const persist = async (currentGeneration: number): Promise<void> => {
    if (disposed || currentGeneration !== generation) return;
    try {
      const snapshot = await saveProjectSnapshot({ toolId: tool.id, files: fileMetadata, options: collectOptions(optionsForm) });
      if (disposed || currentGeneration !== generation) return;
      saveStatus.textContent = `Recovery state saved locally at ${new Date(snapshot.updatedAt).toLocaleTimeString()}.`;
    } catch {
      if (!disposed && currentGeneration === generation) saveStatus.textContent = 'Local recovery storage is unavailable in this browser context.';
    }
  };

  const schedulePersist = (): void => {
    touched = true;
    generation += 1;
    const scheduledGeneration = generation;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveStatus.textContent = 'Saving recovery state locally…';
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      persistChain = persistChain.then(
        () => persist(scheduledGeneration),
        () => persist(scheduledGeneration)
      );
    }, 120);
  };

  fileInput.addEventListener('change', () => {
    const selected = [...(fileInput.files ?? [])];
    fileMetadata = metadataFromFiles(tool.multipleFiles ? selected : selected.slice(0, 1));
    schedulePersist();
  }, { capture: true });

  const dropZone = container.querySelector<HTMLDivElement>('.drop-zone');
  dropZone?.addEventListener('drop', (event) => {
    const selected = [...(event.dataTransfer?.files ?? [])];
    if (!selected.length) return;
    fileMetadata = metadataFromFiles(tool.multipleFiles ? selected : selected.slice(0, 1));
    schedulePersist();
  }, { capture: true });

  fileList.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.file-row');
    const remove = (event.target as HTMLElement).closest('[data-remove]');
    if (!row || !remove) return;
    const rows = [...fileList.querySelectorAll<HTMLElement>('.file-row')];
    const index = rows.indexOf(row);
    if (index >= 0) fileMetadata.splice(index, 1);
    schedulePersist();
  }, { capture: true });

  optionsForm.addEventListener('input', schedulePersist);
  optionsForm.addEventListener('change', schedulePersist);

  recoveryPanel.addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('[data-clear-recovery]')) return;
    generation += 1;
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistChain = persistChain.then(async () => {
      await clearProjectSnapshot();
      if (disposed) return;
      fileMetadata = [];
      recoveryPanel.hidden = true;
      saveStatus.textContent = 'Local recovery state cleared.';
    }).catch(() => {
      if (!disposed) saveStatus.textContent = 'Could not clear local recovery state.';
    });
  });

  void loadProjectSnapshot().then((snapshot) => {
    if (disposed || touched || !snapshot || snapshot.toolId !== tool.id) return;
    fileMetadata = snapshot.files.map((file) => ({ ...file }));
    applyOptions(optionsForm, snapshot.options);
    showRecovery(snapshot.updatedAt);
  }).catch(() => {
    if (!disposed) saveStatus.textContent = 'Local recovery storage is unavailable in this browser context.';
  });

  container.addEventListener('docflow-cleanup', () => {
    disposed = true;
    generation += 1;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
  }, { once: true });
}
