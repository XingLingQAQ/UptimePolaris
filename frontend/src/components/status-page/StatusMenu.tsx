import clsx from 'clsx';
import { FEEDBACK_TRANSITION, NAV_TRANSITION } from '@/lib/motion';
import { motion } from 'framer-motion';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';

/**
 * A small anchored menu, without a design-system dependency.
 *
 * The theme and language switches in the site header used HeroUI's `Dropdown`,
 * which meant the public page - whose header is the only place those switches
 * appear - had to download the whole HeroUI chunk for a four-item list in a
 * popover. The header is shared by the console and the public page, so the
 * replacement has to work in both; nothing here needs overlays, focus
 * containment or animation to be correct, so it is written by hand.
 *
 * The panel is portalled to `<body>`. That is not decoration: the public
 * header applies sizing to every descendant button (`[&_button]:h-8`), so a
 * panel rendered inside it would inherit the trigger's 32px box and stack its
 * items into the wrong shape.
 *
 * 页头主题和语言切换曾使用 HeroUI Dropdown，导致公开页面为几个菜单项下载完整 HeroUI
 * chunk。页头同时供公开页和控制台使用；替代菜单需兼容两者，且无需依靠浮层、焦点约束
 * 或动画即可正确工作，因此手写。菜单通过 portal 挂载到 `<body>`：公开页头给所有
 * 后代按钮设置 32px 高度，若面板位于其中，菜单项会继承触发器尺寸并排列错误。
 */

interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  selected?: boolean;
}

export function MenuButton({
  label,
  trigger,
  items,
  align = 'end',
}: {
  /** Accessible name for the trigger and the list, e.g. "Switch Theme". / 触发器和列表的无障碍名称，例如“切换主题”。 */
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const previousPathname = useRef(pathname);

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = panelRef.current?.offsetWidth ?? 180;
    const left = align === 'end' ? rect.right - width : rect.left;
    setPosition({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
    });
  }, [align]);

  useLayoutEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    if (panelRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
    setOpen(false);
  }, [pathname]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    const index = initialFocus.current === 'last' ? (buttons?.length ?? 0) - 1 : 0;
    buttons?.[index]?.focus({ preventScroll: true });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      buttonRef.current?.focus();
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!buttons.length) return;
    const current = buttons.findIndex(button => button === document.activeElement);
    const index = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-keyboard-menu
        onClick={() => {
          initialFocus.current = 'first';
          setOpen((prev) => !prev);
        }}
        onKeyDown={(event) => {
          if (open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          initialFocus.current = event.key === 'ArrowUp' || event.key === 'End' ? 'last' : 'first';
          setOpen(true);
        }}
        className="inline-flex items-center justify-center rounded-lg text-default-500 transition-colors hover:bg-[var(--polaris-hover)]"
      >
        {trigger}
      </button>
      {createPortal(
        open ? (
          <motion.div
            key="menu"
            ref={panelRef}
            role="menu"
            aria-label={label}
            data-keyboard-menu
            onKeyDown={onMenuKeyDown}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { ...NAV_TRANSITION, opacity: FEEDBACK_TRANSITION } }}
            style={{ position: 'fixed', top: position?.top ?? -9999, left: position?.left ?? -9999, transformOrigin: align === 'end' ? 'top right' : 'top left' }}
            className="z-[100] min-w-[11rem] overflow-hidden rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] p-1 shadow-[0_10px_30px_-12px_rgb(0_0_0/0.35)]"
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-current={item.selected ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  buttonRef.current?.focus();
                  item.onSelect();
                }}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--polaris-accent)]',
                  item.selected
                    ? 'bg-[var(--polaris-active)] font-medium text-[var(--polaris-ink)]'
                    : 'text-[var(--polaris-ink-2)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]',
                )}
              >
                {item.icon ? <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{item.icon}</span> : null}
                {item.label}
              </button>
            ))}
          </motion.div>
        ) : null,
        document.body,
      )}
    </>
  );
}
