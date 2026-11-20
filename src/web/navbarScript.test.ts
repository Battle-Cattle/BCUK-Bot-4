import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const scriptPath = path.join(__dirname, '../../public/navbar.js');

type Listener = (event: FakeEvent) => void;

/** The parts of a DOM event the script reads. */
interface FakeEvent {
  target?: FakeElement;
  key?: string;
  matches?: boolean;
  stopPropagation?: () => void;
}

/** A minimal element: classes, attributes, listeners, focus and containment. */
class FakeElement {
  classes = new Set<string>();
  attributes: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  children: FakeElement[] = [];
  focusCount = 0;
  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !this.classes.has(c);
      if (on) this.classes.add(c);
      else this.classes.delete(c);
      return on;
    },
  };

  constructor(public parent: FakeElement | null = null, public label: FakeElement | null = null) {
    parent?.children.push(this);
  }

  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  focus(): void { this.focusCount++; }
  /** Like Element.closest, for the one ancestor selector navbar.js asks for: the toggle's `.navbar`. */
  closest(selector: string): FakeElement | null { return selector === '.navbar' ? this.parent : null; }
  /** Like Element.querySelector, for the one child selector navbar.js asks for: a group's `.nav-group-label`. */
  querySelector(selector: string): FakeElement | null { return selector === '.nav-group-label' ? this.label : null; }

  /** Whether `el` is this element or inside it. */
  contains(el: FakeElement | undefined): boolean {
    for (let e: FakeElement | null | undefined = el; e; e = e.parent) if (e === this) return true;
    return false;
  }

  /** Calls this element's listeners for `type`. */
  dispatch(type: string, event: FakeEvent = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

/** A dropdown group whose label always exists (the fixture builds one per group). */
type LabelledGroup = FakeElement & { label: FakeElement };

/** Builds a dropdown group with its label inside `parent`. */
function labelledGroup(parent: FakeElement): LabelledGroup {
  const group = new FakeElement(parent);
  group.label = new FakeElement(group);
  return group as LabelledGroup;
}

/**
 * Runs public/navbar.js against a fake navbar with two dropdown groups, at a mobile or desktop width.
 * `withToggle: false` leaves the toggle out, as on a page without the nav.
 */
function runNavbar(options: { mobile?: boolean; withToggle?: boolean } = {}) {
  const document = new FakeElement();
  const nav = new FakeElement();
  const toggle = new FakeElement(nav);
  const collapse = new FakeElement(nav);
  const groups: [LabelledGroup, LabelledGroup] = [labelledGroup(collapse), labelledGroup(collapse)];
  const outside = new FakeElement();
  const mql = { matches: options.mobile ?? false, media: '', listeners: [] as Listener[], addEventListener(_t: string, fn: Listener) { this.listeners.push(fn); } };
  let query = '';
  const context = {
    document: Object.assign(document, {
      querySelector: (sel: string) => (sel === '.navbar-toggle' && options.withToggle !== false ? toggle : null),
      getElementById: (id: string) => (id === 'navbar-collapse' ? collapse : null),
      querySelectorAll: (sel: string) => (sel === '.nav-group' ? groups : []),
    }),
    window: { matchMedia: (q: string) => { query = q; return mql; } },
  };
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context);
  return {
    nav, toggle, collapse, groups, outside, query: () => query,
    /** Clicks an element: its own listeners, then the document's, like a bubbling click. */
    click(el: FakeElement) {
      let stopped = false;
      const event: FakeEvent = { target: el, stopPropagation: () => { stopped = true; } };
      el.dispatch('click', event);
      if (!stopped) document.dispatch('click', event);
    },
    pressEscape() { document.dispatch('keydown', { key: 'Escape' }); },
    /** Moves the viewport across the breakpoint: updates the media query, then fires its change event. */
    resize(mobile: boolean) {
      mql.matches = mobile;
      for (const fn of mql.listeners) fn({ matches: mobile });
    },
  };
}

const isOpen = (el: FakeElement) => el.classes.has('nav-open') || el.classes.has('open');

