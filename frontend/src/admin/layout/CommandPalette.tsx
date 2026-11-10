import { Modal } from '@/components/ui/MotionOverlays';
import { ModalContent } from '@heroui/react';
import clsx from 'clsx';
import { Activity, ArrowDown, ArrowUp, CornerDownLeft, Cpu, Globe, KeyRound, Network, Plus, RadioTower, Search, Server, Webhook } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import type { Hue } from '../../types/tone';
import { IconTile } from '../components/IconTile';
import { SearchArt } from '../components/illustrations';
import { StatusPill } from '../monitors/MonitorIndicators';
import { toneForStatus } from '../monitors/presentation';
import type { MonitorType } from '../monitors/types';
import { useFleet, useOverview } from '../useConsoleData';
import { NAV } from './nav';

interface Item {
  id: string;
  group: 'pages' | 'actions' | 'monitors' | 'agents';
  label: string;
  sub?: string;
  icon: ReactNode;
  hue: Hue;
  to: string;
  trailing?: ReactNode;
  /** Extra text the query is matched against, beyond the label and sub-line. / 除标签和副标题外，供查询匹配的额外文本。 */
  keywords?: string;
}

const TYPE_ICON: Record<MonitorType, ReactNode> = {
  http: <Globe />,
  tcp: <Network />,
  udp: <RadioTower />,
  icmp: <Activity />,
  dns: <Globe />,
  tls: <KeyRound />,
  websocket: <RadioTower />,
  push: <Webhook />,
  agent: <Cpu />,
};

