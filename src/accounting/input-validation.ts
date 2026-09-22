import { z } from 'zod';

/** 書式だけでなく、2月30日などの存在しない日付も拒否する。 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const text = z.string().trim().min(1);
const sourceType = z.enum([
  'moneyforward_cloud_invoice', 'expense_reimbursement', 'vendor_invoice_email',
]);
const ruleSide = z.object({
  account: text.max(30),
  subAccount: text.max(30).optional(),
  department: text.max(20).optional(),
  counterparty: text.max(255).optional(),
  taxCategory: text.optional(),
  invoiceClassification: text.optional(),
}).strict();

/** 外部の設定ファイルを、型キャストではなく実行時に検証する。 */
export const accountingRuleSetSchema = z.object({
  version: text,
  requireEvidence: z.boolean(),
  requireDepartment: z.boolean(),
  rules: z.array(z.object({
    id: text,
    enabled: z.boolean(),
    priority: z.number().int().nonnegative().safe(),
    when: z.object({
      sourceTypes: z.array(sourceType).nonempty(),
      category: text.optional(),
      counterparty: text.optional(),
      descriptionIncludes: z.array(text).nonempty().optional(),
      departmentHint: text.optional(),
    }).strict(),
    debit: ruleSide,
    credit: ruleSide,
    tags: z.array(text).optional(),
  }).strict()),
}).strict().superRefine((config, context) => {
  const ids = new Set<string>();
  config.rules.forEach((rule, index) => {
    const fail = (message: string) => context.addIssue({
      code: 'custom', path: ['rules', index], message,
    });
    if (ids.has(rule.id)) fail(`ルールIDが重複しています: ${rule.id}`);
    ids.add(rule.id);
    if (!rule.enabled) return;
    if (JSON.stringify(rule).includes('__')) fail('有効なルールに未設定のプレースホルダーがあります');
    if (!rule.debit.taxCategory || !rule.credit.taxCategory) {
      fail('有効なルールには借方・貸方それぞれの税区分を指定してください');
    }
    if (config.requireDepartment && !rule.debit.department && !rule.credit.department) {
      fail('有効なルールには部門を指定してください');
    }
  });
});

export const receiptSchema = z.object({
  uri: text.url().refine((uri) => ['https:', 'gs:', 's3:'].includes(new URL(uri).protocol),
    '証憑URIはhttps・gs・s3形式にしてください'),
  sha256: text.regex(/^[a-fA-F0-9]{64}$/, 'SHA-256は64桁の16進数です')
    .transform((hash) => hash.toLowerCase()).optional(),
  documentType: z.literal('receipt'),
}).strict();

export const expenseRecordSchema = z.object({
  fileId: text.regex(/^[a-zA-Z0-9_-]+$/),
  lineId: text.default('1'),
  fileName: text.optional(),
  personFolderId: text.optional(),
  personFolderName: text.optional(),
  monthFolderId: text.optional(),
  employee: z.object({
    id: text,
    name: text,
    accountingCounterparty: text.max(255).optional(),
  }).strict().optional(),
  transactionDate: text.refine(isCalendarDate, '存在する日付をYYYY-MM-DD形式で指定してください').optional(),
  amount: z.number().int().positive().safe().optional(),
  category: text.optional(),
  merchant: text.max(255).optional(),
  description: text.max(200).optional(),
  department: text.max(20).optional(),
  evidence: z.array(receiptSchema),
}).strict();

export const expenseBatchSchema = z.object({
  organizationId: text,
  sourceSystem: z.literal('google_drive'),
  rootFolderId: text.optional(),
  targetMonth: text.regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/),
  currency: z.literal('JPY'),
  scanNotices: z.array(z.object({ code: text, fileId: text, message: text }).strict()).default([]),
  records: z.array(z.unknown()).max(10000),
}).strict();

export type ExpenseRecord = z.infer<typeof expenseRecordSchema>;
