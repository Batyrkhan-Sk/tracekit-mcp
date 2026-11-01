import { z } from 'zod';

/**
 * The complete, explicit set of browser actions the investigator can perform.
 * There is intentionally no "evaluate", "press arbitrary key", or upload action.
 */

export const ARIA_ROLES = [
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'meter',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
] as const;

const shortText = z.string().min(1).max(200);
export const CssSelector = z
  .string()
  .min(1)
  .max(300)
  // Plain CSS never starts with `engine=` or `//`, and never contains `>>`.
  .refine(
    (s) => !/^\s*[a-zA-Z_-]+\s*=/.test(s) && !/^\s*(\/\/|\.\.|internal:)/.test(s) && !s.includes('>>'),
    {
      message:
        'Only plain CSS selectors are accepted; Playwright selector engines and chaining are not allowed',
    },
  );

/** Prefer user-facing locators; `css` is the escape hatch. */
export const LocatorSchema = z.discriminatedUnion('by', [
  z.strictObject({
    by: z.literal('role'),
    role: z.enum(ARIA_ROLES),
    name: shortText.optional(),
    exact: z.boolean().optional(),
  }),
  z.strictObject({ by: z.literal('text'), text: shortText, exact: z.boolean().optional() }),
  z.strictObject({ by: z.literal('label'), label: shortText, exact: z.boolean().optional() }),
  z.strictObject({ by: z.literal('placeholder'), placeholder: shortText, exact: z.boolean().optional() }),
  z.strictObject({ by: z.literal('testId'), testId: shortText }),
  z.strictObject({ by: z.literal('css'), selector: CssSelector }),
]);
export type LocatorSpec = z.infer<typeof LocatorSchema>;

const timeoutMs = z.number().int().min(100).max(300_000).optional().describe('Per-step timeout in ms');
const waitUntil = z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional();

export const ActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('navigate'),
    url: z.string().min(1).max(2048),
    waitUntil,
    timeoutMs,
  }),
  z.strictObject({ action: z.literal('click'), target: LocatorSchema, timeoutMs }),
  z.strictObject({
    action: z.literal('fill'),
    target: LocatorSchema,
    value: z.string().max(1000),
    timeoutMs,
  }),
  z.strictObject({
    action: z.literal('select'),
    target: LocatorSchema,
    option: z.union([
      z.strictObject({ value: z.string().max(200) }),
      z.strictObject({ label: z.string().max(200) }),
    ]),
    timeoutMs,
  }),
  z.strictObject({ action: z.literal('reload'), waitUntil, timeoutMs }),
  z.strictObject({
    action: z.literal('waitFor'),
    target: LocatorSchema,
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
    timeoutMs,
  }),
  z.strictObject({
    action: z.literal('screenshot'),
    label: z.string().max(80).optional(),
    returnImage: z.boolean().optional().describe('Also return the image inline in the tool result'),
  }),
]);
export type Action = z.infer<typeof ActionSchema>;

export function describeLocator(locator: LocatorSpec): string {
  switch (locator.by) {
    case 'role':
      return locator.name ? `${locator.role} "${locator.name}"` : `${locator.role}`;
    case 'text':
      return `text "${locator.text}"`;
    case 'label':
      return `field labelled "${locator.label}"`;
    case 'placeholder':
      return `field with placeholder "${locator.placeholder}"`;
    case 'testId':
      return `test id "${locator.testId}"`;
    case 'css':
      return `CSS "${locator.selector}"`;
  }
}

/** Human-readable step description. Never includes filled values. */
export function describeAction(action: Action): string {
  switch (action.action) {
    case 'navigate':
      return `Navigate to ${action.url}`;
    case 'click':
      return `Click ${describeLocator(action.target)}`;
    case 'fill':
      return `Fill ${describeLocator(action.target)} with ${action.value.length} characters`;
    case 'select':
      return `Select ${'value' in action.option ? `value "${action.option.value}"` : `"${action.option.label}"`} in ${describeLocator(action.target)}`;
    case 'reload':
      return 'Reload the page';
    case 'waitFor':
      return `Wait for ${describeLocator(action.target)} to be ${action.state ?? 'visible'}`;
    case 'screenshot':
      return `Capture screenshot${action.label ? ` "${action.label}"` : ''}`;
  }
}
