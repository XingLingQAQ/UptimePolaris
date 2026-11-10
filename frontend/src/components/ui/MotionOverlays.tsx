import {
  Drawer as HeroDrawer,
  Modal as HeroModal,
  Popover as HeroPopover,
  Dropdown as HeroDropdown,
  Select as HeroSelect,
  Autocomplete as HeroAutocomplete,
  type DrawerProps,
  type ModalProps,
  type PopoverProps,
  type DropdownProps,
  type SelectProps,
  type AutocompleteProps,
} from '@heroui/react';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { EXIT_TRANSITION, FEEDBACK_TRANSITION, NAV_TRANSITION, PANEL_TRANSITION } from '@/lib/motion';

const DRAWER_REM = { xs: 20, sm: 24, md: 28, lg: 32, xl: 36, '2xl': 42, '3xl': 48, '4xl': 56, '5xl': 64, full: Infinity };

export function Modal({ motionProps, ...props }: ModalProps) {
  const reduced = useReducedMotion();
  return <HeroModal {...props} motionProps={motionProps ?? {
    variants: {
      enter: { opacity: 1, scale: 1, y: 0, transition: { ...PANEL_TRANSITION, opacity: FEEDBACK_TRANSITION } },
      exit: { opacity: 0, scale: reduced ? 1 : 0.975, y: reduced ? 0 : 10, transition: EXIT_TRANSITION },
    },
  }} />;
}

export function Drawer({ motionProps, placement = 'right', size = 'md', ...props }: DrawerProps) {
  const reduced = useReducedMotion();
  const axis = placement === 'left' || placement === 'right' ? 'x' : 'y';
  // HeroUI moves a viewport-wide wrapper, not the sheet. / HeroUI 移动的是全屏包装器，而非面板。
  const viewport = axis === 'x' ? window.innerWidth : window.innerHeight;
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const distance = Math.min(viewport, DRAWER_REM[size] * rem);
  const offset = reduced ? 0 : (placement === 'left' || placement === 'top' ? -distance : distance);
  return <HeroDrawer {...props} size={size} placement={placement} motionProps={motionProps ?? {
    variants: {
      enter: { transform: `translate${axis.toUpperCase()}(0px)`, opacity: 1, transition: { ...PANEL_TRANSITION, opacity: FEEDBACK_TRANSITION } },
      exit: { transform: `translate${axis.toUpperCase()}(${offset}px)`, opacity: reduced ? 0 : 1, transition: EXIT_TRANSITION },
    },
  }} />;
}

export function Popover({ motionProps, ...props }: PopoverProps) {
  const preset = usePopoverMotion();
  return <HeroPopover {...props} motionProps={motionProps ?? preset} />;
}

export function Dropdown({ motionProps, ...props }: DropdownProps) {
  const preset = usePopoverMotion();
  return <HeroDropdown {...props} motionProps={motionProps ?? preset} />;
}

export function Select<T extends object>({ popoverProps, ...props }: SelectProps<T>) {
  const preset = usePopoverMotion();
  return <HeroSelect<T> {...props} popoverProps={{ ...popoverProps, motionProps: popoverProps?.motionProps ?? preset }} />;
}

export function Autocomplete<T extends object>({ popoverProps, ...props }: AutocompleteProps<T>) {
  const preset = usePopoverMotion();
  return <HeroAutocomplete<T> {...props} popoverProps={{ ...popoverProps, motionProps: popoverProps?.motionProps ?? preset }} />;
}

function usePopoverMotion(): PopoverProps['motionProps'] {
  const reduced = useReducedMotion();
  return {
    variants: {
      enter: { opacity: 1, scale: 1, transition: { ...NAV_TRANSITION, opacity: FEEDBACK_TRANSITION } },
      exit: { opacity: 0, scale: reduced ? 1 : 0.96, transition: { duration: 0.12 } },
    },
  };
}
