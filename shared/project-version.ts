export const STABLE_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/;

export interface VersionCheck {
  tag: string | null;
  checkedAt: number;
}

export function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(BigInt);
  const b = right.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
