'use strict';
const form = document.querySelector('#chat-form');
const prompt = document.querySelector('#prompt');
const messages = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const notice = document.querySelector('#notice');
const send = document.querySelector('#send');
const stop = document.querySelector('#stop');
const thinking = document.querySelector('#thinking');
const statusDot = document.querySelector('#status-dot');
const composerDot = document.querySelector('#composer-dot');
const modelState = document.querySelector('#model-state');
const modelSelect = document.querySelector('#model');
const composerModel = document.querySelector('#composer-model');
let history = [];
let active = null;
let ready = null; // null = unknown/checking, true = probed ready, false = probed unavailable

const STATE_TEXT = { checking: 'checking…', ready: 'ready', unavailable: 'unavailable' };
function renderModelState(state) {
  statusDot.dataset.state = state;
  composerDot.dataset.state = state;
  modelState.textContent = STATE_TEXT[state];
  // Only a DEFINITIVE unavailable disables Send; while checking we stay optimistic.
  send.disabled = state === 'unavailable';
}

async function refreshModel() {
  renderModelState('checking');
  ready = null;
  try {
    const res = await fetch('/api/models', { headers: { Accept: 'application/json' } });
    const model = (await res.json())?.models?.[0];
    if (model) {
      const label = `${model.name}${model.location === 'local' ? ' · Local' : ''}`;
      if (modelSelect.options[0]) { modelSelect.options[0].textContent = label; modelSelect.options[0].value = model.id; }
      composerModel.textContent = model.name;
    }
    ready = model?.ready === true;
    renderModelState(ready ? 'ready' : 'unavailable');
  } catch {
    ready = false;
    renderModelState('unavailable');
  }
}
refreshModel();

function addMessage(role, text) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const heading = document.createElement('div');
  heading.className = 'message-heading';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'Y' : '◒';
  avatar.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.textContent = role === 'user' ? 'You' : 'Qwen · Local';
  heading.append(avatar, name);
  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = text; // Model output is text, never executable HTML.
  article.append(heading, content);
  messages.append(article);
  welcome.hidden = true;
  article.scrollIntoView({ block: 'end' });
  return article;
}

function setBusy(value) {
  send.hidden = value;
  stop.hidden = !value;
  thinking.hidden = !value;
  prompt.disabled = value;
}

function cancelRequest() {
  if (!active) return;
  active.abort();
  active = null;
  setBusy(false);
  notice.textContent = 'Stopped waiting. The local model may finish its current request.';
}

function newConversation() {
  cancelRequest();
  history = [];
  messages.replaceChildren();
  welcome.hidden = false;
  notice.textContent = 'New conversation. Previous messages cleared from this tab.';
  prompt.value = '';
  prompt.focus();
}
document.querySelector('#new-chat').addEventListener('click', newConversation);
document.querySelector('#mobile-new').addEventListener('click', newConversation);
stop.addEventListener('click', cancelRequest);
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  if (active) return;
  prompt.value = button.dataset.prompt;
  prompt.focus();
}));
prompt.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (active || !prompt.value.trim()) return;
  const text = prompt.value.trim();
  const context = [...history, { role: 'user', content: text }];
  let trimmed = false;
  while ((context.length > 11 || context.reduce((n, m) => n + m.content.length, 0) > 4000) && context.length > 1) {
    context.splice(0, 2);
    trimmed = true;
  }
  if (text.length > 4000) {
    notice.textContent = 'Please keep your message under 4,000 characters.';
    return;
  }
  const controller = new AbortController();
  active = controller;
  const article = addMessage('user', text);
  prompt.value = '';
  notice.textContent = trimmed ? 'Earlier turns were left out to fit the local context window.' : '';
  setBusy(true);
  const deadline = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: context }), signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status !== 422) void refreshModel(); // re-probe readiness after an outage
      throw new Error(response.status === 422 ? 'Message could not be accepted. Start a new conversation and try again.' : 'Local Qwen is unavailable or busy. Try again shortly.');
    }
    const result = await response.json();
    if (typeof result.reply !== 'string' || result.provider !== 'qwen-local') throw new Error('Unexpected model response. Please try again.');
    if (active !== controller || controller.signal.aborted) return;
    history = [...context, { role: 'assistant', content: result.reply }];
    addMessage('assistant', result.reply);
  } catch (error) {
    if (active !== controller) return;
    article.remove();
    prompt.value = text;
    welcome.hidden = messages.childElementCount > 0;
    notice.textContent = controller.signal.aborted ? 'Response timed out. Your message is ready to retry.' : error.message;
  } finally {
    clearTimeout(deadline);
    if (active === controller) {
      active = null;
      setBusy(false);
      prompt.focus();
    }
  }
});
