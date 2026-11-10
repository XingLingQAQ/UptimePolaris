import { Server } from 'lucide-react';
import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siLinux,
  siOpensuse,
  siOpenwrt,
  siRedhat,
  siRockylinux,
  siUbuntu,
  type SimpleIcon,
} from 'simple-icons';
import type { GlyphSize } from '../../components/ui/GlyphTile';
import { GlyphTile } from '../../components/ui/GlyphTile';
import { SimpleMark } from '../notifications/ProviderLogo';

/**
 * A host's operating system, as the distribution's own mark on a white tile.
 *
 * Logos rather than lettered badges: an Ubuntu box and a Debian box differ
 * before their names are read, and a fleet table is scanned far more often
 * than it is read. Windows is not in simple-icons, so it gets its four panes
 * drawn here; anything unrecognised falls back to a plain server glyph.
 *
 * 以白色方块上的发行版标志代替字母徽章：在读名称之前即可区分 Ubuntu 与 Debian，
 * 而机器列表更多用于快速浏览。simple-icons 不含 Windows 标志，因此在此绘制四格图形；
 * 未识别系统回退到普通服务器图标。
 */
const OS_MARKS: Array<{ test: RegExp; icon: SimpleIcon | 'windows' }> = [
  { test: /ubuntu/i, icon: siUbuntu },
  { test: /debian/i, icon: siDebian },
  { test: /centos/i, icon: siCentos },
  { test: /rocky/i, icon: siRockylinux },
  { test: /alma/i, icon: siAlmalinux },
  { test: /alpine/i, icon: siAlpinelinux },
  { test: /arch/i, icon: siArchlinux },
  { test: /fedora/i, icon: siFedora },
  { test: /red ?hat|rhel/i, icon: siRedhat },
  { test: /suse/i, icon: siOpensuse },
  { test: /windows/i, icon: 'windows' },
  { test: /mac|darwin|os x/i, icon: siApple },
  { test: /freebsd/i, icon: siFreebsd },
  { test: /openwrt/i, icon: siOpenwrt },
  { test: /linux/i, icon: siLinux },
];

const SIZE: Record<'sm' | 'md' | 'lg', GlyphSize> = { sm: 'sm', md: 'md', lg: 'lg' };
const PX: Record<'sm' | 'md' | 'lg', number> = { sm: 15, md: 17, lg: 21 };

function WindowsMark({ px }: { px: number }) {
  return (
    <svg viewBox="0 0 24 24" width={px} height={px} role="img" aria-label="Windows">
      <path fill="#0078D4" d="M3 5.1 10.4 4v7.2H3zM11.4 3.9 21 2.5v8.7h-9.6zM3 12.3h7.4v7.2L3 18.4zM11.4 12.3H21v8.8l-9.6-1.4z" />
    </svg>
  );
}

export function OsBadge({
  os,
  size = 'md',
  className,
}: {
  os: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const hit = os ? OS_MARKS.find((entry) => entry.test.test(os)) : undefined;
  const px = PX[size];
  return (
    <GlyphTile size={SIZE[size]} className={className}>
      {!hit ? (
        <Server size={Math.round(px * 0.9)} />
      ) : hit.icon === 'windows' ? (
        <WindowsMark px={px} />
      ) : (
        <SimpleMark icon={hit.icon} px={px} />
      )}
    </GlyphTile>
  );
}
