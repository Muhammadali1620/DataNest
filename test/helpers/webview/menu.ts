// Working a MenuButton (webview/src/components/MenuButton.svelte) from component tests.

import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';

/** Opens the menu of the button with this test id and returns the menu element. */
export async function openMenu(testId: string): Promise<HTMLElement> {
  const button = screen.getByTestId(testId);
  if (button.getAttribute('aria-expanded') !== 'true') {
    await fireEvent.click(button);
  }
  const id = button.getAttribute('aria-controls');
  return await waitFor(() => {
    const menu = id === null ? null : document.getElementById(id);
    if (menu === null) {
      throw new Error(`The menu of ${testId} did not open`);
    }
    return menu;
  });
}

/** The item labels of a menu, in order. */
export async function menuLabels(testId: string): Promise<string[]> {
  const menu = await openMenu(testId);
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent.trim());
}

/** The menu item with this label, after opening its menu. */
export async function menuItem(testId: string, label: string): Promise<HTMLElement> {
  const menu = await openMenu(testId);
  return within(menu).getByRole('menuitem', { name: label });
}

/** Opens the menu and picks the item with this label. */
export async function chooseFromMenu(testId: string, label: string): Promise<void> {
  await fireEvent.click(await menuItem(testId, label));
}
