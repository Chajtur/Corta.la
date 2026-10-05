const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const emailService = require('../email');

test('Resend receives a safe, authenticated transactional message', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'corta.la <noreply@corta.la>';
  let captured;
  const originalPost = axios.post;
  axios.post = async (...args) => {
    captured = args;
    return { data: { id: 'mock-message-id' } };
  };
  try {
    const result = await emailService.sendAuthEmail({
      to: 'person@example.com',
      kind: 'verify',
      actionUrl: 'https://corta.la/verify-email#verify=opaque-token&test="injection',
    });
    assert.deepEqual(result, { id: 'mock-message-id' });
    assert.equal(captured[0], 'https://api.resend.com/emails');
    assert.equal(captured[1].from, 'corta.la <noreply@corta.la>');
    assert.deepEqual(captured[1].to, ['person@example.com']);
    assert.equal(captured[2].headers.Authorization, 'Bearer re_test_key');
    assert.ok(captured[1].html.includes('&quot;injection'));
    assert.ok(captured[1].text.includes('opaque-token'));
  } finally {
    axios.post = originalPost;
  }
});
