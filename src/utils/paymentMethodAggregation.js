const ONLINE_ALIASES = [
  'online',
  'upi',
  'card',
  'wallet',
  'esewa',
  'khalti',
  'fonepay',
  'bank_transfer',
  'bank',
];

/**
 * Mongo aggregation expression: map legacy digital methods to `online`, empty/null to `cash`,
 * otherwise keep the original method (e.g. credit, mixed).
 * @param {string} inputExpr - field reference e.g. '$paymentMethod'
 */
function paymentMethodBucketExpr(inputExpr = '$paymentMethod') {
  return {
    $let: {
      vars: { pm: { $toLower: { $ifNull: [inputExpr, ''] } } },
      in: {
        $switch: {
          branches: [
            { case: { $in: ['$$pm', ['', 'cash']] }, then: 'cash' },
            { case: { $in: ['$$pm', ONLINE_ALIASES] }, then: 'online' },
          ],
          default: { $ifNull: [inputExpr, 'other'] },
        },
      },
    },
  };
}

/** $addFields stage placing the bucket on `outField` (default _paymentMethodBucket). */
function addFieldsPaymentMethodBucket(sourceField = '$paymentMethod', outField = '_paymentMethodBucket') {
  return {
    $addFields: {
      [outField]: paymentMethodBucketExpr(sourceField),
    },
  };
}

module.exports = { paymentMethodBucketExpr, addFieldsPaymentMethodBucket };
