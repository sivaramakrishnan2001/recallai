// OpenAI GPT-4o Integration

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function callOpenAI(messages, systemPrompt, maxTokens = 500) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const payload = {
    model:       OPENAI_MODEL,
    max_tokens:  maxTokens,
    temperature: 0.7,
    messages: systemPrompt
      ? [{ role: "system", content: systemPrompt }, ...messages]
      : messages,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI ${response.status}: ${err.substring(0, 200)}`);
  }

  const json = await response.json();
  console.log(`[OpenAI] ${json.usage?.total_tokens ?? "?"} tokens`);
  return json.choices?.[0]?.message?.content || "";
}
