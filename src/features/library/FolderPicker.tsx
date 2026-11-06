import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, Library } from 'lucide-react';
import type { FolderRec } from '../../domain/types';
import { Modal } from '../../app/ui';

/** Ordnerauswahl als Tastatur- und Menüalternative zu Drag-and-drop. */
export function FolderPicker(props: {
  title: string;
  folders: FolderRec[];
  initial: string | null;
  exclude?: string | null;
  confirm: string;
  onDone: (folderId: string | null | undefined) => void;
}) {
  const [sel, setSel] = useState<string | null>(props.initial);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const excluded = new Set<string>();
  if (props.exclude) {
    const stack = [props.exclude];
    while (stack.length) {
      const id = stack.pop()!;
      excluded.add(id);
      props.folders.filter((f) => f.parentId === id).forEach((f) => stack.push(f.id));
    }
  }
  const render = (parent: string | null, depth: number) =>
    props.folders
      .filter((f) => f.parentId === parent && !excluded.has(f.id))
      .map((f) => {
        const kids = props.folders.some((c) => c.parentId === f.id && !excluded.has(c.id));
        return (
          <div key={f.id}>
            <div className={`tree-row ${sel === f.id ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}>
              <button className="twisty" aria-label={open[f.id] ? 'Zuklappen' : 'Aufklappen'} disabled={!kids} onClick={() => setOpen({ ...open, [f.id]: !open[f.id] })}>
                {kids ? open[f.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
              </button>
              <button className="tree-label" onClick={() => setSel(f.id)} onDoubleClick={() => props.onDone(f.id)}>
                <Folder size={15} /> {f.name}
              </button>
            </div>
            {open[f.id] && render(f.id, depth + 1)}
          </div>
        );
      });
  return (
    <Modal
      title={props.title}
      onClose={() => props.onDone(undefined)}
      footer={
        <>
          <button onClick={() => props.onDone(undefined)}>Abbrechen</button>
          <button className="primary" onClick={() => props.onDone(sel)}>
            {props.confirm}
          </button>
        </>
      }
    >
      <div className="picker-tree" role="tree">
        <div className={`tree-row ${sel === null ? 'active' : ''}`}>
          <span className="twisty" />
          <button className="tree-label" onClick={() => setSel(null)}>
            <Library size={15} /> Bibliothek (oberste Ebene)
          </button>
        </div>
        {render(null, 1)}
      </div>
    </Modal>
  );
}
