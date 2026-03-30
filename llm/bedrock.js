// AWS Bedrock Claude Integration

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-5-sonnet-20241022-v2:0";

let bedrockClient = null;

export async function getBedrockClient() {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });
  }
  return bedrockClient;
}

export async function callBedrock(messages, systemPrompt, maxTokens = 500) {
  const client = await getBedrockClient();

  // Bedrock requires first message to be user role
  let processedMessages = messages;
  if (messages.length > 0 && messages[0].role === "assistant") {
    processedMessages = [
      { role: "user", content: "(Interview started)" },
      ...messages,
    ];
  }

  const payload = {
    model_id: BEDROCK_MODEL_ID,
    messages: processedMessages,
    system: systemPrompt || "",
    max_tokens: maxTokens,
    temperature: 0.7,
  };

  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    body: JSON.stringify(payload),
  });

  try {
    const response = await client.send(command);
    const bodyStr = new TextDecoder().decode(response.body);
    const bodyObj = JSON.parse(bodyStr);

    const tokenCount = bodyObj.usage?.input_tokens + bodyObj.usage?.output_tokens || "?";
    console.log(`[Bedrock] ${tokenCount} tokens`);

    return bodyObj.content?.[0]?.text || "";
  } catch (err) {
    throw new Error(`Bedrock ${err.message}`);
  }
}
