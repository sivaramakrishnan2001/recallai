// Webhook Sender — Send interview results to n8n

import { generateReport } from "./evaluator.js";

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

export async function sendResultsToN8n(session) {
  if (!N8N_WEBHOOK_URL) return;

  try {
    const report = generateReport(session);
    await fetch(N8N_WEBHOOK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(report),
    });
    console.log("[n8n] Results sent");
  } catch (err) {
    console.error(`[n8n] Webhook error: ${err.message}`);
  }
}
