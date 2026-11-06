import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, HardDrive, RefreshCcw, ShieldCheck } from 'lucide-react';
import type { BackupStatus } from '../../domain/types';
import { api, errorMessage, isTauri } from '../../ipc/api';
import { confirmDialog, formatBytes, formatDate, Modal, openDialog, toast } from '../../app/ui';

export const BACKUP_PROMPT_KEY = 'campus.backupPromptDismissed';

function BackupPanel({ close, onLibrarySwitched }: { close: () => void; onLibrarySwitched?: () => void }) {
  const [st, setSt] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    try {
      setSt(await api.backupStatus());
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
      void load();
    }
  };
  const desktop = isTauri();
  return (
    <Modal title="Sicherung und Wiederherstellung" width={620} onClose={close} footer={<button onClick={close}>Schließen</button>}>
      {!desktop && <div className="banner warn"><AlertTriangle size={16} /><span>Browser-Vorschau: Sicherungen funktionieren nur in der installierten Desktop-App.</span></div>}
      <section className="panel-section">
        <h3><HardDrive size={16} /> Sicherungsziel</h3>
        {st?.target ? (
          <p>
            <code>{st.target}</code> {st.targetReachable ? <span className="ok-text">erreichbar</span> : <span className="err-text">nicht erreichbar</span>}
          </p>
        ) : (
          <p className="muted">Noch kein Ziel gewählt. Am besten ein zweites Laufwerk oder einen USB-Stick verwenden.</p>
        )}
        {st?.sameDriveWarning && (
          <div className="banner warn"><AlertTriangle size={16} /><span>Das Ziel liegt auf demselben Laufwerk wie die Bibliothek. Das schützt nicht vor einem Laufwerksausfall.</span></div>
        )}
        <button disabled={!!busy} onClick={() => void run('target', async () => { await api.backupChooseTarget(); })}>
          <FolderOpen size={15} /> {st?.target ? 'Ziel ändern …' : 'Ziel wählen …'}
        </button>
      </section>
      <section className="panel-section">
        <h3><ShieldCheck size={16} /> Status</h3>
        {st?.lastSuccess ? (
          <p><CheckCircle2 size={15} className="ok-text" /> Letzte erfolgreiche Sicherung: {formatDate(st.lastSuccess.finishedAt)} ({st.lastSuccess.kind === 'auto' ? 'automatisch' : st.lastSuccess.kind === 'manual' ? 'manuell' : 'vor Migration'})</p>
        ) : (
          <p className="muted">Noch keine erfolgreiche Sicherung.</p>
        )}
        {st?.lastRun?.status === 'failed' && <p className="err-text"><AlertTriangle size={15} /> Letzter Versuch fehlgeschlagen: {st.lastRun.message}</p>}
        <p className="muted small">Automatisch einmal täglich nach Änderungen, solange die App geöffnet ist. Aufbewahrt werden 7 tägliche und 4 wöchentliche automatische Sicherungen; manuelle Sicherungen werden nie automatisch gelöscht.</p>
        <button
          className="primary"
          disabled={!!busy || !st?.target}
          onClick={() =>
            void run('create', async () => {
              const r = await api.backupCreate('manual');
              if (r) toast(`Sicherung erstellt und geprüft: ${r.fileName} (${formatBytes(r.totalBytes)})`, 'success', 7000);
            })
          }
        >
          {busy === 'create' ? 'Sichert …' : 'Backup jetzt erstellen'}
        </button>
      </section>
      {st && st.backups.length > 0 && (
        <section className="panel-section">
          <h3>Vorhandene Sicherungen</h3>
          <ul className="backup-list">
            {st.backups.slice(0, 12).map((b) => (
              <li key={b.path}>
                <span>{b.fileName}</span>
                <span className="muted">{b.kind === 'auto' ? 'automatisch' : b.kind === 'manual' ? 'manuell' : 'Migration'} · {formatBytes(b.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel-section">
        <h3><RefreshCcw size={16} /> Prüfen und wiederherstellen</h3>
        <div className="row-gap">
          <button
            disabled={!!busy}
            onClick={() =>
              void run('verify', async () => {
                const v = await api.backupVerifyPick();
                if (v) toast(`Sicherung ist gültig: ${v.documentCount} Dokument(e), ${v.fileCount} Dateien, erstellt ${formatDate(v.createdAt)}.`, 'success', 8000);
              })
            }
          >
            Sicherung prüfen …
          </button>
          <button
            disabled={!!busy}
            onClick={() =>
              void run('restore', async () => {
                const ok = await confirmDialog(
                  'Sicherung wiederherstellen',
                  <>Die Sicherung wird vollständig geprüft und in ein <strong>neues</strong> Bibliotheksverzeichnis eingespielt. Danach öffnet Campus die wiederhergestellte Bibliothek. Deine aktuelle Bibliothek bleibt unverändert erhalten.</>,
                  'Datei wählen …',
                );
                if (!ok) return;
                const info = await api.backupRestorePick();
                if (info) {
                  toast(`Wiederhergestellt nach ${info.root}.`, 'success', 8000);
                  close();
                  onLibrarySwitched?.();
                }
              })
            }
          >
            Sicherung wiederherstellen …
          </button>
        </div>
      </section>
      {st && <p className="muted small">Bibliotheksort: <code>{st.libraryRoot}</code>. Netzwerkfreigaben und synchronisierte Cloud-Ordner sind als Bibliotheksort nicht unterstützt.</p>}
    </Modal>
  );
}

let switchedHandler: (() => void) | undefined;
export function setLibrarySwitchedHandler(h: () => void) {
  switchedHandler = h;
}

export function openBackupPanel() {
  openDialog((close) => <BackupPanel close={close} onLibrarySwitched={switchedHandler} />);
}
