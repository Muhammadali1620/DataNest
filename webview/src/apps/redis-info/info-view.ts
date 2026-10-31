// How the server information page (V7.4) shows numbers, and which fields a filter keeps.

import type { RedisInfoNode } from '../../../../src/shared/protocols/redis-info';

/** `3d 4h`, `5h 12m`, `42s`: uptime the way people say it. */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return minutes > 0 ? `${minutes}m ${Math.floor(seconds % 60)}s` : `${Math.floor(seconds)}s`;
}

/** `97.5%`. */
export function formatPercent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** Sections with only the fields whose name or value contains the text, any case. */
export function filterSections(node: RedisInfoNode, text: string): RedisInfoNode['sections'] {
  const needle = text.trim().toLowerCase();
  if (needle === '') {
    return node.sections;
  }
  return node.sections
    .map((section) => ({
      name: section.name,
      fields: section.fields.filter((field) =>
        field.some((part) => part.toLowerCase().includes(needle)),
      ),
    }))
    .filter((section) => section.fields.length > 0);
}

/**
 * How full a meter is, 0 to 1: used memory of the limit, for the bar under the number.
 * Undefined when there is nothing to measure against (no limit, or no reading).
 */
export function shareOf(part: number | undefined, whole: number | undefined): number | undefined {
  if (part === undefined || whole === undefined || !(whole > 0) || !Number.isFinite(part)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, part / whole));
}
