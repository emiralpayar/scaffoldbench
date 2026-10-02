import type { ReactNode } from 'react';

import type { Block, Inline } from '../lib/markdown';
import { parseMarkdown } from '../lib/markdown';

/**
 * An agent's Markdown, rendered as React elements from the parsed tree, so
 * nothing in the text can become markup. No hooks: it renders the same on
 * the server and inside the client-side run explorer.
 *
 * Headings are demoted to styled paragraphs. An agent's "## Findings" is part
 * of one reply, and letting it into the page outline would scatter dozens of
 * stray headings through every trace for screen-reader users.
 */
export function Markdown({
  source,
  className = '',
}: {
  source: string;
  className?: string;
}) {
  const blocks = parseMarkdown(source);
  return <div className={`md ${className}`}>{blocks.map((block, index) => renderBlock(block, index))}</div>;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.t) {
    case 'p':
      return <p key={key}>{renderInline(block.c)}</p>;
    case 'h':
      return (
        <p key={key} className={`md-h md-h${Math.min(block.level, 4)}`}>
          {renderInline(block.c)}
        </p>
      );
    case 'code':
      return (
        <pre key={key} className="md-pre">
          <code>{block.v}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={key}>{block.c.map((child, index) => renderBlock(child, index))}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>{item.map((child, childIndex) => renderListChild(child, childIndex, item.length))}</li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table':
      return (
        <div key={key} className="md-table scroll-x">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} scope="col" style={alignStyle(block.align[index])}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={alignStyle(block.align[index])}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** A tight list item's single paragraph renders inline, without a <p> margin. */
function renderListChild(block: Block, key: number, siblings: number): ReactNode {
  if (block.t === 'p' && siblings === 1) return <span key={key}>{renderInline(block.c)}</span>;
  return renderBlock(block, key);
}

function alignStyle(align: 'left' | 'center' | 'right' | null | undefined) {
  return align ? { textAlign: align } : undefined;
}

function renderInline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.t) {
      case 'text':
        return node.v;
      case 'br':
        return <br key={index} />;
      case 'code':
        return (
          <code key={index} className="code-inline">
            {node.v}
          </code>
        );
      case 'strong':
        return <strong key={index}>{renderInline(node.c)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(node.c)}</em>;
      case 'del':
        return <del key={index}>{renderInline(node.c)}</del>;
      case 'link':
        return (
          <a key={index} href={node.href} className="link" rel="nofollow noopener noreferrer" target="_blank">
            {renderInline(node.c)}
          </a>
        );
    }
  });
}
