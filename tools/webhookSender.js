// Webhook Sender — Send interview results to n8n

import { generateReport } from "./evaluator.js";

export async function sendResultsToN8n(session) {
  const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
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
