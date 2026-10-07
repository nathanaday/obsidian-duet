import type { Question, QuestionAnswers } from '../../src/index.ts';

export interface QuestionForm {
  /** Moves focus to the first choice. */
  focus(): void;
}

/**
 * Shows the agent's questions with their options and a field for an answer of the user's own. "Answer" stays
 * disabled until every question has an answer. `done` gets the answers, or undefined when the user skips.
 */
export function renderQuestions(
  parent: HTMLElement,
  questions: Question[],
  choicesClass: string,
  done: (answers: QuestionAnswers | undefined) => void,
): QuestionForm {
  const form = parent.createEl('form', { cls: 'duet-questions' });
  const answers: (() => string)[] = [];
  const refresh = () => {
    submit.disabled = answers.some((answer) => !answer());
  };

  questions.forEach((question, index) => {
    const fieldset = form.createEl('fieldset', { cls: 'duet-question' });
    const legend = fieldset.createEl('legend', { cls: 'duet-question-text' });
    if (question.header) legend.createSpan({ cls: 'duet-question-header', text: question.header });
    legend.createSpan({ text: question.question });
    const type = question.multiSelect ? 'checkbox' : 'radio';
    const name = `duet-question-${index}`;
    const boxes = question.options.map((option) => {
      const row = fieldset.createEl('label', { cls: 'duet-question-option' });
      const box = row.createEl('input', { type, attr: { name } });
      const text = row.createDiv({ cls: 'duet-question-option-text' });
      text.createDiv({ cls: 'duet-question-label', text: option.label });
      if (option.description) text.createDiv({ cls: 'duet-question-description', text: option.description });
      return box;
    });

    const otherRow = fieldset.createEl('label', { cls: 'duet-question-option is-other' });
    const otherBox = otherRow.createEl('input', { type, attr: { name, 'aria-label': 'Other' } });
    const other = otherRow.createEl('input', { type: 'text', cls: 'duet-question-other', attr: { placeholder: 'Other answer' } });
    other.addEventListener('focus', () => {
      if (!otherBox.checked) {
        otherBox.checked = true;
        refresh();
      }
    });
    other.addEventListener('input', () => {
      otherBox.checked = Boolean(other.value.trim()) || otherBox.checked;
      refresh();
    });
    otherBox.addEventListener('change', () => {
      if (otherBox.checked) other.focus();
    });
    for (const box of [...boxes, otherBox]) box.addEventListener('change', refresh);

    answers.push(() =>
      [
        ...question.options.filter((_, option) => boxes[option]!.checked).map((option) => option.label),
        ...(otherBox.checked && other.value.trim() ? [other.value.trim()] : []),
      ].join(', '),
    );
  });

  const choices = form.createDiv({ cls: choicesClass });
  const submit = choices.createEl('button', { cls: 'mod-cta', attr: { type: 'submit' } });
  submit.createSpan({ text: 'Answer' });
  submit.createEl('kbd', { text: '↵' });
  const skip = choices.createEl('button', { text: 'Skip', attr: { type: 'button' } });
  skip.addEventListener('click', () => done(undefined));
  // Enter answers from any field, not only from the text field.
  form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    form.requestSubmit();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    done(Object.fromEntries(questions.map((question, index) => [question.question, answers[index]!()])));
  });
  refresh();

  return {
    focus: () => form.querySelector('input')?.focus(),
  };
}
