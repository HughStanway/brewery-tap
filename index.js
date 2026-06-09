const functions = require('@google-cloud/functions-framework');
const crypto = require('crypto');
const { PubSub } = require('@google-cloud/pubsub');

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const TOPIC_NAME = process.env.PUBSUB_TOPIC_NAME;
const WEBHOOK_SECRET = process.env.BREWERY_GITHUB_WEBHOOK_SECRET;

// Initialize GCP Pub/Sub client
const pubSubClient = new PubSub({
  projectId: GCP_PROJECT_ID
});

/**
 * Validates request payload hash matches header to verify authenticity
 */
function verifySignature(payload, signatureHeader) {
  if (!WEBHOOK_SECRET) {
    throw new Error('BREWERY_GITHUB_WEBHOOK_SECRET environment variable is not configured.');
  }
  if (!signatureHeader) {
    return false;
  }
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  
  const signatureBuffer = Buffer.from(signatureHeader);
  const digestBuffer = Buffer.from(digest);

  if (signatureBuffer.length !== digestBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(signatureBuffer, digestBuffer);
}

// The core handler function
const breweryWebhookHandler = async (req, res) => {
  // 0. Ensure all required environment configuration variables are present
  if (!GCP_PROJECT_ID || !TOPIC_NAME || !WEBHOOK_SECRET) {
    const missing = [];
    if (!GCP_PROJECT_ID) missing.push('GCP_PROJECT_ID');
    if (!TOPIC_NAME) missing.push('PUBSUB_TOPIC_NAME');
    if (!WEBHOOK_SECRET) missing.push('BREWERY_GITHUB_WEBHOOK_SECRET');
    console.error(`Configuration error: Missing environment variables: ${missing.join(', ')}`);
    return res.status(500).send(`Internal Server Error: Missing required environment configuration: ${missing.join(', ')}`);
  }

  const signatureHeader = req.headers['x-hub-signature-256'];
  const eventType = req.headers['x-github-event'];
  
  if (!eventType) {
    console.error('Missing X-GitHub-Event header');
    return res.status(400).send('Missing X-GitHub-Event header');
  }

  // Google Cloud Functions framework automatically populates raw request bytes to req.rawBody
  const rawBody = req.rawBody;
  if (!rawBody) {
    console.error('Missing request body');
    return res.status(400).send('Missing request body');
  }

  // 1. Verify webhook signature
  try {
    if (!verifySignature(rawBody, signatureHeader)) {
      console.error('Signature verification failed.');
      return res.status(401).send('Signature verification failed');
    }
  } catch (error) {
    console.error('Signature verification error:', error.message);
    return res.status(500).send('Internal Server Error: Webhook signature verification is misconfigured.');
  }

  console.log(`Received GitHub event: ${eventType}`);

  // Handle ping event
  if (eventType === 'ping') {
    console.log('GitHub ping event received. Webhook is active.');
    return res.status(200).send({ message: 'pong' });
  }

  // Parse payload JSON
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch (error) {
    console.error('Failed to parse request body as JSON:', error);
    return res.status(400).send('Invalid JSON payload');
  }

  // We only trigger when 'main' is updated on repositories.
  // This is identified by a 'push' event to 'refs/heads/main'.
  if (eventType !== 'push') {
    console.log(`Ignored: Event type is '${eventType}', not 'push'`);
    return res.status(200).send({ message: `Ignored: Event type is '${eventType}', only 'push' to 'main' is handled.` });
  }

  if (payload.ref !== 'refs/heads/main') {
    console.log(`Ignored: Push ref is '${payload.ref}', not 'refs/heads/main'`);
    return res.status(200).send({ message: `Ignored: Push ref is '${payload.ref}', only 'main' branch updates are handled.` });
  }

  console.log(`Processing push event on main branch for repository: ${payload.repository ? payload.repository.full_name : 'unknown'}`);

  try {
    // 2. Publish raw payload to GCP Pub/Sub
    const topic = pubSubClient.topic(TOPIC_NAME);
    
    // Pass event metadata inside headers/attributes
    const attributes = {
      'x-github-event': eventType
    };
    if (signatureHeader) {
      attributes['x-hub-signature-256'] = signatureHeader;
    }

    const messageId = await topic.publishMessage({
      data: rawBody,
      attributes: attributes
    });

    console.log(`Published message ${messageId} to topic ${TOPIC_NAME}`);
    res.status(202).send({ message: 'Accepted', messageId });
  } catch (error) {
    console.error('Failed to publish to Pub/Sub:', error);
    res.status(500).send('Internal Server Error');
  }
};

// Register the HTTP function with the Functions Framework
functions.http('breweryWebhook', breweryWebhookHandler);

module.exports = {
  breweryWebhookHandler,
  verifySignature
};

