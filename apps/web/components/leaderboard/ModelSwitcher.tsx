import Link from '../Link';

export interface SwitcherItem {
  href: string;
  label: string;
  current: boolean;
}

/**
 * Model as a choice of page, not of client state: every model's view is its
 * own static page, so it can be linked to, and the switch needs no script.
 */
export function ModelSwitcher({ items, label = 'Model' }: { items: SwitcherItem[]; label?: string }) {
  return (
    <nav aria-label={label} className="scroll-x -mx-1 px-1 pb-1">
      <ul className="segmented">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              className="segmented-item inline-flex items-center"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
