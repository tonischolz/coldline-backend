import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, runTool } from "./tools.js";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env automatically

function buildSystemPrompt(clientConfig) {
  return `You are the ordering assistant for ${clientConfig.businessName}, a ${clientConfig.businessType.replace("_", " ")} business.

Hours: ${clientConfig.hours}
Delivery area: ${clientConfig.deliveryZone}
Products: ${clientConfig.products.map((p) => `${p.name} (${p.unit})`).join(", ")}
Minimum order: ${clientConfig.minimumOrder}

${clientConfig.systemPromptExtra || ""}

Your job is ONLY to help customers place, modify, or cancel delivery orders. Rules:
- Always collect: product, quantity, delivery address, phone number, and date before booking.
- Always ask whether this is a one-time order or a recurring/standing order.
- Before confirming any order, call check_capacity for the requested date.
- If capacity is unavailable, offer the nearest available-sounding alternative and ask the customer to confirm a new date - do not guess an actual open date, just ask them to pick another.
- Never invent pricing - if asked about price, say a team member will confirm pricing, and continue collecting order details.
- Keep responses short and conversational - this is a chat interface, not an email.
- If the customer asks anything unrelated to placing/managing an order, politely say you can only help with orders and a team member will follow up on anything else.`;
}

/**
 * Runs one turn of the conversation: sends the message history to Claude,
 * executes any tool calls Claude makes, and returns Claude's final reply.
 *
 * conversation: array of { role: "user" | "assistant", content: ... }
 * clientConfig: parsed JSON from /clients/<id>.json
 */
export async function runConversationTurn(conversation, clientConfig) {
  const messages = [...conversation];

  // Loop in case Claude needs to call a tool and then respond to the result.
  // Capped at 5 iterations so a bug can't spin forever and rack up API cost.
  for (let i = 0; i < 5; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: buildSystemPrompt(clientConfig),
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      // No tool call - this is Claude's actual reply to show the customer.
      const textBlock = response.content.find((b) => b.type === "text");
      return {
        reply: textBlock ? textBlock.text : "",
        updatedConversation: messages,
      };
    }

    // Execute each requested tool call and feed the results back to Claude.
    const toolResults = toolUseBlocks.map((block) => {
      const result = runTool(clientConfig, block.name, block.input);
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      };
    });

    messages.push({ role: "user", content: toolResults });
    // loop continues - Claude now sees the tool result and responds
  }

  return {
    reply: "Something took longer than expected - a team member will follow up shortly.",
    updatedConversation: messages,
  };
}
