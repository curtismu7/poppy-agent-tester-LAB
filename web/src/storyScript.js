// The Story script: one entry per caption key, in the order the walk-through shows them. Pure data, no DOM: storyWiring.js turns each entry into an engine
// step (a selector, a live line). The wording is in video/captions.md; storyWiring.test.jsx checks the two agree.
//
//   target   a CSS selector | () => Element|null (missing at show time => the step is skipped)
//   prompt   { press } the viewer (or Play) presses that existing button
//   lines    the name of a live value the page reads for the bubble's fact lines (storyWiring.js)
//   when     the name of a condition (storyWiring.js CONDITIONS)
//   sampleKey the Mock wording key
//   tab      switch to this tab before the step shows
// Hold times for Play for me come from the wording and the shared hold.js — no fixed holds (no video to match yet).

const CHAT = 'chat';
const WHY = 'why';

export const STEPS = [
  { key: 'mock_note', type: 'slide', trigger: 'load', modes: ['mock'] },   // the hosted build says so first
  { key: 'opening', type: 'slide', trigger: 'load' },
  { key: 'why_poppy', type: 'slide', trigger: 'load', tab: WHY, when: 'notDiscovered' },

  // ---- the Agent chat: the story presses the chat's own chips; the bubbles land on the sequence cards the run produced.
  // A card this run did not produce skips its bubble (a hosted build, a Company without PAR).
  { key: 'chat_intro', type: 'bubble', tab: CHAT, trigger: 'load', target: '.atlas-phone__head', prefer: 'below', when: 'notDiscovered' },
  { key: 'chat_discover_prompt', modes: ['real'], type: 'bubble', tab: CHAT, trigger: 'load', target: '[data-testid=atlas-chip-0]', prefer: 'below', when: 'notDiscovered', prompt: { press: '[data-testid=atlas-chip-0]' }, sampleKey: 'sample_chat_discover_prompt' },
  { key: 'chat_discover', modes: ['real'], type: 'bubble', tab: CHAT, trigger: 'run-done', targetKind: 'discover', prefer: 'below', sampleKey: 'sample_chat_discover' },
  { key: 'chat_signin_prompt', modes: ['real'], type: 'bubble', tab: CHAT, trigger: 'load', target: '[data-testid=atlas-chip-0]', prefer: 'below', when: 'discovered', prompt: { press: '[data-testid=atlas-chip-0]' } },
  // The sign-in chip leaves for the authorization server's own page; the story resumes after the redirect (?signin=ok) — StoryRoot carries Play across.
  { key: 'chat_signin', modes: ['real'], type: 'bubble', tab: CHAT, trigger: 'load', targetKind: 'authorize', prefer: 'below', when: 'signedInOrBeyond', sampleKey: 'sample_chat_signin' },
  { key: 'chat_token', modes: ['real'], type: 'bubble', tab: CHAT, trigger: 'run-done', targetKind: 'token', prefer: 'below', sampleKey: 'sample_chat_token' },
  { key: 'chat_call', modes: ['real'], type: 'bubble', tab: CHAT, trigger: 'load', target: '[data-testid=atlas-chip-0]', prefer: 'below', when: 'signedInOrBeyond', prompt: { press: '[data-testid=atlas-chip-0]' }, sampleKey: 'sample_chat_call' },
  { key: 'chat_done', modes: ['real'], type: 'bubble', tab: CHAT, trigger: 'run-done', target: () => document.querySelector('[data-testid=sequence-view]'), prefer: 'below' },

  // ---- the end
  { key: 'closing', type: 'slide', trigger: 'load' },
];

// Mock wording keys the script names that are not steps of their own.
export const EXTRA_SAMPLE_KEYS = ['sample_chat_discover_prompt', 'sample_chat_discover', 'sample_chat_signin', 'sample_chat_token', 'sample_chat_call'];

// Story-only bubbles (none: this lab has no video, so every key is live in Story).
export const STORY_ONLY = [];
export const VIDEO_ONLY = [];

// What the parity test hands to captions.js parity(): the caption keys this script needs.
export function scriptKeys() {
  return {
    steps: STEPS.filter((s) => s.type === 'bubble').map((s) => s.key),
    slides: STEPS.filter((s) => s.type === 'slide').map((s) => s.key),
    sampleKeys: [...STEPS.map((s) => s.sampleKey).filter(Boolean), ...EXTRA_SAMPLE_KEYS],
  };
}
