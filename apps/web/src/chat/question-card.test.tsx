import type { Question, QuestionReply, ThreadItem } from '@wow/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithRuntime } from '@/test/render';
import { ConversationItem, type ItemContext } from './items';
import { QuestionCard, type CardQuestion } from './question-card';
import { questionCommands } from './question-commands';
import { activeQuestionCard, questionStore } from './question-store';
import { groupQuestions, type ConversationEntry } from './view-model';

// The question card (questions-and-models plan U1, spec 1 to 5 and 8). Invented questions.

afterEach(() => questionStore.setState({ cards: [] }));

const kettle: CardQuestion = {
  key: 'kettle',
  question: 'Which kettle should the tea timer start?',
  header: 'Kettle',
  options: [
    { label: 'Glass kettle', description: 'Shows the water' },
    { label: 'Steel kettle (Recommended)', description: 'Boils faster', recommended: true },
    { label: 'Travel kettle' },
  ],
  multiSelect: false,
  status: { kind: 'open' },
};

const teas: CardQuestion = {
  key: 'teas',
  question: 'Which teas go on the list?',
  header: 'Teas',
  options: [{ label: 'Green' }, { label: 'Black' }, { label: 'Oolong' }],
  multiSelect: true,
  status: { kind: 'open' },
};

function card(questions: readonly CardQuestion[], extra: { waitReason?: string } = {}) {
  const onSend = vi.fn<(replies: ReadonlyMap<string, QuestionReply>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  render(
    <QuestionCard
      id="card-1"
      questions={questions}
      closedReason="the turn ended before an answer was sent."
      onSend={onSend}
      {...extra}
    />,
  );
  const sent = () => onSend.mock.calls.map(([replies]) => Object.fromEntries(replies));
  return { onSend, sent, region: () => screen.getByTestId('question-card') };
}

describe('the card (spec 1, 2)', () => {
  it('shows the header as a chip, the recommended choice first and marked, and Other last with a text field', () => {
    card([kettle]);
    const region = screen.getByRole('region', { name: 'Question' });
    expect(within(region).getByTestId('question-header').textContent).toBe('Kettle');
    const choices = within(region).getAllByRole('radio');
    expect(choices.map((choice) => choice.textContent)).toEqual([
      '1Steel kettleRecommendedBoils faster',
      '2Glass kettleShows the water',
      '3Travel kettle',
    ]);
    expect(choices[0]?.getAttribute('data-recommended')).toBe('true');
    const other = within(region).getByRole('textbox', { name: 'Other' });
    expect(other.closest('label')?.textContent).toContain('4Other');
  });

  it('sends a choice, a typed text, or both, and not an empty answer', async () => {
    const user = userEvent.setup();
    const { sent } = card([kettle]);
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('radio', { name: /Glass kettle/ }));
    await user.type(screen.getByRole('textbox', { name: 'Other' }), 'the clean one');
    await user.click(send);
    expect(sent()).toEqual([{ kettle: { picked: ['Glass kettle'], text: 'the clean one' } }]);
  });

  it('sends typed text alone, and a choice alone with its label as the provider wrote it', async () => {
    const user = userEvent.setup();
    const { sent } = card([kettle]);
    await user.type(screen.getByRole('textbox', { name: 'Other' }), 'any{Enter}');
    expect(sent()).toEqual([{ kettle: { picked: [], text: 'any' } }]);
    await user.clear(screen.getByRole('textbox', { name: 'Other' }));
    await user.click(screen.getByRole('radio', { name: /Steel kettle/ }));
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(sent()[1]).toEqual({ kettle: { picked: ['Steel kettle (Recommended)'], text: '' } });
  });

  it('picks one choice where one is asked and several where several are', async () => {
    const user = userEvent.setup();
    const { sent } = card([teas]);
    const group = screen.getByRole('group', { name: 'Which teas go on the list?' });
    await user.click(within(group).getByRole('checkbox', { name: /Oolong/ }));
    await user.click(within(group).getByRole('checkbox', { name: /Green/ }));
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    // In the order the asker listed them.
    expect(sent()).toEqual([{ teas: { picked: ['Green', 'Oolong'], text: '' } }]);
  });

  it('keeps one pick on a single choice question', async () => {
    const user = userEvent.setup();
    card([kettle]);
    await user.click(screen.getByRole('radio', { name: /Glass kettle/ }));
    await user.click(screen.getByRole('radio', { name: /Travel kettle/ }));
    expect(
      screen
        .getAllByRole('radio')
        .filter((choice) => choice.getAttribute('aria-checked') === 'true')
        .map((choice) => choice.textContent),
    ).toEqual(['3Travel kettle']);
  });
});

describe('several questions in one ask (spec 3)', () => {
  it('answers both and sends them together, and only once both have an answer', async () => {
    const user = userEvent.setup();
    const { sent } = card([kettle, teas]);
    expect(screen.getByRole('region', { name: 'Questions' })).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send answers' });
    await user.click(screen.getByRole('radio', { name: /Glass kettle/ }));
    expect(send.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /Black/ }));
    await user.click(send);
    expect(sent()).toEqual([
      {
        kettle: { picked: ['Glass kettle'], text: '' },
        teas: { picked: ['Black'], text: '' },
      },
    ]);
  });
});

const commands = () => questionCommands(activeQuestionCard(questionStore.getState()));

