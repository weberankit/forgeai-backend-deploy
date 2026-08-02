import test from 'node:test';
import assert from 'node:assert/strict';
import { latestChatProjectId } from '../controllers/chatController.js';

test('chat hydration follows the latest conversation project instead of a stale recently updated project', () => {
  const messages = [
    { metadata: { projectId: 'initial-clarification-project' } },
    { metadata: {} },
    { metadata: { projectId: 'generated-project' } },
    { metadata: {} }
  ];
  assert.equal(latestChatProjectId(messages), 'generated-project');
  assert.equal(latestChatProjectId([]), '');
});
