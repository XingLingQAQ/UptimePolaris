import { Input, type InputProps } from '@heroui/react';
import { Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'use-intl';
import './password-input.css';

type PasswordInputProps = Omit<InputProps, 'type' | 'value' | 'defaultValue' | 'endContent' | 'classNames'> & {
  value: string;
};

type Peek = { value: string; start: number; end: number; sequence: number };

const PEEK_DURATION = 900;

export function PasswordInput({ value, onChange, ...props }: PasswordInputProps) {
  const t = useTranslations('admin');
  const baseRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const sequenceRef = useRef(0);
  const [shown, setShown] = useState(false);
  const [peek, setPeek] = useState<Peek | null>(null);
  const activePeek = !shown && !props.isDisabled && peek?.value === value ? peek : null;

  const syncMirror = useCallback(() => {
    const input = baseRef.current?.querySelector('input');
    const mirror = mirrorRef.current;
    const text = textRef.current;
    if (!input || !mirror || !text || !mirror.offsetParent) return;

    const bounds = input.getBoundingClientRect();
    const parent = mirror.offsetParent.getBoundingClientRect();
    const style = getComputedStyle(input);
    Object.assign(mirror.style, {
      left: `${bounds.left - parent.left}px`,
      top: `${bounds.top - parent.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
    });
    text.style.transform = `translateX(${-input.scrollLeft}px)`;
  }, []);

  useLayoutEffect(syncMirror, [syncMirror, value, activePeek]);

  useEffect(() => {
    const input = baseRef.current?.querySelector('input');
    if (!input) return;
    const observer = new ResizeObserver(syncMirror);
    observer.observe(input);
    input.addEventListener('scroll', syncMirror);
    return () => {
      observer.disconnect();
      input.removeEventListener('scroll', syncMirror);
    };
  }, [syncMirror]);

  useEffect(() => {
    if (!peek) return;
    const timer = window.setTimeout(() => setPeek(null), PEEK_DURATION);
    return () => window.clearTimeout(timer);
  }, [peek]);

  useEffect(() => {
    const clearPeek = () => setPeek(null);
    window.addEventListener('blur', clearPeek);
    document.addEventListener('visibilitychange', clearPeek);
    return () => {
      window.removeEventListener('blur', clearPeek);
      document.removeEventListener('visibilitychange', clearPeek);
    };
  }, []);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const native = event.nativeEvent as InputEvent;
    const end = input.selectionStart;
    const typed = native.data;

    // typed characters only; paste and autofill stay masked / 仅显示键入字符；粘贴和自动填充保持遮蔽
    if (
      !shown && !native.isComposing && native.inputType === 'insertText' && typed &&
      Array.from(typed).length === 1 && end !== null && input.selectionEnd === end
    ) {
      setPeek({ value: input.value, start: end - typed.length, end, sequence: ++sequenceRef.current });
    } else {
      setPeek(null);
    }
    onChange?.(event);
  }

  let offset = 0;
  const characters = Array.from(value).map((character) => {
    const start = offset;
    offset += character.length;
    return { character, start };
  });

  return (
    <Input
      {...props}
      baseRef={baseRef}
      value={value}
      type={shown ? 'text' : 'password'}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck="false"
      classNames={{
        input: activePeek ? 'polaris-password-native polaris-password-masked' : 'polaris-password-native',
        innerWrapper: 'relative',
      }}
      onChange={handleChange}
      onBlur={(event) => {
        setPeek(null);
        props.onBlur?.(event);
      }}
      onPointerDown={(event) => {
        setPeek(null);
        props.onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey) setPeek(null);
        props.onKeyDown?.(event);
      }}
      onSelect={(event) => {
        const input = event.currentTarget;
        if (input.selectionStart !== input.selectionEnd || input.selectionStart !== activePeek?.end) {
          setPeek(null);
        }
        props.onSelect?.(event);
      }}
      endContent={
        <>
          {activePeek ? (
            <span ref={mirrorRef} aria-hidden="true" className="polaris-password-mirror">
              <span ref={textRef} className="polaris-password-text">
                {characters.map(({ character, start }) => (
                  <span key={start} className="polaris-password-cell">
                    <span
                      key={`mask-${activePeek.start === start ? activePeek.sequence : 'hidden'}`}
                      className={activePeek.start === start ? 'polaris-password-dot polaris-password-dot-return' : 'polaris-password-dot'}
                    >
                      {'\u2022'}
                    </span>
                    {activePeek.start === start ? (
                      <span key={activePeek.sequence} className="polaris-password-peek">{character}</span>
                    ) : null}
                  </span>
                ))}
              </span>
            </span>
          ) : null}
          <button
            type="button"
            disabled={props.isDisabled}
            aria-label={shown ? t('login.hidePassword') : t('login.showPassword')}
            aria-pressed={shown}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setPeek(null);
              setShown((previous) => !previous);
            }}
            className="shrink-0 rounded-sm text-[var(--polaris-ink-4)] transition-colors hover:text-[var(--polaris-ink-2)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--polaris-field-focus)] disabled:pointer-events-none"
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </>
      }
    />
  );
}
