import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function overflowTarget(target: EventTarget | null): HTMLElement | null {
  let element = target instanceof Element ? target : null;
  if (element?.closest?.('[role="tooltip"], [data-overflow-tooltip="off"]')) return null;
  while (element && element !== document.body) {
    if (element instanceof HTMLElement && !element.matches('input, textarea, select, [role="tooltip"]')) {
      const style = getComputedStyle(element);
      const clamped = Number.parseInt(style.webkitLineClamp, 10) > 0;
      const expandedText = element.dataset?.fullText;
      if ((expandedText && expandedText !== element.textContent?.trim() ||
          style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1 ||
          clamped && element.scrollHeight > element.clientHeight + 1) && element.textContent?.trim()) return element;
    }
    element = element.parentElement;
  }
  return null;
}

/** One overflow hint across tables, drawers and public pages. / 表格、抽屉和公开页面共用截断提示。 */
export function OverflowTooltip() {
  const id = useId();
  const tooltip = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<{ anchor: HTMLElement; text: string } | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let originalTitle: string | null = null;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      if (!anchor) return;
      if (originalTitle !== null && !anchor.hasAttribute('title')) anchor.setAttribute('title', originalTitle);
      const describedBy = anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(value => value && value !== id).join(' ');
      if (describedBy) anchor.setAttribute('aria-describedby', describedBy);
      else anchor.removeAttribute('aria-describedby');
      anchor = null;
    };
    const dismiss = () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      restore();
      setHint(null);
    };
    const enter = (event: Event) => {
      if (tooltip.current?.contains(event.target as Node)) { clearTimeout(hideTimer); return; }
      const next = overflowTarget(event.target);
      if (next === anchor) { clearTimeout(hideTimer); return; }
      dismiss();
      if (!next) return;
      showTimer = setTimeout(() => {
        if (!next.isConnected) return;
        const described = next.closest('[aria-describedby]')?.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
        if (described.some(value => document.getElementById(value)?.getAttribute('role') === 'tooltip')) return;
        anchor = next;
        originalTitle = next.getAttribute('title');
        const text = next.dataset.fullText || next.textContent?.trim() || '';
        const fullText = originalTitle && !text.includes(originalTitle) ? `${text}\n${originalTitle}` : text;
        next.removeAttribute('title');
        next.setAttribute('aria-describedby', [next.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
        setPosition(null);
        setHint({ anchor: next, text: fullText });
      }, 250);
    };
    const leave = (event: Event) => {
      const related = (event as MouseEvent | FocusEvent).relatedTarget;
      if (related instanceof Node && (anchor?.contains(related) || tooltip.current?.contains(related))) return;
      clearTimeout(showTimer);
      hideTimer = setTimeout(dismiss, 150);
    };
    const onPointer = (event: PointerEvent) => { if (event.pointerType !== 'touch') enter(event); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    const onScroll = (event: Event) => { if (!tooltip.current?.contains(event.target as Node)) dismiss(); };
    document.addEventListener('pointerover', onPointer);
    document.addEventListener('pointerout', leave);
    document.addEventListener('pointerdown', onScroll);
    document.addEventListener('focusin', enter);
    document.addEventListener('focusout', leave);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', dismiss);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      restore();
      document.removeEventListener('pointerover', onPointer);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('pointerdown', onScroll);
      document.removeEventListener('focusin', enter);
      document.removeEventListener('focusout', leave);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [id]);

  useLayoutEffect(() => {
    if (!hint || !tooltip.current) return;
    const bounds = hint.anchor.getBoundingClientRect();
    const size = tooltip.current.getBoundingClientRect();
    const below = bounds.bottom + 8;
    setPosition({
      top: Math.max(12, below + size.height <= window.innerHeight - 12 ? below : bounds.top - size.height - 8),
      left: Math.max(12, Math.min(bounds.left + (bounds.width - size.width) / 2, window.innerWidth - size.width - 12)),
    });
  }, [hint]);

  if (!hint) return null;
  return createPortal(
    <div ref={tooltip} id={id} role="tooltip" data-react-aria-top-layer="true"
      className="polaris-overflow-hint fixed z-[100000] max-h-[min(24rem,60vh)] max-w-[min(26rem,calc(100vw-24px))] overflow-y-auto rounded-lg border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-[var(--polaris-ink)] shadow-[var(--polaris-shadow-float)] [overflow-wrap:anywhere]"
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}>
      {hint.text}
    </div>, document.body,
  );
}
