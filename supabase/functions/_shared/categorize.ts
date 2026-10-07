import Anthropic from "npm:@anthropic-ai/sdk";
import { env } from "./utils.ts";
import { TAX_GUIDANCE, TAX_LINE_CODES, USE_TYPES } from "./tax.ts";

export interface ItemToCategorize {
  id: string;
  description: string;
  merchant: string | null;
  category: string | null;
  total: number | null;
}

export interface ItemCategory {
  id: string;
  tax_line: string;
  use_type: "business" | "personal" | "mixed";
  tax_confidence: number;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "tax_line", "use_type", "tax_confidence"],
        properties: {
          id: { type: "string" },
          tax_line: { type: "string", enum: TAX_LINE_CODES },
          use_type: { type: "string", enum: [...USE_TYPES] },
          tax_confidence: { type: "number" },
        },
      },
    },
  },
};

let client: Anthropic | null = null;

/** Assigns a Schedule C line and business/personal flag to already-captured line items. */
export async function categorizeItems(
  items: ItemToCategorize[],
  businessDescription: string | null,
): Promise<ItemCategory[]> {
  if (!items.length) return [];
  client ??= new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  const response = await client.beta.messages.create({
    model: Deno.env.get("CLAUDE_MODEL") || "claude-opus-5-5",
    max_tokens: 16000,
    system: `You categorize purchased items for a US small-business expense ledger.\n\n${TAX_GUIDANCE}\n\nReturn one entry per input item, with the same id.`,
    betas: ["server-side-fallback-2026-07-01"],
    // deno-lint-ignore no-explicit-any
    fallbacks: "default" as any,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{
      role: "user",
      content: [
        businessDescription ? `User's business: ${businessDescription}` : "User's business: (not described)",
        "",
        "Items (JSON):",
        JSON.stringify(items),
      ].join("\n"),
    }],
  });

  if (response.stop_reason === "refusal") throw new Error("Categorization was declined by the model.");
  if (response.stop_reason === "max_tokens") throw new Error("Categorization output was cut off.");
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("Categorization returned no output.");
  const ids = new Set(items.map((i) => i.id));
  return (JSON.parse(block.text).items as ItemCategory[]).filter((c) => ids.has(c.id));
}
