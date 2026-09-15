import { z } from "zod";
import { STATUSES } from "./types";
export const estimateSchema = z
  .object({
    kind: z.enum(["date", "date_range", "window", "point", "deadline"]),
    start: z.string().min(10).max(40),
    end: z.string().max(40).nullable(),
    timeZone: z.string().max(80),
    label: z.string().max(300).nullable(),
  })
  .strict();
export const itemSchema = z
  .object({
    name: z.string().min(1).max(500),
    quantity: z.number().int().min(1).max(10000),
    imageUrl: z.string().max(2000).nullable(),
  })
  .strict();
export const manualSchema = z
  .object({
    merchant: z.string().trim().min(1).max(160),
    orderNumber: z.string().trim().max(200).nullable(),
    orderedAt: z.iso.date().nullable(),
    items: z.array(itemSchema).min(1).max(100),
    carrier: z.string().trim().max(80).nullable(),
    trackingNumber: z.string().trim().max(200).nullable(),
    trackingUrl: z.string().max(2000).nullable(),
    status: z.enum(STATUSES),
    shippedAt: z.iso.datetime({ offset: true }).nullable(),
    estimate: estimateSchema.nullable(),
    deliveredAt: z.iso.datetime({ offset: true }).nullable(),
    manualOverride: z.boolean().optional(),
  })
  .strict();
export const extractionSchema = z
  .object({
    relevant: z.boolean(),
    reviewReason: z.string().nullable(),
    orders: z.array(
      z
        .object({
          merchant: z.string().nullable(),
          orderNumber: z.string().nullable(),
          orderedAt: z.string().nullable(),
          items: z.array(itemSchema),
          shipments: z.array(
            z
              .object({
                items: z.array(itemSchema),
                carrier: z.string().nullable(),
                trackingNumber: z.string().nullable(),
                trackingUrl: z.string().nullable(),
                status: z.enum(STATUSES),
                shippedAt: z.string().nullable(),
                statusAt: z.string().nullable(),
                estimate: estimateSchema.nullable(),
                deliveredAt: z.string().nullable(),
                evidence: z.string(),
                needsReview: z.boolean(),
                reviewReason: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type Extracted = z.infer<typeof extractionSchema>;
