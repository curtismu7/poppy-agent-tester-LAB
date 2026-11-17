import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessions } from '../src/sessions.js';

// Spec 1.0 section 5.1: one random User ID per person per Company, kept only in the agent.
const A = 'https://auth.a.example'; const B = 'https://auth.b.example';

test('a User ID is random, long enough to be unguessable, and carries nothing about the person', () => {
  const s = createSessions();
  const id = s.userId('w1', A);
  assert.match(id, /^usr-[A-Za-z0-9_-]{22}$/);
  assert.notEqual(createSessions().userId('w1', A), id, 'two agents never derive the same ID from the same inputs');
});

test('the same Company gets the same User ID every time', () => {
  const s = createSessions();
  assert.equal(s.userId('w1', A), s.userId('w1', A));
});

test('a different Company gets a different User ID, so two Companies cannot link the person', () => {
  const s = createSessions();
  assert.notEqual(s.userId('w1', A), s.userId('w1', B));
});

test('another visitor gets another User ID, and Reset starts a new one', () => {
  const s = createSessions();
  const a = s.userId('w1', A);
  assert.notEqual(s.userId('w2', A), a);
  s.reset('w1');
  assert.notEqual(s.userId('w1', A), a);
});
