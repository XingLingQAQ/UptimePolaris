import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface FilterOption { value: string; label: string; icon?: ReactNode }

export function FilterSelect({ label, value, options, onChange, className, leading }: {
  label: string; value: string; options: FilterOption[]; onChange: (value: string) => void; className?: string; leading?: ReactNode;
}) {
  const id = useId();
  const selectedIndex = options.findIndex(option => option.value === value);
  const selected = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: -9999, left: 0, width: 180, height: 300 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16);
    const panelWidth = Math.min(Math.max(width, panel.current?.getBoundingClientRect().width ?? width), window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 14;
    const above = rect.top - 14;
    const upwards = below < 180 && above > below;
    const height = Math.max(44, Math.min(304, upwards ? above : below));
    const panelHeight = Math.min(panel.current?.scrollHeight ?? height, height);
    setPosition({ width, height, left: Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8)), top: upwards ? rect.top - panelHeight - 6 : rect.bottom + 6 });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) place();
    };
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  const show = (index = selectedIndex < 0 ? 0 : selectedIndex) => { setActive(index); setOpen(true); };
  const choose = (index: number) => {
    if (options[index]) onChange(options[index].value);
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (key === 'Escape') setOpen(false);
      else if (key === 'Home') show(0);
      else if (key === 'End') show(options.length - 1);
      else if (key === 'Enter' || key === ' ') { if (open) choose(active); else show(); }
      else if (!open) show();
      else setActive(index => (index + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (key === 'Tab') setOpen(false);
    else if (key.length === 1) {
      event.stopPropagation();
      const now = Date.now();
      const query = now - typed.current.at < 700 ? typed.current.text + key : key;
      typed.current = { text: query, at: now };
      const text = query.toLocaleLowerCase();
      const match = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(text));
      if (match >= 0) show(match);
    }
  };

  return <>
    <button ref={trigger} type="button" role="combobox" className={clsx('server-filter-trigger', className)} aria-label={label} title={`${label}: ${selected?.label ?? ''}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      data-keyboard-menu onKeyDown={onKeyDown} onBlur={() => setOpen(false)} onClick={() => { if (open) setOpen(false); else show(); }}>
      {leading}{selected?.icon}<span className="server-filter-value truncate">{selected?.label ?? label}</span><ChevronDown size={13} aria-hidden="true" className={clsx('server-filter-chevron', open && 'is-open')} />
    </button>
    {open ? createPortal(<div ref={panel} id={id} role="listbox" aria-label={label} data-keyboard-menu className="server-filter-menu polaris-scrollbar" style={{ position: 'fixed', top: position.top, left: position.left, minWidth: position.width, maxWidth: 'calc(100vw - 16px)', maxHeight: position.height }}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === value} className={clsx('server-filter-option', index === active && 'is-active', option.value === value && 'is-selected')}
        onPointerDown={event => event.preventDefault()} onPointerMove={event => { if (event.pointerType === 'mouse') setActive(index); }} onClick={() => choose(index)}>
        {option.icon}<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option.label}</span>{option.value === value ? <Check size={14} className="shrink-0" aria-hidden="true" /> : <span className="w-3.5 shrink-0" />}
      </div>)}
    </div>, document.body) : null}
  </>;
}
