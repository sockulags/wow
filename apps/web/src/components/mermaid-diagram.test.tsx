import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './markdown';
import { diagramView, toggleDiagramSource } from './mermaid';
import { MermaidDiagram } from './mermaid-diagram';

// jsdom lacks the layout APIs mermaid draws with, so the library is replaced here; the real
// drawing is covered by the e2e case "chat renders a table and a diagram".
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn<(config: Record<string, unknown>) => void>(),
  parse: vi.fn<(source: string) => Promise<boolean>>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const source = 'flowchart LR\n  plan --> build';

beforeEach(() => {
  vi.clearAllMocks();
  diagramView.setState({ source: false });
  document.documentElement.classList.remove('dark');
  mermaid.parse.mockResolvedValue(true);
  mermaid.render.mockImplementation((id) =>
    Promise.resolve({ svg: `<svg id="${id}"><text>plan</text></svg>` }),
  );
});

describe('mermaid diagram (review loop spec 2)', () => {
  it('draws a complete mermaid block as a diagram with a Source switch', async () => {
    const user = userEvent.setup();
    const { container } = render(<Markdown text={`Flow:\n\n\`\`\`mermaid\n${source}\n\`\`\``} />);
    const diagram = await screen.findByRole('img', { name: 'Diagram' });
    expect(diagram.querySelector('svg text')?.textContent).toBe('plan');
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^wow-diagram-\d+$/), source);

    const toggle = screen.getByRole('button', { name: 'Source' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(screen.queryByRole('img', { name: 'Diagram' })).toBeNull();
    expect(container.querySelector('.wow-code')?.textContent).toBe(source);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    expect(screen.getByRole('img', { name: 'Diagram' })).toBeTruthy();
  });

  it('shows the source as code with a one-line reason when the diagram is invalid', async () => {
    mermaid.parse.mockRejectedValue(
      new Error('Parse error on line 2:\nflowchart LR  plan -->\n-----------------------^'),
    );
    const { container } = render(<MermaidDiagram source="flowchart LR\n  plan -->" />);
    expect((await screen.findByRole('note')).textContent).toBe(
      'Diagram not drawn: Parse error on line 2',
    );
    expect(container.querySelector('.wow-code')?.textContent).toBe('flowchart LR\\n  plan -->');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('gives a reason when drawing fails after the source parsed', async () => {
    mermaid.render.mockRejectedValue(new Error('No layout'));
    render(<MermaidDiagram source={source} />);
    expect((await screen.findByRole('note')).textContent).toBe('Diagram not drawn: No layout');
  });

  it('runs mermaid at its strict security level, in the theme of the app', async () => {
    render(<MermaidDiagram source={source} />);
    await screen.findByRole('img', { name: 'Diagram' });
    expect(mermaid.initialize).toHaveBeenLastCalledWith({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    });
  });

  it('shows the source of every diagram after the palette command', async () => {
    const user = userEvent.setup();
    render(<MermaidDiagram source={source} />);
    await screen.findByRole('img', { name: 'Diagram' });
    // A choice made on the diagram itself does not outlive the command.
    await user.click(screen.getByRole('button', { name: 'Source' }));
    await user.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('img', { name: 'Diagram' })).toBeTruthy();
    act(() => toggleDiagramSource());
    expect(screen.queryByRole('img', { name: 'Diagram' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Source' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