describe('the keyboard and the palette (spec 4)', () => {
  it('moves with the arrows, picks with digits, sends with Enter, and typing lands in Other', async () => {
    const user = userEvent.setup();
    const { sent } = card([kettle, teas]);
    screen.getAllByRole('radio')[0]?.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Glass kettle');
    await user.keyboard(' ');
    expect(screen.getByRole('radio', { name: /Glass kettle/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.keyboard('3');
    expect(screen.getByRole('radio', { name: /Travel kettle/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    // Down past the first question's Other reaches the second question.
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Green');
    await user.keyboard('13');
    await user.keyboard('rare ones');
    const other = screen.getAllByRole('textbox', { name: 'Other' })[1];
    expect(document.activeElement).toBe(other);
    expect((other as HTMLInputElement).value).toBe('rare ones');
    await user.keyboard('{Enter}');
    expect(sent()).toEqual([
      {
        kettle: { picked: ['Travel kettle'], text: '' },
        teas: { picked: ['Green', 'Oolong'], text: 'rare ones' },
      },
    ]);
  });

  it('offers going to the card, each choice, Other and send in the palette, acting on the card', async () => {
    const user = userEvent.setup();
    const { sent } = card([kettle, teas]);
    expect(commands().map((command) => command.title)).toEqual([
      'Question: go to the card',
      'Question: Kettle: pick Steel kettle',
      'Question: Kettle: pick Glass kettle',
      'Question: Kettle: pick Travel kettle',
      'Question: Kettle: type your own answer',
      'Question: Teas: pick Green',
      'Question: Teas: pick Black',
      'Question: Teas: pick Oolong',
      'Question: Teas: type your own answer',
      'Question: send the answers',
    ]);
    expect(commands()[0]?.keybinding).toBe('keybindings.questionFocus');
    const run = (title: string) => {
      const command = commands().find((entry) => entry.title === title);
      if (!command) throw new Error(`no command ${title}`);
      command.run({} as never);
    };
    run('Question: go to the card');
    expect(document.activeElement?.textContent).toContain('Steel kettle');
    run('Question: Kettle: pick Steel kettle');
    run('Question: Teas: type your own answer');
    expect(document.activeElement).toBe(screen.getAllByRole('textbox', { name: 'Other' })[1]);
    await user.keyboard('white');
    run('Question: send the answers');
    expect(sent()).toEqual([
      {
        kettle: { picked: ['Steel kettle (Recommended)'], text: '' },
        teas: { picked: [], text: 'white' },
      },
    ]);
  });

  it('leaves the palette once nothing on the card can be answered', () => {
    card([{ ...kettle, status: { kind: 'closed' } }]);
    expect(activeQuestionCard(questionStore.getState())).toBeUndefined();
  });
});

describe('answered and not answered (spec 5)', () => {
  it('shows what was answered, and that a stopped question was not answered and takes no answer', () => {
    card([
      {
        ...kettle,
        status: {
          kind: 'answered',
          reply: { picked: ['Steel kettle (Recommended)'], text: 'red' },
        },
      },
      { ...teas, status: { kind: 'closed' } },
    ]);
    const [answered, stopped] = screen.getAllByTestId('question');
    expect(within(answered as HTMLElement).getByTestId('question-answer').textContent).toBe(
      'Answered: Steel kettle, red',
    );
    expect(within(stopped as HTMLElement).getByTestId('question-closed').textContent).toBe(
      'Not answered: the turn ended before an answer was sent.',
    );
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says why an open question cannot be sent yet', async () => {
    const user = userEvent.setup();
    const { onSend } = card([kettle], {
      waitReason: 'Answer when the assistant has finished its turn.',
    });
    await user.click(screen.getByRole('radio', { name: /Glass kettle/ }));
    expect(screen.getByRole('button', { name: 'Send answer' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Answer when the assistant has finished its turn.')).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });
});

const context: ItemContext = {
  cwd: '/work/demo',
  permissionLabel: 'Ask',
  turnEnded: true,
  at: undefined,
  awaitingApproval: false,
  formatAt: (iso) => iso,
};

const questionItem = (id: string, payload: unknown, turnId = 'tea:turn:0'): ThreadItem => ({
  id,
  threadId: 'tea',
  turnId,
  index: 1,
  kind: 'question',
  payload,
  streaming: false,
});

describe('a thread stored before the card (spec 8)', () => {
  it('shows an old question and its answer as before', () => {
    const item = questionItem('tea:turn:0:question:q', {
      questionId: 'tea:q',
      question: 'Which color should the button be?',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      multiSelect: false,
    });
    const row: Question = {
      id: 'tea:q',
      threadId: 'tea',
      itemId: item.id,
      request: {},
      answer: 'Blue',
      answeredAt: '2026-11-10T08:00:00.000Z',
    };
    renderWithRuntime(
      <ul>
        <ConversationItem item={item} approvals={[]} questions={[row]} context={context} />
      </ul>,
    );
    const region = screen.getByRole('region', { name: 'Question' });
    expect(region.textContent).toContain('Which color should the button be?');
    expect(within(region).getByTestId('question-answer').textContent).toBe('Answered: Blue');
    expect(within(region).queryByTestId('question-header')).toBeNull();
  });
});

const entry = (item: ThreadItem): ConversationEntry => ({ kind: 'item', item });
const asked = (id: string, askId?: string) =>
  questionItem(id, {
    questionId: id,
    question: id,
    options: [],
    multiSelect: false,
    ...(askId ? { askId } : {}),
  });

describe('one card per ask (spec 3)', () => {
  it('groups consecutive questions of one ask and leaves old questions alone', () => {
    const entries = groupQuestions([
      entry(asked('a', 'ask-1')),
      entry(asked('b', 'ask-1')),
      entry(asked('c', 'ask-2')),
      entry(asked('d')),
      entry(asked('e')),
    ]);
    expect(
      entries.map((one) =>
        one.kind === 'item' ? one.item.id : `${one.kind}:${one.items.map((i) => i.id).join('+')}`,
      ),
    ).toEqual(['questions:a+b', 'c', 'd', 'e']);
  });
});
