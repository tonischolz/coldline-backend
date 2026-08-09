import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, runTool } from "./tools.js";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env automatically

function buildSystemPrompt(clientConfig) {
  const productList = clientConfig.products
    .map((p) => `${p.name} (${p.weightLbs} lb)`)
    .join(", ");

  const equipmentList = (clientConfig.equipment || [])
    .map((e) => {
      const priceText = e.price != null ? `$${e.price}` : "price confirmed by a team member";
      const minText = e.minBags ? `, ${e.minBags}-bag minimum` : "";
      const durationText = e.rentalDays
        ? `, ${e.rentalDays}-day/weekend rental`
        : ", event duration set by the customer (ask for both drop-off and pickup dates)";
      return `  - ${e.label}: up to ${e.capacityBags} large bags${minText}, ${priceText}${durationText}, needs ${e.leadTimeDays}+ days notice (${e.units} in inventory)`;
    })
    .join("\n");

  return `You are the ordering assistant for ${clientConfig.businessName}, a ${clientConfig.businessType.replace("_", " ")} business.
Hours: ${clientConfig.hours}
Shop phone (for urgent needs or anything you can't help with): ${clientConfig.phone}
Delivery area: ${clientConfig.deliveryZone}
Bag types: ${productList}
${clientConfig.systemPromptExtra || ""}

Your job is ONLY to help customers place, modify, or cancel orders. Start by finding out which of the two kinds of order this is - ask "How may we help you today - standard ice delivery, or a special event?" if it isn't already obvious.

STANDARD DELIVERY (individual bags, nothing left on-site):
- Minimum ${clientConfig.standardMinimumBags} bags per order.
- Needs at least ${clientConfig.standardLeadTimeHours} hours notice. Occasional urgent/last-minute requests can sometimes be accommodated - if sooner is needed, say you'll flag it as urgent and a team member will confirm by phone; don't promise it yourself.
- Collect: bag size (large 16 lb or small 7 lb), quantity, delivery address, phone number, and date.
- Always ask whether this is a one-time order or a recurring/standing order.
- Before confirming, call check_capacity with the date, quantity, and product.
- If check_capacity returns quantityUnclear: true, ask which bag size they mean.
- If capacity is unavailable, ask the customer to pick a different date - never guess an actual open date.
- Call create_order (one-time) or create_recurring_order (standing) once everything is confirmed.

SPECIAL EVENT (equipment stays on-site for the event, then gets picked up):
${equipmentList}
- Ask which equipment fits their event and how many bags they need, then the drop-off date (and pickup date for freezer trucks - box rentals default to a 2-day/weekend window).
- Before confirming, call check_equipment_availability with the equipment, dates, and bag quantity.
- If fitsCapacity is false, tell them that option can't hold that much and suggest the next size up.
- If meetsMinimum is false, let them know the minimum bag count for that equipment.
- If leadTimeOk is false, let them know that equipment needs more advance notice and ask if their date can move, or flag it for a team member to confirm.
- If unitAvailable or dailyPoolAvailable is false, ask the customer to consider a different date.
- Call create_event_order once everything is confirmed.

General rules:
- Never invent pricing - if a price isn't given to you directly (e.g. "price confirmed by a team member"), say a team member will confirm pricing and continue.
- Keep responses short and conversational - this is a chat interface, not an email.
- If asked about anything unrelated to placing/managing an order, politely say you can only help with orders and a team member will follow up on anything else.`;
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
    // runTool is async (create_order/create_event_order kick off a real
    // Invoice Ninja API call), so these run concurrently and we wait for
    // all of them before continuing.
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const result = await runTool(clientConfig, block.name, block.input);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      })
    );

    messages.push({ role: "user", content: toolResults });
    // loop continues - Claude now sees the tool result and responds
  }

  return {
    reply: "Something took longer than expected - a team member will follow up shortly.",
    updatedConversation: messages,
  };
}
