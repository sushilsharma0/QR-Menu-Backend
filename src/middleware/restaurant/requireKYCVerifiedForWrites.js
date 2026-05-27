/**
 * Backwards-compatible middleware for routes that used to be KYC-gated.
 *
 * Restaurant access is now controlled by subscription/trial feature flags that
 * the platform admin can configure. KYC remains a reminder/compliance workflow,
 * but it no longer blocks restaurant actions by itself.
 */
const requireKYCVerifiedForWrites = (req, res, next) => {
  next();
};

module.exports = requireKYCVerifiedForWrites;