/**
 * Jump anywhere in the console from the keyboard.
 *
 * Ctrl/⌘+K opens it from every console page. It searches the pages, a couple of
 * frequent actions, and the monitors and agents the console already has in its
 * cache - opening a monitor lands on its quick view, an agent on its detail
 * dialog, through a query parameter the destination page reads once.
 *
 * Monitors and agents are only fetched while the palette is open and only when
 * the shared cache does not already hold them, so a closed palette costs
 * nothing.
 *
 * Ctrl/⌘+K 可从控制台任何页面打开命令面板，搜索页面、常用操作及缓存中的监控项和
 * Agent；打开监控项进入快速详情，打开 Agent 进入详情抽屉，目标页读取一次查询参数。
 * 仅在面板打开且共享缓存没有数据时获取监控项和 Agent；关闭时不产生请求。
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('admin');
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const overview = useOverview(open);
  const fleet = useFleet(open);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = NAV.map((entry) => {
      const Icon = entry.icon;
      return {
        id: `page:${entry.href}`,
        group: 'pages',
        label: t(entry.labelKey),
        icon: <Icon />,
        hue: entry.hue,
        to: entry.href,
        keywords: entry.href,
      };
    });
    const actions: Item[] = [
      { id: 'action:monitor', group: 'actions', label: t('action.add'), icon: <Plus />, hue: 'primary', to: '/admin?new=1' },
      { id: 'action:enroll', group: 'actions', label: t('agents.enroll'), icon: <KeyRound />, hue: 'cyan', to: '/admin/agents?enroll=1' },
    ];
    // Urgency, for the launcher view: down, retrying, warning, unchecked, up, paused. / 启动器视图按紧急程度排序：故障、重试、警告、未检查、正常、暂停。
    const urgency = (st: number | null, active: number) =>
      !active ? 5 : st === 0 ? 0 : st === 4 ? 1 : st === 2 ? 2 : st === null ? 3 : 4;
    const sorted = [...(overview.data?.monitors ?? [])].sort((a, b) => urgency(a.st, a.active) - urgency(b.st, b.active));
    const monitors: Item[] = sorted.map((m) => {
      const tone = m.active ? toneForStatus(m.st) : 'idle';
      return {
        id: `monitor:${m.id}`,
        group: 'monitors',
        label: m.name,
        sub: m.type === 'push' ? t('list.pushInbound') : m.target || m.type.toUpperCase(),
        icon: TYPE_ICON[m.type] ?? <Globe />,
        hue: 'primary',
        to: `/admin?monitor=${encodeURIComponent(m.id)}`,
        trailing: (
          <StatusPill
            tone={tone}
            label={
              !m.active
                ? t('status.paused')
                : m.st === null
                  ? t('status.unknown')
                  : t(`status.${m.st === 1 ? 'up' : m.st === 2 ? 'warn' : m.st === 4 ? 'pending' : 'down'}`)
            }
          />
        ),
      };
    });
    const agents: Item[] = (fleet.data?.agents ?? []).map((a) => ({
      id: `agent:${a.id}`,
      group: 'agents',
      label: a.name,
      sub: [a.os, a.public_ip, a.region].filter(Boolean).join(' · '),
      icon: <Server />,
      hue: 'cyan',
      to: `/admin/agents?agent=${encodeURIComponent(a.id)}`,
    }));

    const needle = query.trim().toLowerCase();
    const match = (item: Item) =>
      !needle || [item.label, item.sub, item.keywords].some((text) => text?.toLowerCase().includes(needle));

    // With no query the palette is a launcher: every page and action, plus the
    // monitors that most need a human (they are sorted by urgency above), so the
    // likeliest destination is a keystroke away. With a query it is a search
    // across everything.
    // 无查询时面板作为启动器，列出全部页面和操作，以及按紧急程度排序、最需关注的监控项；
    // 输入查询后搜索全部内容。
    return [
      ...pages.filter(match),
      ...actions.filter(match),
      ...monitors.filter(match).slice(0, needle ? 8 : 5),
      ...agents.filter(match).slice(0, needle ? 6 : 3),
    ];
  }, [fleet.data, overview.data, query, t]);

  useEffect(() => {
    setActive((index) => Math.min(index, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Keep the highlighted row in view while moving through a long result list. / 在较长结果列表中移动时，保持高亮行可见。
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.to);
  };

  const groups: Array<{ key: Item['group']; label: string }> = [
    { key: 'pages', label: t('console.searchPages') },
    { key: 'actions', label: t('console.searchActions') },
    { key: 'monitors', label: t('console.searchMonitors') },
    { key: 'agents', label: t('console.searchAgents') },
  ];

  let index = -1;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      placement="top"
      size="xl"
      hideCloseButton
      backdrop="blur"
      /*
        Shorter entrance than HeroUI's default.

        The default is 0.4s of opacity plus a 0.6s spring on the y axis. For a
        palette that exists to be opened and dismissed dozens of times an hour,
        three quarters of a second of settling reads as lag rather than as
        motion. 0.16s keeps the slide without the wait.

        使用比 HeroUI 默认更短的入场动画。默认透明度 0.4 秒、y 轴弹簧 0.6 秒；
        每小时可能打开关闭数十次的命令面板若等待约四分之三秒会显得迟滞。
        0.16 秒既保留滑动又避免等待。
      */
      motionProps={{
        variants: {
          enter: { opacity: 1, y: 0, transition: { duration: 0.16, ease: 'easeOut' } },
          exit: { opacity: 0, y: -12, transition: { duration: 0.1, ease: 'easeIn' } },
        },
      }}
      classNames={{
        base: 'mt-[12vh] overflow-hidden rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] shadow-[var(--polaris-shadow-float)]',
        backdrop: 'bg-black/25',
      }}
    >
      <ModalContent>
        <div className="flex items-center gap-3 border-b border-[var(--polaris-line)] px-4">
          <Search size={18} className="shrink-0 text-default-400" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                go(items[active]);
              }
            }}
            placeholder={t('console.searchPlaceholder')}
            aria-label={t('console.searchPlaceholder')}
            aria-activedescendant={items[active] ? `cmdk-${active}` : undefined}
            aria-controls="cmdk-list"
            role="combobox"
            aria-expanded="true"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--polaris-ink-4)]"
          />
          <kbd className="hidden rounded-md border border-default-200 px-1.5 py-0.5 font-sans text-[11px] text-default-500 sm:inline">
            Esc
          </kbd>
        </div>

        <div ref={listRef} id="cmdk-list" role="listbox" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
          {items.length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center">
              <SearchArt />
              <p className="mt-4 text-small text-default-500">{t('console.searchEmpty')}</p>
            </div>
          ) : (
            groups.map((group) => {
              const rows = items.filter((item) => item.group === group.key);
              if (rows.length === 0) return null;
              return (
                <div key={group.key} role="group" aria-label={group.label} className="pb-1">
                  <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-default-400">
                    {group.label}
                  </p>
                  {rows.map((item) => {
                    index += 1;
                    const mine = index;
                    const selected = mine === active;
                    return (
                      <button
                        key={item.id}
                        id={`cmdk-${mine}`}
                        data-index={mine}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => setActive(mine)}
                        onClick={() => go(item)}
                        className={clsx(
                          'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                          selected ? 'bg-[var(--polaris-active)]' : 'hover:bg-[var(--polaris-hover)]',
                        )}
                      >
                        <IconTile icon={item.icon} hue={item.hue} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className={clsx('block truncate text-small', selected && 'text-primary')}>
                            {item.label}
                          </span>
                          {item.sub ? (
                            <span className="block truncate font-mono text-[11px] text-default-400">{item.sub}</span>
                          ) : null}
                        </span>
                        {item.trailing ?? null}
                        {selected ? (
                          <CornerDownLeft size={14} className="shrink-0 text-primary" aria-hidden="true" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-[var(--polaris-line)] bg-[var(--polaris-well)] px-4 py-2 text-tiny text-default-500">
          <span className="flex items-center gap-1.5">
            <Key>
              <ArrowUp size={11} />
            </Key>
            <Key>
              <ArrowDown size={11} />
            </Key>
            {t('console.keySelect')}
          </span>
          <span className="flex items-center gap-1.5">
            <Key>
              <CornerDownLeft size={11} />
            </Key>
            {t('console.keyOpen')}
          </span>
          <span className="ml-auto hidden items-center gap-1.5 sm:flex">
            <Key>Esc</Key>
            {t('console.keyClose')}
          </span>
        </div>
      </ModalContent>
    </Modal>
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-default-200 bg-[var(--polaris-card)] px-1 font-sans text-[10.5px] text-default-500">
      {children}
    </kbd>
  );
}
