// The sections of the Manager page: the icon and colour of each in the list, and the
// keys that move the selection.

import type { ManagerSection } from '../../../../src/shared/protocols/manager';
import type { Tone } from '../../components/tone';
import type { CodiconName } from '../../lib/codicons';
import type { MessageKey } from '../../l10n/en';

export const SECTION_LOOK: Readonly<
  Record<ManagerSection, { icon: CodiconName; tone: Tone; label: MessageKey }>
> = {
  log: { icon: 'output', tone: 'yellow', label: 'manager.section.log' },
  dashboard: { icon: 'dashboard', tone: 'blue', label: 'manager.section.dashboard' },
  processes: { icon: 'server-process', tone: 'orange', label: 'manager.section.processes' },
  dump: { icon: 'export', tone: 'teal', label: 'manager.section.dump' },
  sync: { icon: 'git-compare', tone: 'purple', label: 'manager.section.sync' },
};

/** The section a key moves to in a vertical list: arrows step, Home and End jump. */
export function sectionAfterKey(
  sections: readonly ManagerSection[],
  current: ManagerSection,
  key: string,
): ManagerSection | undefined {
  const index = sections.indexOf(current);
  if (index < 0 || sections.length === 0) {
    return undefined;
  }
  switch (key) {
    case 'ArrowDown':
      return sections[(index + 1) % sections.length];
    case 'ArrowUp':
      return sections[(index - 1 + sections.length) % sections.length];
    case 'Home':
      return sections[0];
    case 'End':
      return sections[sections.length - 1];
    default:
      return undefined;
  }
}
