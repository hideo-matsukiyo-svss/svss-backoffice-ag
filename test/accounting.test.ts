import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountingIdempotencyKey } from '../src/accounting/idempotency.js';
import { checkMfCloudInvoiceLinkage } from '../src/accounting/mf-cloud-invoice.js';
import { MF_JOURNAL_HEADERS, toMoneyForwardJournalCsv } from '../src/accounting/mf-journal-csv.js';
import type { JournalCandidate } from '../src/accounting/types.js';

test('冪等キーは入力が同じなら同一で、明細番号が違えば変わる', () => {
  const base = {
    sourceType: 'vendor_invoice_email' as const,
    sourceId: 'mail-123',
    fiscalPeriod: '2026-09',
    documentSha256: 'ABCDEF',
  };
  assert.equal(
    createAccountingIdempotencyKey({ ...base, lineNumber: 1 }),
    createAccountingIdempotencyKey({ ...base, lineNumber: 1 }),
  );
  assert.notEqual(
    createAccountingIdempotencyKey({ ...base, lineNumber: 1 }),
    createAccountingIdempotencyKey({ ...base, lineNumber: 2 }),
  );
});

test('MFクラウド請求書の標準連携を検査できる', () => {
  const result = checkMfCloudInvoiceLinkage(
    {
      invoiceId: 'inv-1', invoiceNumber: '2026-001', issueDate: '2026-09-01',
      journalDate: '2026-09-01', totalAmount: 110000, linkageStatus: 'posted',
      debitAccount: '売掛金', creditAccount: '売上高', department: '営業',
      taxCategory: '課売 10%',
    },
    {
      expectedDebitAccount: '売掛金', expectedCreditAccount: '売上高',
      expectedDepartment: '営業', expectedTaxCategory: '課売 10%',
    },
  );
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('承認済みの受領請求書をMF仕訳帳CSVへ変換する', () => {
  const candidate: JournalCandidate = {
    idempotencyKey: 'acct_1', sourceType: 'vendor_invoice_email', sourceId: 'mail-1',
    lineNumber: 1, fiscalPeriod: '2026-09', transactionDate: '2026-09-15',
    debit: { account: '外注費', taxCategory: '課仕 10%', amount: 110000 },
    credit: { account: '未払金', counterparty: '取引先A', amount: 110000 },
    description: '9月分,業務委託費', memo: 'acct_1', tags: ['自動化', '要証憑'],
    evidence: [{ uri: 'gs://evidence/invoice.pdf', documentType: 'invoice' }],
    approvalStatus: 'approved',
  };
  const csv = toMoneyForwardJournalCsv([candidate], 100);
  assert.equal(csv.split('\r\n')[0], MF_JOURNAL_HEADERS.join(','));
  assert.match(csv, /100,2026\/09\/15,外注費/);
  assert.match(csv, /"9月分,業務委託費"/);
});

test('売上はCSVへ重複出力しない', () => {
  const candidate = {
    idempotencyKey: 'acct_sales', sourceType: 'moneyforward_cloud_invoice',
    sourceId: 'inv-1', lineNumber: 1, fiscalPeriod: '2026-09',
    transactionDate: '2026-09-15',
    debit: { account: '売掛金', amount: 110000 },
    credit: { account: '売上高', amount: 110000 },
    description: '売上', evidence: [], approvalStatus: 'approved',
  } satisfies JournalCandidate;
  assert.throws(() => toMoneyForwardJournalCsv([candidate]), /標準連携/);
});

