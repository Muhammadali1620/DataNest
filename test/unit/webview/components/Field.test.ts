import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import Field from '../../../../webview/src/components/Field.svelte';

const input = createRawSnippet(() => ({ render: () => '<input class="control" />' }));
const select = createRawSnippet(() => ({ render: () => '<select class="control"></select>' }));

describe('Field', () => {
  it('marks the label and the control of a required field', () => {
    const { container } = render(Field, {
      props: { label: 'Host', required: true, children: input },
    });
    expect(container.querySelector('.label')?.classList.contains('required')).toBe(true);
    expect(container.querySelector('input')?.getAttribute('aria-required')).toBe('true');
  });

  it('keeps the star out of the label text, so the name stays "Host"', () => {
    const { container } = render(Field, {
      props: { label: 'Host', required: true, children: input },
    });
    expect(container.querySelector('.label')?.textContent).toBe('Host');
  });

  it('marks nothing on an optional field', () => {
    const { container } = render(Field, { props: { label: 'Comment', children: input } });
    expect(container.querySelector('.label')?.classList.contains('required')).toBe(false);
    expect(container.querySelector('input')?.hasAttribute('aria-required')).toBe(false);
  });

  it('marks a select too, and follows the prop when it changes', async () => {
    const view = render(Field, { props: { label: 'Kind', required: true, children: select } });
    expect(view.container.querySelector('select')?.getAttribute('aria-required')).toBe('true');
    await view.rerender({ required: false });
    expect(view.container.querySelector('select')?.hasAttribute('aria-required')).toBe(false);
  });

  it('shows the error in place of the hint', () => {
    const { container } = render(Field, {
      props: { label: 'Host', hint: 'a hint', error: 'Enter a host', children: input },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a host');
    expect(container.querySelector('.hint')).toBeNull();
  });
});
