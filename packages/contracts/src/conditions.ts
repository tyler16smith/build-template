import { z } from "zod";

/**
 * The value and condition vocabulary of automation definitions: trigger filters, If steps and
 * run-if conditions. It has no other contract imports so `actions.ts` can use it too.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(20_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema).max(200),
    z.record(z.string().max(80), jsonValueSchema),
  ]),
);

/**
 * `trigger.data.stage`, `steps.create_card.output.id`, `run.startedAt`, and inside a For each
 * step `loop.item.email` and `loop.index`.
 */
export const referencePathSchema = z
  .string()
  .max(300)
  .regex(
    /^(trigger|run|loop|steps\.[a-z][a-z0-9_]*)(\.[A-Za-z0-9_-]+)*$/,
    "paths start with trigger, run, loop or steps.<step id>",
  );

export const CONDITION_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "in",
  "exists",
  "notExists",
  "gt",
  "gte",
  "lt",
  "lte",
  "matches",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const conditionSchema = z.strictObject({
  path: referencePathSchema,
  op: z.enum(CONDITION_OPERATORS),
  value: jsonValueSchema.optional(),
});
export type Condition = z.infer<typeof conditionSchema>;
