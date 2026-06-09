# 🍺 Brewery Tap

`brewery-tap` is a serverless GitHub App Webhook Proxy designed to securely connect GitHub repository push events to your internal build systems. Running as a Google Cloud Run Function (2nd Gen), it acts as a webhook ingress point, validates request signatures, filters for updates to the `main` branch, and forwards valid payloads to a GCP Pub/Sub topic (`brewery-jobs`).

## Configuration

The function strictly requires the following environment variables to be set in your Cloud Run Function configuration:
* `GCP_PROJECT_ID`: Your Google Cloud Project ID.
* `PUBSUB_TOPIC_NAME`: The name of the Pub/Sub topic to publish events to (e.g., `brewery-jobs`).
* `BREWERY_GITHUB_WEBHOOK_SECRET`: The secret key registered with your GitHub App, securely retrieved from GCP Secret Manager.

If any of these environment variables are missing, or if the incoming webhook signature does not match the secret, the function will reject the request and return an HTTP error code (500 or 401 respectively).

## Deployment

To deploy this function directly to Google Cloud using the `gcloud` CLI:

```bash
gcloud functions deploy brewery-tap \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=breweryWebhook \
  --set-env-vars GCP_PROJECT_ID=your-gcp-project-id,PUBSUB_TOPIC_NAME=brewery-jobs \
  --set-secrets=BREWERY_GITHUB_WEBHOOK_SECRET=BREWERY_GITHUB_WEBHOOK_SECRET:latest
```