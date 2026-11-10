import { notificationsApi } from '@/admin/notifications/api';
import { settingsApi } from '@/admin/settings/api';
import { Button } from '@heroui/react';
import clsx from 'clsx';
import { ArrowUpRight, Check, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { useFleet, useOverview } from '../useConsoleData';
import { Panel } from './Panel';

/** Per browser, like the shell's seen-event marker: guidance is not account state. / 与已读事件标记一样按浏览器保存；引导不属于账户状态。 */
const DISMISSED_KEY = 'uptime-polaris.console.onboardingDismissed';

/**
 * A step is done when the deployment actually contains the thing, never when a
 * button was pressed.
 *
 * That is the whole design of this card. A checklist that advances on click is a
 * checklist that lies the moment something is deleted or a write fails, and the
 * operator has no way to tell the two apart. Every flag below is derived from the
 * same responses the rest of the console already renders.
 *
 * 步骤只有在部署中确实存在对应内容时才算完成，而不是点击按钮就算完成。
 * 否则对象被删除或写入失败时清单会误报，操作人员无法区分；所有标志都来自
 * 控制台其他部分已经使用的响应。
 */
interface Progress {
  monitors: number;
  agents: number;
  notifications: number;
  /** True once the site identity has been written, i.e. differs from "never set". / 站点标识已写入时为 true，区别于从未设置。 */
  siteNamed: boolean;
}

/** Dismissible setup suggestions; each step reflects current API data, and Agent setup is optional. / 可关闭的设置建议；各步骤反映当前 API 数据，Agent 设置为可选项。 */
export function OnboardingChecklist({ onAddMonitor }: { onAddMonitor: () => void }) {
  const t = useTranslations('admin');
  const overview = useOverview();
  const fleet = useFleet();

  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // Private browsing: the card simply comes back next visit. / 隐私浏览模式下，卡片会在下次访问时重新出现。
      return false;
    }
  });

  const [notifications, setNotifications] = useState<number | null>(null);
  const [siteNamed, setSiteNamed] = useState<boolean | null>(null);

  /*
    Read once, only while the card is visible. Both calls are optional
    decoration for it, so a failure leaves the count unknown rather than
    blocking the card: two of its four lines still answer.

    仅在卡片可见时各读取一次；两项请求都是可选补充，失败时保持数量未知，
    不阻止卡片显示，因为四行中仍有两行可以回答。
  */
  useEffect(() => {
    if (dismissed) return;
    let live = true;
    void notificationsApi.listNotifications()
      .then((res) => {
        if (live) setNotifications(res.channels.length);
      })
      .catch(() => {});
    void settingsApi.listSettings()
      .then((res) => {
        if (!live) return;
        /*
          "Named" means the operator chose one, not that the key has a value:
          every key always has a value, because defaults are declared rather than
          seeded. `stored` is the only thing that distinguishes a chosen title
          from the shipped default, which is exactly the question this step asks.

          “已命名”表示操作人员主动选择过名称，而不是键有值：每个键都有声明的默认值，
          并非通过种子数据生成。只有 `stored` 能区分用户选择的标题和产品默认标题。
        */
        setSiteNamed(res.specs.some((spec) => spec.key === 'site.title' && spec.stored));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [dismissed]);

  const progress: Progress | null = useMemo(() => {
    if (!overview.data) return null;
    return {
      monitors: overview.data.counts.total,
      agents: fleet.data?.summary.total ?? 0,
      notifications: notifications ?? 0,
      siteNamed: siteNamed ?? false,
    };
  }, [overview.data, fleet.data, notifications, siteNamed]);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Nothing to do: the state above already hid it for this visit. / 无需处理：上面的状态已在本次访问中隐藏卡片。
    }
  };

  /*
    Nothing until the deployment is actually readable. Rendering four zeros
    first would flash "0 of 4 done" at a deployment that is already configured,
    which reads as a broken page rather than as a loading one.

    部署数据可读取前不显示卡片；否则已配置的部署会先闪现“0/4 已完成”，
    看起来像页面错误而非正在加载。
  */
  if (dismissed || !progress) return null;

  const steps = [
    {
      key: 'monitor',
      done: progress.monitors > 0,
      action: (
        <Button size="sm" color="primary" variant="flat" onPress={onAddMonitor}>
          {t('onboarding.stepMonitorAction')}
        </Button>
      ),
    },
    {
      key: 'site',
      done: progress.siteNamed,
      action: (
        <Link to="/admin/settings#settings-site">
          <Button size="sm" variant="flat" endContent={<ArrowUpRight size={13} />}>
            {t('onboarding.stepSiteAction')}
          </Button>
        </Link>
      ),
    },
    {
      key: 'alerts',
      done: progress.notifications > 0,
      action: (
        <Link to="/admin/notifications">
          <Button size="sm" variant="flat" endContent={<ArrowUpRight size={13} />}>
            {t('onboarding.stepAlertsAction')}
          </Button>
        </Link>
      ),
    },
    {
      key: 'agent',
      done: progress.agents > 0,
      action: (
        <Link to="/admin/agents">
          <Button size="sm" variant="flat" endContent={<ArrowUpRight size={13} />}>
            {t('onboarding.stepAgentAction')}
          </Button>
        </Link>
      ),
    },
  ];

  const done = steps.filter((step) => step.done).length;

  // Fully set up: the card has said everything it has to say. / 所有步骤完成后，卡片不再需要显示。
  if (done === steps.length) return null;

  return (
    <Panel className="polaris-rise" id="onboarding">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--polaris-line)] text-[var(--polaris-ink-2)]"
        >
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] leading-5 font-semibold tracking-[-0.01em]">{t('onboarding.title')}</h2>
          <p className="mt-0.5 text-[12.5px] leading-5 text-[var(--polaris-ink-3)]">{t('onboarding.desc')}</p>
        </div>
        <span className="polaris-num shrink-0 text-[12px] text-[var(--polaris-ink-4)]">
          {t('onboarding.progress', { done, total: steps.length })}
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('onboarding.dismiss')}
          className="-mt-0.5 -mr-1 shrink-0 rounded-lg p-1.5 text-[var(--polaris-ink-4)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink-2)]"
        >
          <X size={14} />
        </button>
      </div>

      <ul className="mt-4 flex flex-col divide-y divide-[var(--polaris-line-soft)] border-t border-[var(--polaris-line-soft)]">
        {steps.map((step) => (
          <li key={step.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-3.5 last:pb-0">
            <span
              aria-hidden="true"
              className={clsx(
                'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                step.done
                  ? 'bg-success/10 text-success-700 ring-1 ring-success/30'
                  : 'border border-[var(--polaris-line-strong)] text-transparent',
              )}
            >
              {step.done ? <Check size={12} strokeWidth={3} /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={clsx(
                  'text-[13px] font-medium',
                  step.done ? 'text-[var(--polaris-ink-3)] line-through decoration-[var(--polaris-ink-4)]' : 'text-[var(--polaris-ink)]',
                )}
              >
                {t(`onboarding.step.${step.key}`)}
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-[var(--polaris-ink-3)]">
                {t(`onboarding.step.${step.key}Hint`)}
              </p>
            </div>
            <span className="shrink-0">{step.action}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
