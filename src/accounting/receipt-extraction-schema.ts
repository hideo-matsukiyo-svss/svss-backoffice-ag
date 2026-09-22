import { z } from 'zod';

const text = z.string().trim().min(1);
const observed = <T extends z.ZodTypeAny>(value: T) => z.object({
  value: value.nullable(),
  quote: text.max(500).nullable(),
  page: z.number().int().positive().max(10000).nullable(),
}).strict();

/** AI出力は確定値ではなく観測候補。空欄・読取不能はnullのまま保持する。 */
export const receiptObservationSchema = z.object({
  documentType: z.enum(['receipt', 'invoice', 'order', 'other', 'unknown']),
  documentCount: z.number().int().nonnegative().max(1000),
  transactionDate: observed(text.max(30)),
  amount: observed(z.number().finite()),
  currency: observed(text.max(10)),
  merchant: observed(text.max(255)),
  paymentStatus: z.enum(['paid', 'unpaid', 'unknown']),
  warnings: z.array(text.max(500)).max(20),
}).strict();
export type ReceiptObservation = z.infer<typeof receiptObservationSchema>;

export const receiptExtractionSchema = z.object({
  status: z.literal('needs_review'),
  provider: z.literal('openai'),
  model: text.max(100),
  promptVersion: z.literal('receipt-v1'),
  sha256: text.regex(/^[a-f0-9]{64}$/).optional(),
  observation: receiptObservationSchema.optional(),
  issues: z.array(z.object({ code: text, message: text }).strict()).min(1),
}).strict();
export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema>;

const field = (type: string) => ({
  type: 'object', additionalProperties: false,
  properties: { value: { type: [type, 'null'] }, quote: { type: ['string', 'null'] }, page: { type: ['integer', 'null'] } },
  required: ['value', 'quote', 'page'],
});
export const receiptJsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    documentType: { type: 'string', enum: ['receipt', 'invoice', 'order', 'other', 'unknown'] },
    documentCount: { type: 'integer' },
    transactionDate: field('string'), amount: field('number'), currency: field('string'), merchant: field('string'),
    paymentStatus: { type: 'string', enum: ['paid', 'unpaid', 'unknown'] },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['documentType', 'documentCount', 'transactionDate', 'amount', 'currency', 'merchant', 'paymentStatus', 'warnings'],
};