describe('public/navbar.js', () => {
  it('watches the 640px mobile breakpoint', () => {
    expect(runNavbar().query()).toBe('(max-width: 640px)');
  });

  it.each([
    [true, 'true'],
    [false, 'false'],
  ])('starts closed, with the collapse hidden from assistive tech only on mobile (mobile=%s)', (mobile, hidden) => {
    const { nav, toggle, collapse } = runNavbar({ mobile });

    expect(isOpen(nav)).toBe(false);
    expect(toggle.attributes['aria-expanded']).toBe('false');
    expect(collapse.attributes['aria-hidden']).toBe(hidden);
  });

  it('does nothing on a page without the toggle', () => {
    expect(() => runNavbar({ withToggle: false })).not.toThrow();
  });

  it('opens and closes the menu from the toggle, keeping ARIA in step', () => {
    const { nav, toggle, collapse, click } = runNavbar({ mobile: true });

    click(toggle);
    expect(isOpen(nav)).toBe(true);
    expect(toggle.attributes['aria-expanded']).toBe('true');
    expect(collapse.attributes['aria-hidden']).toBe('false');

    click(toggle);
    expect(isOpen(nav)).toBe(false);
    expect(toggle.attributes['aria-expanded']).toBe('false');
    expect(collapse.attributes['aria-hidden']).toBe('true');
  });

  it('closes any open dropdown when the toggle closes the menu', () => {
    const { toggle, groups, click } = runNavbar({ mobile: true });
    click(toggle);
    click(groups[0].label);

    click(toggle);

    expect(isOpen(groups[0])).toBe(false);
    expect(groups[0].label.attributes['aria-expanded']).toBe('false');
  });

  it('closes the open menu on Escape and returns focus to the toggle', () => {
    const { nav, toggle, collapse, groups, click, pressEscape } = runNavbar({ mobile: true });
    click(toggle);
    click(groups[1].label);

    pressEscape();

    expect(isOpen(nav)).toBe(false);
    expect(toggle.attributes['aria-expanded']).toBe('false');
    expect(collapse.attributes['aria-hidden']).toBe('true');
    expect(toggle.focusCount).toBe(1);
    expect(isOpen(groups[1])).toBe(false);
  });

  it('closes an open dropdown on Escape without moving focus when the menu itself is closed (desktop)', () => {
    const { toggle, groups, click, pressEscape } = runNavbar();
    click(groups[0].label);

    pressEscape();

    expect(isOpen(groups[0])).toBe(false);
    expect(toggle.focusCount).toBe(0);
  });

  it('closes the menu and dropdowns on a click outside the navbar, but not on a click inside it', () => {
    const { nav, collapse, groups, toggle, outside, click } = runNavbar({ mobile: true });
    click(toggle);
    click(groups[0].label);

    click(collapse);
    expect(isOpen(nav)).toBe(true);
    expect(isOpen(groups[0])).toBe(true);

    click(outside);
    expect(isOpen(nav)).toBe(false);
    expect(collapse.attributes['aria-hidden']).toBe('true');
    expect(isOpen(groups[0])).toBe(false);
  });

  it('keeps at most one dropdown open, and a second click on a label closes it', () => {
    const { groups, click } = runNavbar();
    const [a, b] = groups;

    click(a.label);
    expect([isOpen(a), isOpen(b)]).toEqual([true, false]);
    expect(a.label.attributes['aria-expanded']).toBe('true');

    click(b.label);
    expect([isOpen(a), isOpen(b)]).toEqual([false, true]);
    expect(a.label.attributes['aria-expanded']).toBe('false');
    expect(b.label.attributes['aria-expanded']).toBe('true');

    click(b.label);
    expect(isOpen(b)).toBe(false);
    expect(b.label.attributes['aria-expanded']).toBe('false');
  });

  it('leaves the open menu open when a dropdown label inside it is clicked', () => {
    const { nav, toggle, groups, click } = runNavbar({ mobile: true });
    click(toggle);

    click(groups[0].label);

    expect(isOpen(nav)).toBe(true);
    expect(isOpen(groups[0])).toBe(true);
  });

  it.each([
    [false, 'false'],
    [true, 'true'],
  ])('resets to closed when the viewport crosses the breakpoint (now mobile=%s)', (mobile, hidden) => {
    const { nav, toggle, collapse, click, resize } = runNavbar({ mobile: !mobile });
    click(toggle);

    resize(mobile);

    expect(isOpen(nav)).toBe(false);
    expect(toggle.attributes['aria-expanded']).toBe('false');
    expect(collapse.attributes['aria-hidden']).toBe(hidden);
  });
});
