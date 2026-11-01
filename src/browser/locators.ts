import type { Locator, Page } from 'playwright';
import type { LocatorSpec } from '../types/actions.js';

export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.by) {
    case 'role':
      return page.getByRole(spec.role, {
        ...(spec.name !== undefined ? { name: spec.name } : {}),
        ...(spec.exact !== undefined ? { exact: spec.exact } : {}),
      });
    case 'text':
      return page.getByText(spec.text, { exact: spec.exact ?? false });
    case 'label':
      return page.getByLabel(spec.label, { exact: spec.exact ?? false });
    case 'placeholder':
      return page.getByPlaceholder(spec.placeholder, { exact: spec.exact ?? false });
    case 'testId':
      return page.getByTestId(spec.testId);
    case 'css':
      return page.locator(spec.selector);
  }
}
