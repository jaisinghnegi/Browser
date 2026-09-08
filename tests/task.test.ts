import { describe, expect, it } from 'vitest';
import { buildPayload, parseAction } from '../extension/protocol';
import { Task, type Binding } from '../extension/task';

const binding: Binding = {
  taskId: '11111111-1111-4111-8111-111111111111',
  observationId: '22222222-2222-4222-8222-222222222222',
  target: '33333333-3333-4333-8333-333333333333',
  documentId: '44444444-4444-4444-8444-444444444444',
  tabId: 7, origin: 'http://localhost:8171', version: 0,
};
const action = {
  action: 'fill' as const, actionId: '55555555-5555-4555-8555-555555555555',
  taskId: binding.taskId, observationId: binding.observationId,
  target: binding.target, valueRef: 'ADDRESS_1' as const,
};
const secret = '991 Vault Lane, Testville 00000';

describe('outbound contract', () => {
  it('constructs only fixed semantics and opaque IDs, discarding all local data', () => {
    const payload = buildPayload({ ...binding, secret, screenshot: 'raw', text: '71 Visible Road' } as Binding);
    expect(payload).toEqual({
      protocol: 1, taskId: binding.taskId, observationId: binding.observationId,
      target: binding.target, fieldKind: 'shipping-address', valueRef: 'ADDRESS_1',
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });
  it('rejects malformed IDs before upload', () => {
    expect(() => buildPayload({ ...binding, target: secret })).toThrow();
  });
  it.each([
    { ...action, value: secret }, { ...action, action: 'submit' },
    { ...action, valueRef: 'PASSWORD_1' }, { ...action, selector: '#shipping' },
    { ...action, actionId: '' }, null,
  ])('rejects untrusted action %j', value => expect(() => parseAction(value)).toThrow());
});

describe('one-use task vault', () => {
  it('resolves only once for the exact authorized destination', () => {
    const task = new Task(binding, secret);
    expect(task.consume(action, binding)).toBe(secret);
    expect(() => task.consume(action, binding)).toThrow();
  });
  it.each([
    { tabId: 8 }, { origin: 'https://evil.example' }, { version: 1 },
    { documentId: '66666666-6666-4666-8666-666666666666' },
    { target: '66666666-6666-4666-8666-666666666666' },
    { observationId: '66666666-6666-4666-8666-666666666666' },
  ])('rejects changed binding %j and erases the task', change => {
    const task = new Task(binding, secret);
    expect(() => task.consume(action, { ...binding, ...change })).toThrow();
    expect(() => task.consume(action, binding)).toThrow();
  });
  it.each(['taskId', 'observationId', 'target'] as const)('rejects another %s', field => {
    const task = new Task(binding, secret);
    expect(() => task.consume({ ...action, [field]: '66666666-6666-4666-8666-666666666666' }, binding)).toThrow();
  });
  it('rejects unauthorized references', () => {
    const task = new Task(binding, secret);
    expect(() => task.consume({ ...action, valueRef: 'ADDRESS_2' }, binding)).toThrow();
  });
  it('cancels and expires without returning the value', () => {
    const task = new Task(binding, secret);
    task.cancel();
    expect(() => task.consume(action, binding)).toThrow();
    const expired = new Task(binding, secret, -1);
    expect(() => expired.consume(action, binding)).toThrow();
  });
  it('takes an immutable copy of the destination binding', () => {
    const mutable = { ...binding };
    const task = new Task(mutable, secret);
    mutable.tabId = 9;
    expect(() => task.consume(action, mutable)).toThrow();
  });
});
