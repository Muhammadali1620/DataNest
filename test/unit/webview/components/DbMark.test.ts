import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { DRIVER_IDS } from '../../../../src/shared/connection';
import DbMark from '../../../../webview/src/components/DbMark.svelte';

describe('DbMark', () => {
  it('draws the database as a hidden image, so the name beside it is the only name', () => {
    for (const driver of DRIVER_IDS) {
      const { container, unmount } = render(DbMark, { props: { driver } });
      const mark = container.querySelector('.db-mark');
      expect(mark?.getAttribute('aria-hidden'), driver).toBe('true');
      expect(mark?.getAttribute('data-driver')).toBe(driver);
      expect(mark?.querySelector('svg'), driver).not.toBeNull();
      expect(container.textContent.trim(), driver).toBe('');
      unmount();
    }
  });

  it('takes a size', () => {
    const { container } = render(DbMark, { props: { driver: 'redis', size: 40 } });
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('40');
  });
});
