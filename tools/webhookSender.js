// Webhook Sender — Send interview results to n8n

import { generateReport } from "./evaluator.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export async function sendResultsToN8n(session) {
  const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
  if (!N8N_WEBHOOK_URL) {
    console.warn("[n8n] N8N_WEBHOOK_URL not set — skipping result delivery");
    return;
  }

  const report = generateReport(session);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(report),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${body.substring(0, 200)}`);
      }

      console.log(`[n8n] Results delivered (attempt ${attempt})`);
      return;
    } catch (err) {
      console.error(`[n8n] Webhook error (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }

  console.error(`[n8n] Failed to deliver results after ${MAX_RETRIES} attempts`);
}
