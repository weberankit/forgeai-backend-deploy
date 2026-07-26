import { AsyncLocalStorage } from 'node:async_hooks';

const requestLlmStorage = new AsyncLocalStorage();

export function runWithRequestLlmContext(context, callback) {
  return requestLlmStorage.run(context, callback);
}

export function getRequestOpenAiApiKey() {
  return requestLlmStorage.getStore()?.openAiApiKey || '';
}
