import { describe, expect, it } from 'vitest';
import { askedSecretWord, defaultAskRefusedWords } from './assistant.js';
import { cardOrder, markRecommended, replyProblem, replyText, shownLabel } from './questions.js';

// The question card's shapes (questions-and-models plan U1). Invented questions.

describe('a question and its answer', () => {
  it('marks a "(Recommended)" choice, keeps its label and lists it first', () => {
    const options = [{ label: 'Jest' }, { label: 'Vitest (Recommended)' }].map(markRecommended);
    expect(options).toEqual([
      { label: 'Jest' },
      { label: 'Vitest (Recommended)', recommended: true },
    ]);
    expect(cardOrder(options).map((option) => shownLabel(option.label))).toEqual([
      'Vitest',
      'Jest',
    ]);
  });

  it('writes an answer as the picked labels and then the typed text', () => {
    expect(replyText({ picked: ['Green', 'Oolong'], text: '  and rare ones ' })).toBe(
      'Green, Oolong, and rare ones',
    );
    expect(replyText({ picked: [], text: 'none' })).toBe('none');
  });

  it('says why an answer cannot be sent', () => {
    const question = { options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false };
    expect(replyProblem(question, { picked: [], text: ' ' })).toBe(
      'Pick a choice or type an answer.',
    );
    expect(replyProblem(question, { picked: ['Green'], text: '' })).toBe(
      '"Green" is not one of the choices.',
    );
    expect(replyProblem(question, { picked: ['Red', 'Blue'], text: '' })).toBe(
      'Only one choice can be picked.',
    );
    expect(
      replyProblem({ ...question, multiSelect: true }, { picked: ['Red', 'Blue'], text: '' }),
    ).toBeNull();
    expect(replyProblem(question, { picked: [], text: 'teal' })).toBeNull();
  });
});

const ask = (question: string, label = 'Yes') => ({
  questions: [{ question, header: 'Ask', options: [{ label }], multiSelect: false }],
});

describe('a question that asks for a secret (spec 11)', () => {
  it('finds the words of the setting as whole words, without regard to case', () => {
    expect(askedSecretWord(ask('Paste your API Key?'), defaultAskRefusedWords)).toBe('key');
    expect(askedSecretWord(ask('Which one?', 'My password'), defaultAskRefusedWords)).toBe(
      'password',
    );
    expect(askedSecretWord(ask('Which keyboard layout?'), defaultAskRefusedWords)).toBeNull();
    expect(askedSecretWord(ask('Which tokenizer?'), defaultAskRefusedWords)).toBeNull();
    expect(askedSecretWord(ask('Use an access   token?'), ['access token'])).toBe('access token');
  });
});
