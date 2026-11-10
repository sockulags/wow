import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMarkdown } from '../test/markdown';
import { Markdown } from './markdown';
import { diagramView, scrubSvg, toggleDiagramSource } from './mermaid';
import { MermaidDiagram } from './mermaid-diagram';

beforeAll(loadMarkdown);

// jsdom lacks the layout APIs mermaid draws with, so the library is replaced here; the real
// drawing is covered by the e2e case "chat renders a table and a diagram".
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn<(config: Record<string, unknown>) => void>(),
  mermaidAPI: { getDiagramFromText: vi.fn<(source: string) => Promise<{ db: object }>>() },
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const source = 'flowchart LR\n  plan --> build';

beforeEach(() => {
  vi.clearAllMocks();
  diagramView.setState({ source: false });
  document.documentElement.classList.remove('dark');
  mermaid.mermaidAPI.getDiagramFromText.mockResolvedValue({ db: {} });
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
    mermaid.mermaidAPI.getDiagramFromText.mockRejectedValue(
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
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'default',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      }),
    );
    // A diagram's own directives cannot bring CSS or fonts, or turn HTML labels back on.
    expect(mermaid.initialize.mock.lastCall?.[0]['secure']).toEqual(
      expect.arrayContaining([
        'securityLevel',
        'themeCSS',
        'themeVariables',
        'fontFamily',
        'altFontFamily',
        'htmlLabels',
      ]),
    );
  });

  it('refuses an image shape before drawing, because drawing it fetches the image', async () => {
    mermaid.mermaidAPI.getDiagramFromText.mockResolvedValue({
      db: {
        getVertices: () =>
          new Map([
            ['A', { id: 'A', img: 'https://elsewhere.example.test/a.png' }],
            ['B', { id: 'B' }],
          ]),
      },
    });
    render(<MermaidDiagram source={'flowchart LR\n  A@{ img: "x" } --> B'} />);
    expect((await screen.findByRole('note')).textContent).toBe(
      'Diagram not drawn: Image shapes are not drawn',
    );
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('refuses a style that loads something, in any diagram type, before the library sees it', async () => {
    const host = 'https://elsewhere.example.test';
    const reaching = [
      `stateDiagram-v2\n  classDef evil background-image:url(${host}/state.png)\n  [*] --> A\n  class A evil`,
      `stateDiagram-v2\n  classDef evil fill:url(${host}/fill.svg#p)\n  [*] --> A\n  class A evil`,
      `stateDiagram-v2\n  classDef evil background:u\\rl('${host}/escaped.png')\n  [*] --> A`,
      `classDiagram\n  class A\n  style A background-image:image-set("${host}/set.png" 1x)`,
      `flowchart LR\n  A --> B\n  style A fill:URL( "${host}/flow.svg#p" )`,
    ];
    for (const diagram of reaching) {
      const { unmount } = render(<MermaidDiagram source={diagram} />);
      expect((await screen.findByRole('note')).textContent).toBe(
        'Diagram not drawn: Styles that load something are not drawn',
      );
      unmount();
    }
    expect(mermaid.mermaidAPI.getDiagramFromText).not.toHaveBeenCalled();
    expect(mermaid.render).not.toHaveBeenCalled();

    // A reference inside the drawing loads nothing and is drawn.
    render(
      <MermaidDiagram
        source={'stateDiagram-v2\n  classDef own fill:url(#gradient)\n  [*] --> A'}
      />,
    );
    expect(await screen.findByRole('img', { name: 'Diagram' })).toBeTruthy();
  });

  it('shows a drawn diagram without anything that would be fetched', async () => {
    mermaid.render.mockResolvedValue({
      svg: [
        '<svg id="d"><style>@import url(https://elsewhere.example.test/a.css);',
        '#d .node{fill:u\\rl("https://elsewhere.example.test/b.png");stroke:#333}',
        '#d .edge{marker-end:url(#arrow)}</style>',
        '<g><image href="https://elsewhere.example.test/c.png"></image>',
        '<foreignObject><div><img src="https://elsewhere.example.test/d.png">plan</div>',
        '</foreignObject><rect fill="url(https://elsewhere.example.test/e.svg#p)" width="4">',
        '</rect><path marker-end="url(#arrow)" onclick="go()"></path>',
        '<use href="https://elsewhere.example.test/f.svg#s"></use><use href="#local"></use>',
        '<filter><feImage href="https://elsewhere.example.test/g.png"></feImage></filter>',
        '</g></svg>',
      ].join(''),
    });
    render(<MermaidDiagram source={source} />);
    const diagram = await screen.findByRole('img', { name: 'Diagram' });
    expect(diagram.innerHTML).not.toContain('elsewhere.example.test');
    expect(diagram.querySelectorAll('img, image, feImage')).toHaveLength(0);
    expect(diagram.querySelector('style')?.textContent).toBe(
      '#d .node{fill:none;stroke:#333}#d .edge{marker-end:url(#arrow)}',
    );
    expect(diagram.querySelector('rect')?.getAttribute('fill')).toBeNull();
    expect(diagram.querySelector('rect')?.getAttribute('width')).toBe('4');
    expect(diagram.querySelector('path')?.getAttribute('marker-end')).toBe('url(#arrow)');
    expect(diagram.querySelector('path')?.getAttribute('onclick')).toBeNull();
    expect([...diagram.querySelectorAll('use')].map((use) => use.getAttribute('href'))).toEqual([
      null,
      '#local',
    ]);
    expect(diagram.textContent).toContain('plan');
    expect(scrubSvg('<p>no drawing</p>')).toBeUndefined();
  });

  it('opens a diagram link outside the app, and only for http, https and mailto', async () => {
    mermaid.render.mockResolvedValue({
      svg: [
        '<svg><a xlink:href="https://docs.example.test/plan"><text>plan</text></a>',
        '<a href="mailto:owner@example.test"><text>mail</text></a>',
        '<a xlink:href="javascript:alert(1)"><text>script</text></a>',
        '<a href="file:///c:/secret.txt"><text>file</text></a></svg>',
      ].join(''),
    });
    render(<MermaidDiagram source={source} />);
    const diagram = await screen.findByRole('img', { name: 'Diagram' });
    const links = [...diagram.querySelectorAll('a')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
      link.getAttribute('xlink:href'),
      link.getAttribute('target'),
      link.getAttribute('rel'),
    ]);
    expect(links).toEqual([
      ['plan', 'https://docs.example.test/plan', null, '_blank', 'noreferrer'],
      ['mail', 'mailto:owner@example.test', null, '_blank', 'noreferrer'],
      ['script', null, null, null, null],
      ['file', null, null, null, null],
    ]);
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
