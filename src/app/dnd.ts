// Zeigerbasiertes Drag-and-drop innerhalb der App. HTML5-Drag-and-drop ist in Tauri unter Windows
// durch die native Dateiablage belegt; außerdem funktioniert dieser Weg gleich für Maus, Stift und Touch.
// Jede Drag-Aktion hat zusätzlich eine Menü- oder Tastaturalternative (§3.2).

export type DragPayload = { type: 'documents'; ids: string[] } | { type: 'folder'; id: string } | { type: 'page'; id: string };

type DropHandler = (payload: DragPayload, target: HTMLElement, e: PointerEvent) => void;

const handlers = new Map<string, DropHandler>();

export function registerDrop(key: string, handler: DropHandler) {
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key);
  };
}

export function beginPointerDrag(e: React.PointerEvent, payload: DragPayload, label: string) {
  if (e.button !== 0 || e.pointerType === 'touch') return;
  const startX = e.clientX, startY = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let over: HTMLElement | null = null;
  const findTarget = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest<HTMLElement>('[data-drop]') ?? null;
  };
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.body.classList.add('dragging');
    }
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
    const t = findTarget(ev.clientX, ev.clientY);
    if (t !== over) {
      over?.classList.remove('drop-over');
      t?.classList.add('drop-over');
      over = t;
    }
    if (over) {
      const r = over.getBoundingClientRect();
      over.dataset.dropHalf = ev.clientY < r.top + r.height / 2 ? 'before' : 'after';
    }
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    document.body.classList.remove('dragging');
    over?.classList.remove('drop-over');
    if (ghost) {
      ghost.remove();
      const t = findTarget(ev.clientX, ev.clientY);
      const key = t?.dataset.drop;
      if (t && key) handlers.get(key.split(':')[0])?.(payload, t, ev);
      // Klick nach einem Drag unterdrücken
      const stop = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 50);
    }
  };
  const cancel = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    document.body.classList.remove('dragging');
    over?.classList.remove('drop-over');
    ghost?.remove();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}
