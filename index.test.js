const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Mock @google-cloud/pubsub before requiring index.js
let publishMessageCalled = false;
let publishedData = null;
let publishedAttributes = null;

class MockPubSub {
  constructor(options) {
    this.options = options;
  }
  topic(name) {
    return {
      publishMessage: async ({ data, attributes }) => {
        publishMessageCalled = true;
        publishedData = data;
        publishedAttributes = attributes;
        return 'mock-message-id-12345';
      }
    };
  }
}

require.cache[require.resolve('@google-cloud/pubsub')] = {
  exports: { PubSub: MockPubSub }
};

require.cache[require.resolve('dotenv')] = {
  exports: {
    config: () => ({ parsed: {} })
  }
};

function createMockResponse() {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  return res;
}

test('breweryWebhookHandler unit tests', async (t) => {
  
  t.beforeEach(() => {
    publishMessageCalled = false;
    publishedData = null;
    publishedAttributes = null;
  });

  // Helper to get the handler with the secret configured
  const getHandlerWithSecret = () => {
    process.env.BREWERY_GITHUB_WEBHOOK_SECRET = 'test-secret';
    delete require.cache[require.resolve('./index.js')];
    return require('./index.js').breweryWebhookHandler;
  };

  await t.test('should return 500 if BREWERY_GITHUB_WEBHOOK_SECRET is not configured', async () => {
    // Delete secret from env, clear cache and require
    delete process.env.BREWERY_GITHUB_WEBHOOK_SECRET;
    delete require.cache[require.resolve('./index.js')];
    const { breweryWebhookHandler } = require('./index.js');

    const req = {
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=somesignature'
      },
      rawBody: Buffer.from('{}')
    };
    const res = createMockResponse();

    await breweryWebhookHandler(req, res);

    assert.strictEqual(res.statusCode, 500);
    assert.match(res.body, /Webhook signature verification is misconfigured/);
  });

  await t.test('should return 400 if X-GitHub-Event header is missing', async () => {
    const breweryWebhookHandler = getHandlerWithSecret();
    const req = {
      headers: {},
      rawBody: Buffer.from('{}')
    };
    const res = createMockResponse();

    await breweryWebhookHandler(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, 'Missing X-GitHub-Event header');
  });

  await t.test('should return 400 if request body is missing', async () => {
    const breweryWebhookHandler = getHandlerWithSecret();
    const req = {
      headers: {
        'x-github-event': 'push'
      }
    };
    const res = createMockResponse();

    await breweryWebhookHandler(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body, 'Missing request body');
  });

  await t.test('should return 401 if signature is invalid', async () => {
    const breweryWebhookHandler = getHandlerWithSecret();
    const req = {
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=invalid-signature'
      },
      rawBody: Buffer.from('{}')
    };
    const res = createMockResponse();

    await breweryWebhookHandler(req, res);

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body, 'Signature verification failed');
  });

  await t.test('should return 200/pong for ping events', async () => {
    const breweryWebhookHandler = getHandlerWithSecret();
    const secret = 'test-secret';
    const payloadStr = '{"zen": "Keep it simple"}';
    const hmac = crypto.createHmac('sha256', secret);
    const signature = 'sha256=' + hmac.update(payloadStr).digest('hex');

    const req = {
      headers: {
        'x-github-event': 'ping',
        'x-hub-signature-256': signature
      },
      rawBody: Buffer.from(payloadStr)
    };
    const res = createMockResponse();

    await breweryWebhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { message: 'pong' });
    assert.strictEqual(publishMessageCalled, false);
  });

  await t.test('should ignore non-push events and return 200', async () => {
    const breweryWebhookHandler = getHandlerWithSecret();
    const secret = 'test-secret';
    const payloadStr = '{"action": "opened"}';
    const hmac = crypto.createHmac('sha256', secret);
    const signature = 'sha256=' + hmac.update(payloadStr).digest('hex');

    const req = {
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature
      },
      rawBody: Buffer.from(payloadStr)
    };
    const res = createMockResponse();

    await breweryWebhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body.message, /Ignored: Event type is/);
    assert.strictEqual(publishMessageCalled, false);
  });

  await t.test('should ignore push events that are not for refs/heads/main', async () => {
    const breweryWebhookHandler = getHandlerWithSecret();
    const secret = 'test-secret';
    const payloadStr = '{"ref": "refs/heads/feature-branch", "repository": {"full_name": "test/repo"}}';
    const hmac = crypto.createHmac('sha256', secret);
    const signature = 'sha256=' + hmac.update(payloadStr).digest('hex');

    const req = {
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': signature
      },
      rawBody: Buffer.from(payloadStr)
    };
    const res = createMockResponse();

    await breweryWebhookHandler(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body.message, /Ignored: Push ref is/);
    assert.strictEqual(publishMessageCalled, false);
  });

  await t.test('should publish to Pub/Sub and return 202 for push events to refs/heads/main', async () => {
    const breweryWebhookHandler = getHandlerWithSecret();
    const secret = 'test-secret';
    const payloadStr = '{"ref": "refs/heads/main", "repository": {"full_name": "test/repo"}}';
    const hmac = crypto.createHmac('sha256', secret);
    const signature = 'sha256=' + hmac.update(payloadStr).digest('hex');

    const req = {
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': signature
      },
      rawBody: Buffer.from(payloadStr)
    };
    const res = createMockResponse();

    await breweryWebhookHandler(req, res);

    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.body, { message: 'Accepted', messageId: 'mock-message-id-12345' });
    assert.strictEqual(publishMessageCalled, true);
    assert.strictEqual(publishedData.toString(), payloadStr);
    assert.deepStrictEqual(publishedAttributes, {
      'x-github-event': 'push',
      'x-hub-signature-256': signature
    });
  });
});
